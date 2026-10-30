import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { seesAllSales } from "@/lib/services/sales/scope";
import { creditView } from "@/lib/services/customers/credit-db";
import { checkCreditStandingLater } from "@/lib/notifications/credit-watch";
import { customerInScope } from "@/lib/services/sales/customer-access";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/customers/[id]/credit — the customer's credit warning, grace and sales hold
 * (feat/credit-hold): what the customer file, the quotation dialog and the order dialogs show.
 *
 * Everyone who can see the customer by name sees the warning — the customers, orders or sales
 * module — because the warning is about the customer, not about the viewer's deals. The amounts
 * (limit, outstanding, over, overdue) only for a viewer who already sees every deal (sales ›
 * lead_assign), as the account page's credit usage. A hold whose automatic ending has come is
 * lifted here, on read (services/customers/credit-db.ts) — no job.
 */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireAnyModule("customers", "orders", "sales");
  if (error) return error;
  const { id } = await params;
  // A scoped sales rep reaches only the customers in their own book (services/sales/scope.ts) — 404 otherwise.
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const p = user.permissions;
  try {
    const view = await prisma.$transaction((tx) => creditView(tx, id, {
      all: hasModuleAccess(p, "sales") && seesAllSales(p),
      canHold: hasSubPrivilege(p, "customers", "sales_hold"),
      now: new Date(),
    }));
    if (!view) return NextResponse.json({ error: "العميل غير موجود.", errorEn: "Not found" }, { status: 404 });
    // feat/notifications: a standing that changed since it was last notified is notified (once), after the response.
    checkCreditStandingLater([id]);
    return NextResponse.json(view);
  } catch (err) {
    return handleDomainError(err);
  }
}
