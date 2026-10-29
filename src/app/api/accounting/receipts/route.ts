import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule, privilegedGate } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { Decimal } from "@/lib/services/commissions/engine";
import { PAYMENT_METHODS, type PaymentMethodValue } from "@/lib/services/sales/collections";
import { ageTone, businessDaysBetween, receiptAbilities, recordAccountantReceipt } from "@/lib/services/sales/receipts";
import { receiptSelfConfirmAllowed } from "@/lib/services/sales/receipt-four-eyes";
import { auditFromRequest, setAuditContext } from "@/lib/accounting/audit";
import type { Prisma } from "@/generated/prisma/client";

/**
 * «سندات العملاء» — the accountant's receipts (BATCH22 WP-D). The accounting module reads; every decision goes through
 * POST /api/sales/collections/[id]/actions (accounting › receipts_confirm, step-up).
 *
 *   GET  ?view=pending|confirmed|returned|rejected|reversed|all &q= &from= &to=  — the queue «سندات بانتظار التأكيد» (aged in
 *        Riyadh business days: amber over 2, red over 5) and the numbered «سند قبض» vouchers.
 *   POST — record a receipt for an issued invoice whose customer has no open deal (no commission; a second person
 *        confirms it). accounting › receipts_confirm or accounting › ar.
 */
const VIEWS: Record<string, Prisma.SalesCollectionWhereInput> = {
  pending: { status: "PENDING_VERIFICATION" },
  confirmed: { status: "APPROVED" },
  returned: { status: "REJECTED", decisionReasonCode: "RETURN_FOR_CORRECTION" },
  rejected: { status: "REJECTED", decisionReasonCode: null },
  reversed: { status: "REVERSED" },
  all: {},
};

const f2 = (v: { toString(): string } | null | undefined) => (v == null ? null : new Decimal(v.toString()).toFixed(2));

