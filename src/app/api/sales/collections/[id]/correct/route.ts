import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { privilegedGate, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { Decimal } from "@/lib/services/commissions/engine";
import { PAYMENT_METHODS, type PaymentMethodValue } from "@/lib/services/sales/collections";
import { copyAndCorrect, receiptAbilities, type CorrectionEdits } from "@/lib/services/sales/receipts";
import { auditFromRequest, setAuditContext } from "@/lib/accounting/audit";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/collections/[id]/correct — «نسخ وتصحيح» (BATCH22 WP-D).
 *
 * A collection the accountant returned for correction («إعادة للمندوب للتصحيح») is copied into a NEW pending collection,
 * prefilled from it with the edits applied, its evidence copied and naming the one it corrects; the returned one stays
 * REJECTED (history kept). Only the person who recorded it, with the duty that records one: `sales › collection_submit`
 * for a Sales collection, the accountant's record duty for a receipt with no deal. Idempotent on the new key; a second
 * correction of the same row returns the first.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { id } = await params;
  let b: Record<string, unknown>;
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }

  const row = await prisma.salesCollection.findUnique({ where: { id }, select: { source: true, submittedById: true } });
  // Somebody else's collection is not confirmed to exist.
  if (!row || row.submittedById !== user.id) return NextResponse.json({ error: "Collection not found." }, { status: 404 });
  const may = row.source === "ACCOUNTANT"
    ? receiptAbilities(user.permissions).record
    : hasModuleAccess(user.permissions, "sales") && hasSubPrivilege(user.permissions, "sales", "collection_submit");
  if (!may) return NextResponse.json({ error: "لا تملك صلاحية تسجيل التحصيل.", errorEn: "You do not hold the permission to record a collection.", code: "NO_PRIVILEGE" }, { status: 403 });
  // BATCH22 gate S3: re-recording an accountant receipt passes the same central gate as recording one (POST
  // /api/accounting/receipts): a verified individual, and the step-up of receipts_confirm.
  if (row.source === "ACCOUNTANT") {
    const refused = hasSubPrivilege(user.permissions, "accounting", "ar") ? await privilegedGate(user, "accounting", "ar") : await privilegedGate(user, "accounting", "receipts_confirm");
    if (refused) return refused;
  }

  const idempotencyKey = typeof b.idempotencyKey === "string" ? b.idempotencyKey.trim() : "";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) return NextResponse.json({ error: "idempotencyKey must be 8–128 characters." }, { status: 400 });
  const edits: CorrectionEdits = {};
  if (b.amountGross !== undefined) {
    const raw = String(b.amountGross).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return NextResponse.json({ error: "amountGross must be a positive amount with at most two decimal places." }, { status: 400 });
    edits.amountGross = new Decimal(raw);
  }
  if (typeof b.collectedAt === "string" && b.collectedAt) {
    const d = new Date(b.collectedAt);
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 24 * 3600_000) return NextResponse.json({ error: "تاريخ التحصيل غير صالح أو في المستقبل.", errorEn: "collectedAt is not a past date." }, { status: 400 });
    edits.collectedAt = d;
  }
  if (typeof b.paymentMethod === "string") {
    if (!(PAYMENT_METHODS as string[]).includes(b.paymentMethod)) return NextResponse.json({ error: "طريقة الدفع غير معروفة.", errorEn: "Unknown paymentMethod." }, { status: 400 });
    edits.paymentMethod = b.paymentMethod as PaymentMethodValue;
  }
  if (b.referenceNumber !== undefined) edits.referenceNumber = typeof b.referenceNumber === "string" ? b.referenceNumber : null;
  if (b.note !== undefined) edits.note = typeof b.note === "string" ? b.note : null;

  try {
    const r = await prisma.$transaction(async (tx) => {
      await setAuditContext(tx, auditFromRequest(request, user.id));
      return copyAndCorrect(tx, { collectionId: id, actorId: user.id, idempotencyKey, edits });
    }, TX_OPTS);
    return NextResponse.json(r, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
