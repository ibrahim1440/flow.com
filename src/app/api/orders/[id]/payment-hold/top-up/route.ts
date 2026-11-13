import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { privilegedGate, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { auditFromRequest, setAuditContext } from "@/lib/accounting/audit";
import { Decimal } from "@/lib/accounting/money";
import { AMOUNT_PATTERN } from "@/lib/money/amount-input";
import { PAYMENT_METHODS } from "@/lib/services/sales/collections";
import { recordHoldTopUp } from "@/lib/services/orders/payment-hold";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/orders/[id]/payment-hold/top-up — «سجّل الباقي» (owner أ on top-ups). After a short correction of a held
 * direct sale was approved, the order's rep (or a holder of customers › sales_hold) records the rest as a collection
 * linked to THIS order on the server. The body carries the money only (amountGross, collectedAt, paymentMethod,
 * referenceNumber, note, idempotencyKey): the link is the URL's order, never a field of the body (a holdOrderId sent in
 * it is ignored). It waits for the accountant; its approval releases the hold once the money covers the sale.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { id } = await params;
  let b: Record<string, unknown>;
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body.", code: "BAD_INPUT" }, { status: 400 }); }
  const o = await prisma.order.findUnique({ where: { id }, select: { ownerId: true } });
  const supervisor = hasSubPrivilege(user.permissions, "customers", "sales_hold");
  // Another rep's order is not confirmed to exist.
  if (!o || (o.ownerId !== user.id && !supervisor)) return NextResponse.json({ error: "الطلب غير موجود.", errorEn: "Order not found.", code: "NOT_FOUND" }, { status: 404 });
  if (o.ownerId !== user.id) { const refused = await privilegedGate(user, "customers", "sales_hold"); if (refused) return refused; }
  else if (!(hasModuleAccess(user.permissions, "sales") && hasSubPrivilege(user.permissions, "sales", "collection_submit"))) {
    return NextResponse.json({ error: "لا تملك صلاحية تسجيل التحصيل.", errorEn: "You do not hold the permission to record a collection.", code: "NO_PRIVILEGE" }, { status: 403 });
  }

  const idempotencyKey = typeof b.idempotencyKey === "string" ? b.idempotencyKey.trim() : "";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) return NextResponse.json({ error: "idempotencyKey must be 8–128 characters.", code: "BAD_INPUT" }, { status: 400 });
  const raw = String(b.amountGross ?? "").trim();
  if (!AMOUNT_PATTERN.test(raw) || !(Number(raw) > 0)) return NextResponse.json({ error: "اكتب المبلغ (رقم موجب بخانتين عشريتين على الأكثر).", errorEn: "amountGross must be a positive amount with at most two decimal places.", code: "AMOUNT_INVALID", field: "amountGross" }, { status: 400 });
  const collectedAt = typeof b.collectedAt === "string" && b.collectedAt ? new Date(b.collectedAt) : new Date();
  if (Number.isNaN(collectedAt.getTime()) || collectedAt.getTime() > Date.now() + 24 * 3600_000) return NextResponse.json({ error: "تاريخ التحصيل غير صالح أو في المستقبل.", errorEn: "collectedAt is not a past date.", code: "BAD_INPUT" }, { status: 400 });
  const paymentMethod = typeof b.paymentMethod === "string" ? b.paymentMethod : "";
  if (!(PAYMENT_METHODS as string[]).includes(paymentMethod)) return NextResponse.json({ error: "طريقة الدفع غير معروفة.", errorEn: "Unknown paymentMethod.", code: "BAD_INPUT", field: "paymentMethod" }, { status: 400 });

  try {
    const r = await prisma.$transaction(async (tx) => {
      await setAuditContext(tx, auditFromRequest(request, user.id, null));
      return recordHoldTopUp(tx, {
        orderId: id, actor: { id: user.id, name: user.name, permissions: user.permissions },
        amountGross: new Decimal(raw), collectedAt, paymentMethod,
        referenceNumber: typeof b.referenceNumber === "string" ? b.referenceNumber : null,
        note: typeof b.note === "string" ? b.note : null, idempotencyKey,
      });
    }, TX_OPTS);
    return NextResponse.json(r, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
