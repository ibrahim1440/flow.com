import { NextResponse } from "@/lib/api-response";
import { phoneSearchKey } from "@/lib/contact/phone";
import { prisma } from "@/lib/db";
import { requireQuoteWrite } from "@/lib/services/sales/quote-guard";
import { canQuoteWithoutDeal, quotesSeeAll } from "@/lib/services/sales/quote-access";
import { handleDomainError } from "@/lib/api-error";
import { canEdit, hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { customersScopedToOwner, ownedCustomerWhere } from "@/lib/services/sales/scope";

/**
 * GET /api/sales/quotes/picker?q=… — the «+ عرض سعر» picker of the quotations list
 * (Figma 181:1609): choose a customer, then one of its OPEN deals (or open one through
 * POST /api/customers/[id]/deals, whose rules are unchanged), then the existing editor.
 *
 * sales › quote_write, as raising a quotation. Which customers are offered — the SAME scope as the
 * customers list (services/sales/scope.ts), never wider:
 *   · a scoped rep (sales without lead_assign and without a whole-queue duty): their own book
 *     (`ownedCustomerWhere`: the accounts they are responsible for, the customers they hold a deal
 *     on, their past orders' customers) — plus, explicitly, any customer they own an OPEN deal on,
 *     so an unassigned customer with their deal stays reachable. Holding the customers module does
 *     NOT widen this: the «مندوب مبيعات» account has customers=view and used to be shown every
 *     customer here while its customers list was correctly narrowed (production leak, 4 Nov 2026).
 *   · the all-sales view (lead_assign) or the accounting module (`quotesSeeAll`), and «مسار
 *     المحاسب» (`canQuoteWithoutDeal`): every customer, as before.
 *   · an unscoped caller without the customers module (an operations duty next to sales): only
 *     customers on a deal they own — as before.
 * Deals: OPEN only, scoped exactly as the quotation routes scope them.
 */
export async function GET(request: Request) {
  const { user, error } = await requireQuoteWrite();
  if (error) return error;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  // The phone search reads «٠٥٥…» as «055…» (Arabic-Indic and Persian digits).
  const qDigits = q.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/[\s-]/g, "");
  const customerId = url.searchParams.get("customerId");

  const scopeAll = quotesSeeAll(user.permissions);
  // «مسار المحاسب»: the accounting section quotes any customer directly (no deal), so it is offered every customer.
  const noDeal = canQuoteWithoutDeal(user.permissions);
  const hasCustomers = hasModuleAccess(user.permissions, "customers") || noDeal;
  const dealScope = scopeAll ? {} : { ownerId: user.id };
  const customerScope = scopeAll || noDeal ? {}
    : customersScopedToOwner(user) ? { OR: [ownedCustomerWhere(user.id), { opportunities: { some: { ownerId: user.id, outcome: "OPEN" as const } } }] }
    : hasCustomers ? {} : { opportunities: { some: dealScope } };

  try {
    const nameMatch = q
      ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { nameAr: { contains: q, mode: "insensitive" as const } }, ...(phoneSearchKey(qDigits) ? [{ phone: { contains: phoneSearchKey(qDigits)! } }, { phone: { contains: q } }] : [])] }
      : {};
    const customers = await prisma.customer.findMany({
      // AND, not a spread: the name match and the scope are both top-level `OR`s, and a spread would let the scope
      // overwrite the search (gate M1: a scoped rep could not search their book past the first 20).
      where: {
        ...(customerId ? { id: customerId } : {}),
        AND: [nameMatch, customerScope],
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
        createDeal: hasSubPrivilege(user.permissions, "sales", "lead_convert") && hasModuleAccess(user.permissions, "customers"),
        // A quotation with no deal (accounting › quotes_issue).
        noDeal,
        // «عميل جديد» in the picker (5 Nov 2026): the rules of POST /api/customers — customers › edit, or a rep who
        // registers their own customer (lead_write / lead_convert).
        createCustomer: canEdit(user.permissions, "customers") || hasSubPrivilege(user.permissions, "sales", "lead_write") || hasSubPrivilege(user.permissions, "sales", "lead_convert"),
      },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
