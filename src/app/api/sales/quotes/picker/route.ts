import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireQuoteWrite } from "@/lib/services/sales/quote-guard";
import { quotesSeeAll } from "@/lib/services/sales/quote-access";
import { handleDomainError } from "@/lib/api-error";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";

/**
 * GET /api/sales/quotes/picker?q=… — the «+ عرض سعر» picker of the quotations list
 * (Figma 181:1609): choose a customer, then one of its OPEN deals (or open one through
 * POST /api/customers/[id]/deals, whose rules are unchanged), then the existing editor.
 *
 * sales › quote_write, as raising a quotation. Which customers are offered:
 *   · a caller with the customers module: any customer whose name matches (as the customers list);
 *   · otherwise: only customers on a deal the caller can already see (their own, or all with
 *     the all-sales view) — the picker shows no customer the caller could not reach already.
 * Deals: OPEN only, scoped exactly as the quotation routes scope them.
 */
export async function GET(request: Request) {
  const { user, error } = await requireQuoteWrite();
  if (error) return error;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const customerId = url.searchParams.get("customerId");

  const scopeAll = quotesSeeAll(user.permissions);
  const hasCustomers = hasModuleAccess(user.permissions, "customers");
  const dealScope = scopeAll ? {} : { ownerId: user.id };

  try {
    const nameMatch = q
      ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { nameAr: { contains: q, mode: "insensitive" as const } }] }
      : {};
    const customers = await prisma.customer.findMany({
      where: {
        ...(customerId ? { id: customerId } : {}),
        ...nameMatch,
        ...(hasCustomers ? {} : { opportunities: { some: dealScope } }),
      },
      orderBy: { name: "asc" },
      take: 20,
      select: {
        id: true, name: true, nameAr: true, city: true,
        opportunities: {
          where: { outcome: "OPEN", ...dealScope },
          orderBy: { updatedAt: "desc" },
          take: 10,
          select: {
            id: true, title: true, updatedAt: true,
            owner: { select: { id: true, name: true } },
            stage: { select: { nameAr: true, nameEn: true } },
            _count: { select: { quotes: true } },
          },
        },
      },
    });

    return NextResponse.json({
      customers: customers.map(({ opportunities, ...c }) => ({ ...c, deals: opportunities })),
      can: {
        // Opening a deal for an existing customer: the rules of POST /api/customers/[id]/deals.
        createDeal: hasSubPrivilege(user.permissions, "sales", "lead_convert") && hasCustomers,
      },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