export async function GET(request: Request) {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  const url = new URL(request.url);
  const view = VIEWS[url.searchParams.get("view") ?? "pending"] ? (url.searchParams.get("view") ?? "pending") : "pending";
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") ?? "") ? new Date(`${url.searchParams.get("from")}T00:00:00+03:00`) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("to") ?? "") ? new Date(`${url.searchParams.get("to")}T23:59:59.999+03:00`) : null;
  const where: Prisma.SalesCollectionWhereInput = {
    ...VIEWS[view],
    ...(from || to ? { collectedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(q ? { OR: [
      { receiptNumber: { contains: q, mode: "insensitive" } }, { referenceNumber: { contains: q, mode: "insensitive" } },
      { customer: { name: { contains: q, mode: "insensitive" } } }, { customer: { nameAr: { contains: q } } },
      { invoice: { number: { contains: q, mode: "insensitive" } } },
    ] } : {}),
  };
  try {
    const [rows, groups, returned] = await Promise.all([
      prisma.salesCollection.findMany({
        where, orderBy: view === "pending" ? [{ submittedAt: "asc" }] : [{ collectedAt: "desc" }, { submittedAt: "desc" }], take: 500,
        select: {
          id: true, receiptNumber: true, status: true, source: true, amountGross: true, amountTax: true, amountNet: true, currency: true, paymentMethod: true, collectedAt: true,
          referenceNumber: true, note: true, submittedAt: true, decidedAt: true, decisionReason: true, decisionReasonCode: true, reversedAt: true, reversalReason: true,
          receiptMemo: true, sodBypass: true, replacesCollectionId: true,
          submittedBy: { select: { id: true, name: true } }, decidedBy: { select: { id: true, name: true } },
          customer: { select: { id: true, name: true, nameAr: true } }, opportunity: { select: { id: true, title: true, customer: { select: { id: true, name: true, nameAr: true } } } },
          quote: { select: { quoteNumber: true } }, invoice: { select: { id: true, number: true } },
          depositAccount: { select: { id: true, code: true, nameAr: true, nameEn: true } },
          correctedBy: { select: { id: true, status: true } }, _count: { select: { evidence: true } },
        },
      }),
      prisma.salesCollection.groupBy({ by: ["status"], _count: { _all: true }, _sum: { amountGross: true } }),
      prisma.salesCollection.count({ where: VIEWS.returned }),
    ]);
    const now = new Date();
    const ab = receiptAbilities(user.permissions);
    // Four-eyes (owner rule, receipt-four-eyes.ts): may this viewer decide a receipt they recorded themselves?
    const policy = { allowSelfApproval: await receiptSelfConfirmAllowed(prisma, user.id) };
    const counts: Record<string, number> = { all: 0 };
    const totals: Record<string, string> = {};
    for (const g of groups) {
      const k = { PENDING_VERIFICATION: "pending", APPROVED: "confirmed", REJECTED: "rejectedAll", REVERSED: "reversed" }[g.status];
      counts[k] = g._count._all; counts.all += g._count._all; totals[k] = f2(g._sum.amountGross ?? 0)!;
    }
    counts.returned = returned;
    counts.rejected = (counts.rejectedAll ?? 0) - returned;
    delete counts.rejectedAll;
    return NextResponse.json({
      view,
      rows: rows.map((r) => {
        const age = r.status === "PENDING_VERIFICATION" ? businessDaysBetween(r.submittedAt, now) : null;
        const self = r.submittedBy.id === user.id;
        return {
          ...r, amountGross: f2(r.amountGross), amountTax: f2(r.amountTax), amountNet: f2(r.amountNet),
          customer: r.customer ?? r.opportunity?.customer ?? null,
          ageDays: age, tone: age === null ? null : ageTone(age),
          can: {
            // Privilege first, then separation of duties, then the row's state (the reason a person is shown is the one they would fix first).
            confirm: r.status === "PENDING_VERIFICATION" && (r.source === "ACCOUNTANT" ? ab.editVoucher && (!self || policy.allowSelfApproval) : ab.confirm && !self),
            reject: r.status === "PENDING_VERIFICATION" && (r.source === "ACCOUNTANT" ? ab.editVoucher && (!self || policy.allowSelfApproval) : ab.reject && !self),
            reverse: r.status === "APPROVED" && (r.source === "ACCOUNTANT" ? ab.editVoucher : hasSubPrivilege(user.permissions, "commissions", "collection_reverse")),
            selfRecorded: self,
          },
        };
      }),
      counts, totals,
      can: { ...ab, allowSelfApproval: policy.allowSelfApproval },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  const ab = receiptAbilities(user.permissions);
  if (!ab.record) return NextResponse.json({ error: "تسجيل سند قبض يحتاج صلاحية «تأكيد سندات القبض» أو «الذمم المدينة».", errorEn: "Recording a receipt needs accounting › receipts_confirm or accounting › ar.", code: "NO_PRIVILEGE" }, { status: 403 });
  // The accounting module is privileged: a verified individual (the AR duty does not step up; receipts_confirm does).
  const refused = hasSubPrivilege(user.permissions, "accounting", "ar") ? await privilegedGate(user, "accounting", "ar") : await privilegedGate(user, "accounting", "receipts_confirm");
  if (refused) return refused;
  let b: Record<string, unknown>;
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const invoiceId = typeof b.invoiceId === "string" ? b.invoiceId : "";
  if (!invoiceId) return NextResponse.json({ error: "اختر الفاتورة.", errorEn: "Choose the invoice.", code: "INVOICE_REQUIRED" }, { status: 400 });
  const idempotencyKey = typeof b.idempotencyKey === "string" ? b.idempotencyKey.trim() : "";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) return NextResponse.json({ error: "idempotencyKey must be 8–128 characters." }, { status: 400 });
  const raw = typeof b.amountGross === "string" || typeof b.amountGross === "number" ? String(b.amountGross).trim() : "";
  if (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) return NextResponse.json({ error: "المبلغ رقم موجب بمنزلتين عشريتين على الأكثر.", errorEn: "amountGross must be a positive amount with at most two decimal places.", code: "AMOUNT" }, { status: 400 });
  const paymentMethod = (typeof b.paymentMethod === "string" && (PAYMENT_METHODS as string[]).includes(b.paymentMethod) ? b.paymentMethod : "BANK_TRANSFER") as PaymentMethodValue;
  let collectedAt = new Date();
  if (typeof b.collectedAt === "string" && b.collectedAt) {
    collectedAt = new Date(/^\d{4}-\d{2}-\d{2}$/.test(b.collectedAt) ? `${b.collectedAt}T12:00:00+03:00` : b.collectedAt);
    if (Number.isNaN(collectedAt.getTime())) return NextResponse.json({ error: "collectedAt is not a date." }, { status: 400 });
  }
  if (collectedAt.getTime() > Date.now() + 24 * 3600_000) return NextResponse.json({ error: "لا يؤرَّخ السند في المستقبل.", errorEn: "A receipt cannot be dated in the future.", code: "FUTURE_DATE" }, { status: 400 });
  try {
    const r = await prisma.$transaction(async (tx) => {
      await setAuditContext(tx, auditFromRequest(request, user.id));
      return recordAccountantReceipt(tx, {
        invoiceId, amountGross: new Decimal(raw), collectedAt, paymentMethod,
        referenceNumber: typeof b.referenceNumber === "string" ? b.referenceNumber : null, note: typeof b.note === "string" ? b.note : null,
        idempotencyKey, submittedById: user.id,
      });
    }, TX_OPTS);
    return NextResponse.json(r, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
