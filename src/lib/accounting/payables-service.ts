// Supplier bills (stage 2): draft → submitted → approved (by someone else) → posted; rejection
// returns a bill to draft with a reason; a posted bill is corrected only by reversal.
// Posting creates the bill's payment obligation in the Finance module in the SAME transaction
// (superseding the purchase-order obligation it replaces), so cash planning keeps exactly one
// liability. The ledger journal comes from the outbox event the database emits on posting
// (translators/payables.ts); payment is recognised from the matched bank line, never here.
import { Prisma, type BillLineKind, type SupplierBillStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ledgerTx } from "./journal-service";
import { auditAccounting } from "./audit";
import { ZERO, dec } from "./money";
import { accountingDate } from "./dates";
import { resolveRoles } from "./posting";
import { processEvent, type ProcessOutcome } from "./event-processor";

type Tx = Prisma.TransactionClient;
import { computeLine, isKsaVatNumber } from "./bill-rules";
export { computeLine, isKsaVatNumber };

const FOUR_DP = /^\d{1,14}(\.\d{1,4})?$/;
function parseQty(raw: unknown, field: string): Prisma.Decimal {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.replace(/,/g, "").trim() : "";
  if (!FOUR_DP.test(s)) throw new AccountingError(`${field} must be a positive number with at most four decimals.`, 400);
  const d = new Prisma.Decimal(s);
  if (d.lte(0)) throw new AccountingError(`${field} must be greater than zero.`, 400);
  return d;
}

export type BillLineInput = {
  kind?: BillLineKind; accountId?: string; description?: string;
  quantity: string | number; unitPrice: string | number; taxCategoryId?: string | null; costCenterId?: string | null;
  /** Credit note lines: the supplier return settled (STOCK_RETURN) or the receipt line repriced (STOCK_PRICE_ADJUSTMENT). */
  invDocumentId?: string | null; invDocLineId?: string | null;
};
export type BillInput = {
  supplierId: string; supplierInvoiceNo: string; billDate: string; dueDate?: string | null;
  branchId?: string | null; description?: string | null; purchaseObligationId?: string | null; lines: BillLineInput[];
  /** A supplier credit note credits one posted bill of the same supplier, with a reason. */
  kind?: "BILL" | "CREDIT_NOTE"; originalBillId?: string | null; reason?: string | null;
};
const STOCK_KINDS = new Set<BillLineKind>(["STOCK_RECEIPT", "STOCK_RETURN", "STOCK_PRICE_ADJUSTMENT"]);

