import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { orderInScope } from "@/lib/services/sales/customer-access";
import { seesAllSales } from "@/lib/services/sales/scope";
import { linkDirectOrderDeal, mayLinkOrderDeal, receiptsOnOrder } from "@/lib/services/sales/direct-order-deal";

type Params = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "الطلب غير موجود.", errorEn: "Order not found.", code: "NOT_FOUND" }, { status: 404 });

/**
 * «اربط بصفقة» (owner, option A): an order with no deal — placed before «طلب مباشر», or by a door that opens none — is
 * linked to one of the customer's OPEN / WON deals in the caller's scope, or to «صفقة جديدة تلقائية» (the rule of
 * services/sales/direct-order-deal.ts). Who: the order's owner, a supervisor (sales › lead_assign) or the admin (whose
 * template holds lead_assign) — never by role name. Audited (HrAuditLog DIRECT_ORDER_DEAL_*, the order's timeline).
 *
 * GET  → { linked: { id, title, outcome } | null, can: { link }, deals: [{ id, title, outcome, owner, updatedAt }], receipts: "0.00" }
 * POST { opportunityId: string | null } → 201 { opportunityId, created }; 409 ALREADY_LINKED; 404 outside the scope.
 */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!hasModuleAccess(user.permissions, "orders")) return forbidden();
  const { id } = await params;
  try {
    if (!(await orderInScope(user, id))) return notFound();
    const order = await prisma.order.findUnique({
      where: { id },
      select: { id: true, ownerId: true, customerId: true, opportunityLinks: { take: 1, orderBy: { createdAt: "asc" }, select: { opportunity: { select: { id: true, title: true, outcome: true } } } } },
    });
    if (!order) return notFound();
    const linked = order.opportunityLinks[0]?.opportunity ?? null;
    const can = !linked && mayLinkOrderDeal(user, order) && hasModuleAccess(user.permissions, "sales");
    const deals = can
      ? await prisma.opportunity.findMany({
          where: { customerId: order.customerId, outcome: { in: ["OPEN", "WON"] }, ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }) },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 20,
          select: { id: true, title: true, outcome: true, updatedAt: true, owner: { select: { id: true, name: true } }, stage: { select: { nameAr: true, nameEn: true } } },
        })
      : [];
    // The accountant's receipts already on this order's invoices (gate H1 deploy note: the live #1, #2, #5): they are
    // subtracted from what Sales may collect on the deal once linked — said in the dialog before linking.
    const receipts = can ? await receiptsOnOrder(prisma, id) : "0.00";
    return NextResponse.json({ linked, can: { link: can }, deals, receipts });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!hasModuleAccess(user.permissions, "orders") || !hasModuleAccess(user.permissions, "sales")) return forbidden();
  const { id } = await params;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const raw = (body ?? {}) as { opportunityId?: unknown };
  if (!(raw.opportunityId === null || raw.opportunityId === undefined || (typeof raw.opportunityId === "string" && raw.opportunityId.trim()))) {
    return NextResponse.json({ error: "اختر صفقة، أو «صفقة جديدة تلقائية».", errorEn: "opportunityId: a deal id, or null for a new deal.", code: "BAD_INPUT" }, { status: 400 });
  }
  const chosen = typeof raw.opportunityId === "string" ? raw.opportunityId.trim() : null;
  try {
    if (!(await orderInScope(user, id))) return notFound();
    const head = await prisma.order.findUnique({ where: { id }, select: { ownerId: true } });
    if (!head) return notFound();
    if (!mayLinkOrderDeal(user, head)) {
      return NextResponse.json({ error: "ربط الطلب بصفقة لصاحب الطلب أو المشرف أو المدير.", errorEn: "Only the order's owner, a supervisor or the admin links an order to a deal.", code: "FORBIDDEN" }, { status: 403 });
    }
    const r = await prisma.$transaction((tx) => linkDirectOrderDeal(tx, { orderId: id, actor: { id: user.id, name: user.name, permissions: user.permissions }, chosenOpportunityId: chosen, mode: "link" }), TX_OPTS);
    return NextResponse.json({ opportunityId: r.opportunityId, created: r.created, gross: r.gross, tax: r.tax }, { status: 201 });
  } catch (err) {
    const e = err as { _appCode?: number; code?: string; error?: string; errorEn?: string };
    if (e?._appCode && e.code) return NextResponse.json({ error: e.error, errorEn: e.errorEn, code: e.code }, { status: e._appCode });
    return handleDomainError(err);
  }
}
