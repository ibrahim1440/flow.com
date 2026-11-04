import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { seesAllSales, customerVisibilityWhere } from "@/lib/services/sales/scope";
import { quotesSeeAll } from "@/lib/services/sales/quote-access";

/**
 * GET /api/sales/journey — the four counts of «مسار العميل» (owner-approved Figma page 10, 4 Nov 2026): the strip on
 * top of «العملاء المحتملون», «العيّنات», «عروض الأسعار» and «العملاء». Each count is scoped exactly as its own list
 * is, so the strip never shows a number the page behind it would not:
 *   · leads    — open leads (NEW, CONTACTED, QUALIFIED); own unless `lead_assign` (GET /api/sales/leads);
 *   · samples  — not yet answered (no feedback, not cancelled); through the deal's owner unless all-sales;
 *   · quotes   — open: drafts, issued, and accepted ones not yet turned into an order; own unless quotesSeeAll;
 *   · customers — the viewer's book (customerVisibilityWhere); a count of 0 for a viewer without the module.
 */
export async function GET() {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  const p = user.permissions;
  const leadOwn = hasSubPrivilege(p, "sales", "lead_assign") ? {} : { ownerId: user.id };
  const dealOwn = seesAllSales(p) ? {} : { opportunity: { ownerId: user.id } };
  const quoteOwn = quotesSeeAll(p) ? {} : { opportunity: { ownerId: user.id } };
  const seesCustomers = hasModuleAccess(p, "customers");

  const [leads, samples, quotes, customers] = await Promise.all([
    prisma.lead.count({ where: { ...leadOwn, status: { in: ["NEW", "CONTACTED", "QUALIFIED"] } } }),
    prisma.sampleShipment.count({ where: { ...dealOwn, status: { in: ["REQUESTED", "PREPARING", "SENT"] } } }),
    prisma.quote.count({
      where: {
        ...quoteOwn,
        OR: [{ status: { in: ["DRAFT", "ISSUED"] } }, { status: "ACCEPTED", orderLinks: { none: {} } }],
      },
    }),
    seesCustomers ? prisma.customer.count({ where: customerVisibilityWhere(user) }) : Promise.resolve(0),
  ]);
  return NextResponse.json({ leads, samples, quotes, customers, scope: seesAllSales(p) ? "all" : "own" });
}