async function buildLines(tx: Tx, raw: BillLineInput[], credit: { supplierId: string; selfId?: string } | null = null) {
  if (!Array.isArray(raw) || raw.length === 0) throw new AccountingError("A bill needs at least one line.", 400);
  if (raw.length > 200) throw new AccountingError("A bill may have at most 200 lines.", 400);
  for (const [i, l] of raw.entries()) {
    const k = l.kind ?? "EXPENSE";
    if (credit ? !["EXPENSE", "STOCK_RETURN", "STOCK_PRICE_ADJUSTMENT"].includes(k) : !["EXPENSE", "STOCK_RECEIPT"].includes(k)) {
      throw new AccountingError(`Line ${i + 1}: ${credit ? "a supplier credit note line is an expense credit, a return of goods, or a price reduction on goods received" : "a bill line is an expense or goods received"}.`, 400);
    }
    if (credit && k === "STOCK_RETURN") {
      const d = l.invDocumentId ? await tx.invDocument.findUnique({ where: { id: l.invDocumentId } }) : null;
      if (!d || d.type !== "SUPPLIER_RETURN" || d.status !== "POSTED" || d.supplierId !== credit.supplierId) throw new AccountingError(`Line ${i + 1}: choose a posted return to this supplier.`, 400);
      const other = await tx.supplierBillLine.findFirst({ where: { invDocumentId: d.id, bill: { status: { in: ["DRAFT", "SUBMITTED", "APPROVED", "POSTED"] }, ...(credit.selfId ? { id: { not: credit.selfId } } : {}) } }, include: { bill: true } });
      if (other) throw new AccountingError(`Line ${i + 1}: that return is already credited by credit note ف-${other.bill.billNo}.`, 409);
    }
    if (credit && k === "STOCK_PRICE_ADJUSTMENT") {
      const dl = l.invDocLineId ? await tx.invDocLine.findUnique({ where: { id: l.invDocLineId }, include: { document: true } }) : null;
      if (!dl || dl.document.type !== "RECEIPT" || dl.document.status !== "POSTED" || dl.document.supplierId !== credit.supplierId) throw new AccountingError(`Line ${i + 1}: choose a posted receipt line from this supplier.`, 400);
    }
  }
  const needsGrni = raw.some((l) => STOCK_KINDS.has(l.kind ?? "EXPENSE"));
  const grni = needsGrni ? (await resolveRoles(tx, ["GRNI"])).get("GRNI")! : null;
  const accountIds = [...new Set(raw.filter((l) => l.kind !== "STOCK_RECEIPT").map((l) => l.accountId).filter(Boolean) as string[])];
  const accounts = await tx.account.findMany({ where: { id: { in: accountIds } }, include: { _count: { select: { children: true } } } });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const taxIds = [...new Set(raw.map((l) => l.taxCategoryId).filter(Boolean) as string[])];
  const taxes = await tx.taxCategory.findMany({ where: { id: { in: taxIds } } });
  const taxById = new Map(taxes.map((t) => [t.id, t]));
  return raw.map((l, i) => {
    const n = i + 1;
    const kind: BillLineKind = l.kind && STOCK_KINDS.has(l.kind) ? l.kind : "EXPENSE";
    let accountId: string;
    if (STOCK_KINDS.has(kind)) accountId = grni!;
    else {
      const a = l.accountId ? byId.get(l.accountId) : undefined;
      if (!a) throw new AccountingError(`Line ${n}: choose an account.`, 400);
      if (!a.isActive || !a.allowPosting || a._count.children > 0) throw new AccountingError(`Line ${n}: account ${a.code} cannot receive postings.`, 400);
      if (a.type !== "EXPENSE" && a.type !== "ASSET") throw new AccountingError(`Line ${n}: a bill line debits an expense or asset account (${a.code} is ${a.type.toLowerCase()}).`, 400);
      if (a.controlKind !== "NONE") throw new AccountingError(`Line ${n}: ${a.code} is a control account; it is posted only by its subledger.`, 400);
      accountId = a.id;
    }
    const quantity = parseQty(l.quantity, `Line ${n} quantity`);
    const unitPrice = parseQty(l.unitPrice, `Line ${n} unit price`);
    let rate = ZERO;
    let taxCategoryId: string | null = null;
    if (l.taxCategoryId) {
      const t = taxById.get(l.taxCategoryId);
      if (!t || !t.isActive) throw new AccountingError(`Line ${n}: the tax category is unknown or inactive.`, 400);
      rate = dec(t.rate); taxCategoryId = t.id;
    }
    const { net, vat, gross } = computeLine(quantity, unitPrice, rate);
    const description = typeof l.description === "string" ? l.description.trim().slice(0, 300) || null : null;
    return { lineNo: n, kind, accountId, description, quantity, unitPrice, net, taxCategoryId, vatRate: rate, vat, gross, costCenterId: l.costCenterId || null,
      invDocumentId: kind === "STOCK_RETURN" ? l.invDocumentId! : null, invDocLineId: kind === "STOCK_PRICE_ADJUSTMENT" ? l.invDocLineId! : null };
  });
}

async function header(tx: Tx, input: BillInput) {
  const supplier = await tx.supplier.findUnique({ where: { id: String(input.supplierId ?? "") } });
  if (!supplier || !supplier.active) throw new AccountingError("Choose an active supplier.", 400);
  const inv = typeof input.supplierInvoiceNo === "string" ? input.supplierInvoiceNo.trim() : "";
  if (!inv || inv.length > 60) throw new AccountingError("Enter the supplier's invoice number.", 400);
  const billDate = accountingDate(input.billDate);
  const dueDate = input.dueDate ? accountingDate(input.dueDate) : new Date(billDate.getTime() + supplier.paymentTermsDays * 86_400_000);
  if (dueDate < billDate) throw new AccountingError("The due date cannot be before the bill date.", 400);
  return {
    supplier, data: {
      supplierId: supplier.id, supplierInvoiceNo: inv, billDate, dueDate,
      branchId: input.branchId || null, description: input.description?.trim().slice(0, 500) || null,
      purchaseObligationId: input.purchaseObligationId || null,
    },
  };
}

const totals = (lines: { net: Prisma.Decimal; vat: Prisma.Decimal; gross: Prisma.Decimal }[]) => ({
  totalNet: lines.reduce((s, l) => s.add(l.net), ZERO),
  totalVat: lines.reduce((s, l) => s.add(l.vat), ZERO),
  totalGross: lines.reduce((s, l) => s.add(l.gross), ZERO),
});

