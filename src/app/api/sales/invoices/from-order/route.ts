import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { jsonBody } from "@/lib/accounting/http";
import { inScope } from "@/lib/services/invoicing/http";
import { draftFromOrder } from "@/lib/services/invoicing/service";
import { invError, refuseInv } from "@/lib/services/invoicing/refusals";

/**
 * POST /api/sales/invoices/from-order { orderId, basis: REMAINING | DELIVERED, deliveryIds?, family?, requestKey? } —
 * «إنشاء فاتورة من الطلب»: a DRAFT of what is left to invoice (full or partial; never more than the order line holds),
 * priced from the order's quotation (else the SKU's price). sales › invoices_create.
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("sales", "invoices_create");
  if (error) return error;
  try {
    const body = await jsonBody(request);
    const orderId = typeof body.orderId === "string" ? body.orderId : "";
    const order = orderId ? await prisma.order.findUnique({ where: { id: orderId }, select: { customerId: true } }) : null;
    if (!order || !(await inScope(user, order.customerId))) throw refuseInv("ORDER_NOT_FOUND");
    const deliveryIds = Array.isArray(body.deliveryIds) ? body.deliveryIds.filter((x): x is string => typeof x === "string").slice(0, 50) : undefined;
    const r = await draftFromOrder(orderId, {
      basis: body.basis === "DELIVERED" ? "DELIVERED" : "REMAINING", deliveryIds, family: body.family === "SIMPLIFIED" ? "SIMPLIFIED" : "STANDARD",
      requestKey: typeof body.requestKey === "string" && /^[A-Za-z0-9:_-]{8,80}$/.test(body.requestKey) ? `client:${user.id}:${body.requestKey}` : null,
    }, auditFromRequest(request, user.id, "invoice from order"));
    return NextResponse.json(r, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    return invError(err);
  }
}
