import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { privilegedGate, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest, setAuditContext } from "@/lib/accounting/audit";
import { releaseRejectedHold } from "@/lib/services/orders/payment-hold";
import { autoPrepareOrder } from "@/lib/services/orders/preparation";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/orders/[id]/payment-hold — «كمّل الطلب» after «رُفض الإيصال» (owner decision أ). The order's rep, or a holder
 * of customers › sales_hold, continues a held direct sale whose collection was rejected: it passes only through the normal
 * credit check — the customer within the limit, or the rep's approved DIRECT_SALE override (consumed). 409 CREDIT_LIMIT
 * otherwise. On success the order goes to preparation.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { id } = await params;
  // Not the order's rep: the supervisor's key (customers › sales_hold) — its action-time gate, as every privileged key.
  const owner = await prisma.order.findUnique({ where: { id }, select: { ownerId: true } });
  if (owner && owner.ownerId !== user.id) { const refused = await privilegedGate(user, "customers", "sales_hold"); if (refused) return refused; }
  try {
    const orderId = await prisma.$transaction(async (tx) => {
      await setAuditContext(tx, auditFromRequest(request, user.id, null));
      return releaseRejectedHold(tx, { orderId: id, actor: { id: user.id, name: user.name, permissions: user.permissions } });
    }, TX_OPTS);
    await autoPrepareOrder(orderId, "order_created", { id: user.id, name: user.name });
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, paymentHold: true } });
    return NextResponse.json({ order: o });
  } catch (err) {
    return handleDomainError(err);
  }
}