/**
 * Supplier credit note terms: it credits a posted bill of the same supplier, has a reason, and
 * with other live credit notes never exceeds that bill.
 */
async function creditTerms(tx: Tx, input: BillInput, supplierId: string, gross: Prisma.Decimal, selfId?: string) {
  if (input.kind !== "CREDIT_NOTE") return { kind: "BILL" as const, originalBillId: null, reason: null };
  const orig = input.originalBillId ? await tx.supplierBill.findUnique({ where: { id: input.originalBillId } }) : null;
  if (!orig || orig.kind !== "BILL" || orig.status !== "POSTED" || orig.supplierId !== supplierId) throw new AccountingError("A supplier credit note credits a posted bill of the same supplier.", 400);
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  if (reason.length < 5) throw new AccountingError("A supplier credit note needs a reason (at least 5 characters).", 400);
  const used = await tx.supplierBill.aggregate({ where: { originalBillId: orig.id, status: { in: ["DRAFT", "SUBMITTED", "APPROVED", "POSTED"] }, ...(selfId ? { id: { not: selfId } } : {}) }, _sum: { totalGross: true } });
  if (gross.add(dec(used._sum.totalGross)).gt(dec(orig.totalGross))) throw new AccountingError(`Credit notes cannot exceed the bill they credit (${dec(orig.totalGross).sub(dec(used._sum.totalGross)).toFixed(2)} left).`, 400);
  return { kind: "CREDIT_NOTE" as const, originalBillId: orig.id, reason };
}

export async function createBill(input: BillInput, userId: string) {
  return ledgerTx(async (tx) => {
    const { data } = await header(tx, input);
    const lines = await buildLines(tx, input.lines, input.kind === "CREDIT_NOTE" ? { supplierId: data.supplierId } : null);
    const terms = await creditTerms(tx, input, data.supplierId, totals(lines).totalGross);
    const bill = await tx.supplierBill.create({ data: { ...data, ...terms, ...totals(lines), createdBy: userId, lines: { create: lines } }, include: { lines: true } });
    await auditAccounting(tx, { action: "bill.create", entityType: "bill", entityId: bill.id, userId, after: { billNo: bill.billNo, gross: bill.totalGross } });
    return bill;
  });
}

export async function updateDraftBill(id: string, input: BillInput, userId: string) {
  return ledgerTx(async (tx) => {
    const b = await tx.supplierBill.findUnique({ where: { id } });
    if (!b) throw new AccountingError("Bill not found.", 404);
    if (b.status !== "DRAFT") throw new AccountingError("Only a draft bill can be edited.", 409);
    const { data } = await header(tx, input);
    const lines = await buildLines(tx, input.lines, b.kind === "CREDIT_NOTE" ? { supplierId: data.supplierId, selfId: id } : null);
    const terms = await creditTerms(tx, { ...input, kind: b.kind, originalBillId: input.originalBillId ?? b.originalBillId, reason: input.reason ?? b.reason }, data.supplierId, totals(lines).totalGross, id);
    await tx.supplierBillLine.deleteMany({ where: { billId: id } });
    const bill = await tx.supplierBill.update({ where: { id }, data: { ...data, ...terms, ...totals(lines), lines: { create: lines } }, include: { lines: true } });
    await auditAccounting(tx, { action: "bill.update", entityType: "bill", entityId: id, userId, before: { gross: b.totalGross }, after: { gross: bill.totalGross } });
    return bill;
  });
}

export async function deleteDraftBill(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const b = await tx.supplierBill.findUnique({ where: { id } });
    if (!b) throw new AccountingError("Bill not found.", 404);
    if (b.status !== "DRAFT") throw new AccountingError("Only a draft bill can be deleted.", 409);
    await tx.supplierBill.delete({ where: { id } });
    await auditAccounting(tx, { action: "bill.delete", entityType: "bill", entityId: id, userId, before: { billNo: b.billNo } });
    return { deleted: true };
  });
}

/** Conditional status change: two people acting at once produce one change and one 409. */
async function transition(tx: Tx, id: string, from: SupplierBillStatus[], to: SupplierBillStatus, data: Prisma.SupplierBillUpdateManyMutationInput) {
  const r = await tx.supplierBill.updateMany({ where: { id, status: { in: from } }, data: { ...data, status: to } });
  if (r.count !== 1) throw new AccountingError(`The bill is no longer ${from.join(" or ").toLowerCase()}; refresh and try again.`, 409);
  return tx.supplierBill.findUniqueOrThrow({ where: { id }, include: { lines: true, supplier: true } });
}

