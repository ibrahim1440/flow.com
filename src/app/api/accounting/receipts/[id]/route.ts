import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { Decimal } from "@/lib/services/commissions/engine";
import { depositAccounts, receiptAbilities, businessDaysBetween, ageTone } from "@/lib/services/sales/receipts";
import { openDebits, proposeAllocation } from "@/lib/services/invoicing/ar";
import { openOf } from "@/lib/services/invoicing/ar-math";
import { receiptSelfConfirmAllowed } from "@/lib/services/sales/receipt-four-eyes";
import { sellerSnapshot } from "@/lib/services/invoicing/settings";
import { documentPrintGate } from "@/lib/print/server/auth";

type Params = { params: Promise<{ id: string }> };
const f2 = (v: { toString(): string } | null | undefined) => (v == null ? null : new Decimal(v.toString()).toFixed(2));

/**
 * GET /api/accounting/receipts/[id] — one receipt for the confirm drawer («تأكيد السند») and the printed «سند قبض»
 * (?print=1, behind the A4 document gate). The accounting module reads. For a pending receipt: the customer's open
 * invoices, the default allocation (its own invoice and its order's first, then the oldest — FIFO), the deposit accounts
 * and the method's default; for a confirmed one: what it was applied to and its ledger entry.
 */
export async function GET(request: Request, { params }: Params) {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  const { id } = await params;
  const print = new URL(request.url).searchParams.get("print") === "1";
  if (print) { const gated = documentPrintGate(); if (gated) return gated; }
  try {
    const r = await prisma.salesCollection.findUnique({
      where: { id },
      select: {
        id: true, receiptNumber: true, status: true, source: true, amountGross: true, amountTax: true, amountNet: true, currency: true, paymentMethod: true, collectedAt: true,
        referenceNumber: true, note: true, submittedAt: true, decidedAt: true, decisionReason: true, decisionReasonCode: true, reversedAt: true, reversalReason: true,
        receiptMemo: true, sodBypass: true, orderId: true, invoiceId: true, replacesCollectionId: true,
        submittedBy: { select: { id: true, name: true } }, decidedBy: { select: { id: true, name: true } }, reversedBy: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true, nameAr: true, vatNumber: true } }, opportunity: { select: { id: true, title: true, customer: { select: { id: true, name: true, nameAr: true, vatNumber: true } } } },
        quote: { select: { quoteNumber: true } }, invoice: { select: { id: true, number: true } }, order: { select: { orderNumber: true } },
        depositAccount: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        correctedBy: { select: { id: true, status: true } },
        evidence: { orderBy: { uploadedAt: "asc" }, select: { id: true, filename: true, mimeType: true, byteSize: true, uploadedAt: true } },
        arApplications: { where: { status: "APPLIED" }, orderBy: { createdAt: "asc" }, select: { id: true, amount: true, appliedDate: true, invoice: { select: { id: true, number: true } } } },
      },
    });
    if (!r) return NextResponse.json({ error: "السند غير موجود.", errorEn: "Receipt not found.", code: "NOT_FOUND" }, { status: 404 });
    const customer = r.customer ?? r.opportunity?.customer ?? null;
    const amount = new Decimal(r.amountGross.toString());
    let open: { id: string; number: string; issueDate: string; dueDate: string | null; total: string; open: string; ofOrder: boolean; own: boolean }[] = [];
    let proposal: { invoiceId: string; amount: string }[] = [];
    let deposit: Awaited<ReturnType<typeof depositAccounts>> | null = null;
    if (r.status === "PENDING_VERIFICATION" && customer) {
      const debits = await openDebits(prisma, customer.id, {}, false);
      open = debits.filter((d) => openOf(d).greaterThan(0)).sort((a, b) => (a.dueDate ?? a.issueDate).localeCompare(b.dueDate ?? b.issueDate))
        .map((d) => ({ id: d.id, number: d.number, issueDate: d.issueDate, dueDate: d.dueDate, total: d.total.toFixed(2), open: openOf(d).toFixed(2), ofOrder: !!r.orderId && d.orderId === r.orderId, own: d.id === r.invoiceId }));
      proposal = proposeAllocation(amount, debits, { invoiceId: r.invoiceId, orderId: r.orderId }).map((p) => ({ invoiceId: p.id, amount: p.amount.toFixed(2) }));
      deposit = await depositAccounts(prisma);
    }
    const entries = await prisma.journalEntry.findMany({ where: { sourceModule: "sales", sourceType: "COLLECTION", sourceId: r.id, idempotencyKey: { not: null } }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, sourceEvent: true, entryDate: true, postingYear: true, postingSeq: true, type: true } });
    const ab = receiptAbilities(user.permissions);
    // Four-eyes (owner rule, receipt-four-eyes.ts): may this viewer decide a receipt they recorded themselves?
    const policy = { allowSelfApproval: await receiptSelfConfirmAllowed(prisma, user.id) };
    const self = r.submittedBy.id === user.id;
    const accountant = r.source === "ACCOUNTANT";
    const age = r.status === "PENDING_VERIFICATION" ? businessDaysBetween(r.submittedAt, new Date()) : null;
    return NextResponse.json({
      receipt: {
        ...r, customer, amountGross: f2(r.amountGross), amountTax: f2(r.amountTax), amountNet: f2(r.amountNet),
        arApplications: r.arApplications.map((a) => ({ ...a, amount: f2(a.amount), appliedDate: a.appliedDate.toISOString().slice(0, 10) })),
        ageDays: age, tone: age === null ? null : ageTone(age),
      },
      open, proposal, deposit, entries,
      can: {
        confirm: r.status === "PENDING_VERIFICATION" && (accountant ? ab.editVoucher && (!self || policy.allowSelfApproval) : ab.confirm && !self),
        reject: r.status === "PENDING_VERIFICATION" && (accountant ? ab.editVoucher && (!self || policy.allowSelfApproval) : ab.reject && !self),
        editVoucher: ab.editVoucher,
        reverse: r.status === "APPROVED" && (accountant ? ab.editVoucher : hasSubPrivilege(user.permissions, "commissions", "collection_reverse")),
        selfRecorded: self, selfWouldBypass: accountant && self && policy.allowSelfApproval,
        // The drawer's hint: «تأكيد ذاتي (محاسب واحد)» or «يحتاج تأكيد شخص آخر».
        selfConfirm: accountant && self ? (policy.allowSelfApproval ? "ALLOWED" : "NEEDS_OTHER") : null,
      },
      ...(print ? { seller: await sellerSnapshot(prisma), printedAt: new Date().toISOString() } : {}),
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