export async function submitBill(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const b = await tx.supplierBill.findUnique({ where: { id } });
    if (!b) throw new AccountingError("Bill not found.", 404);
    const bill = await transition(tx, id, ["DRAFT"], "SUBMITTED", { submittedAt: new Date(), submittedBy: userId, rejectedAt: null, rejectedBy: null, rejectedReason: null });
    await auditAccounting(tx, { action: "bill.submit", entityType: "bill", entityId: id, userId });
    return bill;
  });
}

export async function approveBill(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const b = await tx.supplierBill.findUnique({ where: { id }, include: { supplier: true } });
    if (!b) throw new AccountingError("Bill not found.", 404);
    if (b.createdBy === userId || b.submittedBy === userId) throw new AccountingError("You prepared or submitted this bill; someone else must approve it.", 403);
    if (dec(b.totalVat).gt(0) && !isKsaVatNumber(b.supplier.vatNumber)) {
      throw new AccountingError("The supplier has no valid VAT registration number, so input VAT cannot be claimed. Add it to the supplier or remove the VAT.", 409);
    }
    const bill = await transition(tx, id, ["SUBMITTED"], "APPROVED", { approvedAt: new Date(), approvedBy: userId });
    await auditAccounting(tx, { action: "bill.approve", entityType: "bill", entityId: id, userId });
    return bill;
  });
}

export async function rejectBill(id: string, userId: string, reason: string) {
  const why = reason?.trim();
  if (!why || why.length < 5) throw new AccountingError("A rejection needs a reason (at least 5 characters).", 400);
  return ledgerTx(async (tx) => {
    const b = await tx.supplierBill.findUnique({ where: { id } });
    if (!b) throw new AccountingError("Bill not found.", 404);
    if (b.createdBy === userId) throw new AccountingError("You prepared this bill; edit or delete it instead of rejecting it.", 403);
    const bill = await transition(tx, id, ["SUBMITTED"], "DRAFT", { rejectedAt: new Date(), rejectedBy: userId, rejectedReason: why, submittedAt: null, submittedBy: null });
    await auditAccounting(tx, { action: "bill.reject", entityType: "bill", entityId: id, userId, reason: why });
    return bill;
  });
}

export type PostOutcome = { bill: Awaited<ReturnType<typeof transition>>; ledger: ProcessOutcome | null };

export async function postBill(id: string, userId: string): Promise<PostOutcome> {
  const bill = await ledgerTx(async (tx) => {
    const b = await tx.supplierBill.findUnique({ where: { id }, include: { supplier: true } });
    if (!b) throw new AccountingError("Bill not found.", 404);
    if (b.status !== "APPROVED") throw new AccountingError("Only an approved bill can be posted.", 409);
    const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: b.billDate }, endDate: { gte: b.billDate } } });
    if (!period) throw new AccountingError("No fiscal period covers the bill date.", 409);
    if (period.status !== "OPEN") throw new AccountingError(`The period of the bill date is ${period.status.toLowerCase()}; bills post only into open periods.`, 409);

    if (b.kind === "CREDIT_NOTE") {
      // A credit is not a payment obligation: it reduces what is owed (applied to bills in AP).
      const posted = await transition(tx, id, ["APPROVED"], "POSTED", { postedAt: new Date(), postedBy: userId });
      await auditAccounting(tx, { action: "bill.post", entityType: "bill", entityId: id, userId, refs: { creditNoteOf: b.originalBillId } });
      return posted;
    }
    const branchKey = b.branchId ?? "COMPANY";
    let supersedesId: string | null = null;
    if (b.purchaseObligationId) {
      const po = await tx.finObligation.findUnique({ where: { id: b.purchaseObligationId } });
      if (!po || po.status !== "OPEN") throw new AccountingError("The purchase-order obligation this bill replaces is no longer open.", 409);
      const paid = await tx.bankTransactionMatch.aggregate({ where: { targetType: "OBLIGATION", targetId: po.id, active: true }, _sum: { amount: true } });
      if (dec(paid._sum.amount).gt(0)) throw new AccountingError("Payments are matched to the purchase-order obligation; match them to the bill instead.", 409);
      supersedesId = po.id;
    }
    const ob = await tx.finObligation.create({
      data: {
        branchKey, type: "SUPPLIER_BILL", description: `فاتورة مورد ف-${b.billNo} · ${b.supplier.name} · ${b.supplierInvoiceNo}`,
        counterparty: b.supplier.name, amount: b.totalGross, dueDate: b.dueDate, sourceType: "SUPPLIER_BILL", sourceId: b.id,
        supersedesId, createdBy: userId,
      },
    });
    if (supersedesId) {
      await tx.finObligation.update({ where: { id: supersedesId }, data: { status: "SUPERSEDED" } });
      await tx.paymentReservation.updateMany({ where: { obligationId: supersedesId, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } }, data: { obligationId: ob.id } });
    }
    await tx.finAuditLog.create({ data: { action: "obligation.created", entityType: "FinObligation", entityId: ob.id, branchKey, userId, refs: { supplierBill: b.id, supersedes: supersedesId } } });
    const posted = await transition(tx, id, ["APPROVED"], "POSTED", { postedAt: new Date(), postedBy: userId, obligationId: ob.id });
    await auditAccounting(tx, { action: "bill.post", entityType: "bill", entityId: id, userId, refs: { obligation: ob.id } });
    return posted;
  });
  if (bill.kind === "CREDIT_NOTE") {
    const ledger = await processBillEvent(bill.id, "ap.credit_note.posted");
    // Goods returned are settled and price reductions traced through stock (inventory documents).
    const { settleSupplierCredit } = await import("./supplier-credits");
    await settleSupplierCredit(bill.id);
    return { bill, ledger };
  }
  return { bill, ledger: await processBillEvent(bill.id, "ap.bill.posted") };
}

export async function reverseBill(id: string, userId: string, reason: string): Promise<PostOutcome> {
  const why = reason?.trim();
  if (!why || why.length < 5) throw new AccountingError("A reversal needs a reason (at least 5 characters).", 400);
  const bill = await ledgerTx(async (tx) => {
    const b = await tx.supplierBill.findUnique({ where: { id } });
    if (!b) throw new AccountingError("Bill not found.", 404);
    if (b.status !== "POSTED") throw new AccountingError("Only a posted bill can be reversed.", 409);
    if (b.kind === "CREDIT_NOTE" && await tx.supplierBillLine.count({ where: { billId: id, kind: { in: ["STOCK_RETURN", "STOCK_PRICE_ADJUSTMENT"] } } })) {
      throw new AccountingError("This credit note has settled returns or repriced stock; it cannot be reversed. Ask the supplier for a new bill instead.", 409);
    }
    if (await tx.apCreditAllocation.count({ where: { OR: [{ creditNoteId: id }, { billId: id }], active: true } })) throw new AccountingError("Supplier credits are applied to this document; release them first.", 409);
    if (b.obligationId) {
      const paid = await tx.bankTransactionMatch.aggregate({ where: { targetType: "OBLIGATION", targetId: b.obligationId, active: true, transaction: { status: { not: "VOID" } } }, _sum: { amount: true } });
      if (dec(paid._sum.amount).gt(0)) throw new AccountingError("Payments are matched to this bill; unmatch them before reversing it.", 409);
      await tx.finObligation.update({ where: { id: b.obligationId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: userId, cancelReason: `Supplier bill reversed: ${why}` } });
    }
    const reversed = await transition(tx, id, ["POSTED"], "REVERSED", { reversedAt: new Date(), reversedBy: userId, reversalReason: why });
    await auditAccounting(tx, { action: "bill.reverse", entityType: "bill", entityId: id, userId, reason: why });
    return reversed;
  });
  return { bill, ledger: await processBillEvent(bill.id, bill.kind === "CREDIT_NOTE" ? "ap.credit_note.reversed" : "ap.bill.reversed") };
}

/** Apply (part of) a supplier credit note to a bill of the same supplier: a net-zero AP reclass. */
export async function allocateSupplierCredit(body: { creditNoteId?: unknown; billId?: unknown; amount?: unknown; allocatedOn?: unknown }, userId: string) {
  const amount = parseQty(body.amount, "Amount");
  if (amount.decimalPlaces() > 2) throw new AccountingError("Amount has more than 2 decimals.", 400);
  const a = await ledgerTx(async (tx) => {
    const cn = await tx.supplierBill.findUnique({ where: { id: String(body.creditNoteId ?? "") } });
    const bill = await tx.supplierBill.findUnique({ where: { id: String(body.billId ?? "") } });
    if (!cn || cn.kind !== "CREDIT_NOTE" || cn.status !== "POSTED") throw new AccountingError("Choose a posted supplier credit note.", 400);
    if (!bill || bill.kind !== "BILL" || bill.status !== "POSTED" || bill.supplierId !== cn.supplierId) throw new AccountingError("Choose a posted bill of the same supplier.", 400);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"ap-credit:" + cn.supplierId}))`;
    const applied = await tx.apCreditAllocation.aggregate({ where: { creditNoteId: cn.id, active: true }, _sum: { amount: true } });
    const left = dec(cn.totalGross).sub(dec(applied._sum.amount));
    if (amount.gt(left)) throw new AccountingError(`Only ${left.toFixed(2)} of the credit note is left to apply.`, 409);
    const credited = await tx.apCreditAllocation.aggregate({ where: { billId: bill.id, active: true }, _sum: { amount: true } });
    const paid = bill.obligationId ? await tx.bankTransactionMatch.aggregate({ where: { targetType: "OBLIGATION", targetId: bill.obligationId, active: true, transaction: { status: { not: "VOID" } } }, _sum: { amount: true } }) : { _sum: { amount: null } };
    const open = dec(bill.totalGross).sub(dec(credited._sum.amount)).sub(dec(paid._sum.amount));
    if (amount.gt(open)) throw new AccountingError(`The bill has only ${open.toFixed(2)} open.`, 409);
    const row = await tx.apCreditAllocation.create({ data: { creditNoteId: cn.id, billId: bill.id, amount, allocatedOn: body.allocatedOn ? accountingDate(body.allocatedOn) : cn.billDate > bill.billDate ? cn.billDate : bill.billDate, createdBy: userId } });
    await auditAccounting(tx, { action: "bill.credit_allocate", entityType: "bill", entityId: bill.id, userId, after: { creditNoteId: cn.id, amount } });
    return row;
  });
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `payables:${a.id}:ap.credit.allocated` }, select: { id: true } });
  return { allocation: a, ledger: ev ? await processEvent(ev.id) : null };
}

export async function releaseSupplierCredit(id: string, userId: string) {
  const a = await ledgerTx(async (tx) => {
    const r = await tx.apCreditAllocation.updateMany({ where: { id, active: true }, data: { active: false, removedAt: new Date() } });
    if (r.count !== 1) throw new AccountingError("Only an active credit allocation can be released.", 409);
    await auditAccounting(tx, { action: "bill.credit_release", entityType: "bill", entityId: id, userId });
    return tx.apCreditAllocation.findUniqueOrThrow({ where: { id } });
  });
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `payables:${a.id}:ap.credit.released` }, select: { id: true } });
  return { allocation: a, ledger: ev ? await processEvent(ev.id) : null };
}

async function processBillEvent(billId: string, et: string): Promise<ProcessOutcome | null> {
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `payables:${billId}:${et}` }, select: { id: true } });
  return ev ? processEvent(ev.id) : null;
}

export async function updateSupplierTaxData(id: string, body: Record<string, unknown>, userId: string) {
  const vat = body.vatNumber === undefined ? undefined : body.vatNumber === null || body.vatNumber === "" ? null : String(body.vatNumber).trim();
  if (vat && !isKsaVatNumber(vat)) throw new AccountingError("A KSA VAT registration number has 15 digits and starts and ends with 3.", 400);
  const terms = body.paymentTermsDays === undefined ? undefined : Number(body.paymentTermsDays);
  if (terms !== undefined && (!Number.isInteger(terms) || terms < 0 || terms > 365)) throw new AccountingError("Payment terms are 0–365 days.", 400);
  return ledgerTx(async (tx) => {
    const before = await tx.supplier.findUnique({ where: { id } });
    if (!before) throw new AccountingError("Supplier not found.", 404);
    const s = await tx.supplier.update({
      where: { id },
      data: {
        ...(vat !== undefined ? { vatNumber: vat } : {}),
        ...(body.crNumber !== undefined ? { crNumber: body.crNumber ? String(body.crNumber).trim().slice(0, 30) : null } : {}),
        ...(body.address !== undefined ? { address: body.address ? String(body.address).trim().slice(0, 300) : null } : {}),
        ...(terms !== undefined ? { paymentTermsDays: terms } : {}),
        ...(typeof body.active === "boolean" ? { active: body.active } : {}),
      },
    });
    await auditAccounting(tx, { action: "supplier.update", entityType: "supplier", entityId: id, userId, before: { vatNumber: before.vatNumber, terms: before.paymentTermsDays }, after: { vatNumber: s.vatNumber, terms: s.paymentTermsDays } });
    return s;
  });
}

