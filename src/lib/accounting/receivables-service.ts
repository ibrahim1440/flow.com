// Receivables (stage 3): sales invoices and credit notes (four-eyes, database-guarded), customer
// receipts assigned from bank lines, allocation to invoices, customer advances (D-2) and their
// application. Nothing here posts cash: the bank line assigned to the customer does, once
// (translators/bank.ts). Sales collections and commissions are untouched — a collection linked
// to the bank line only proposes the customer and the invoices to settle.
import { Prisma, type SalesInvoiceStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ledgerTx } from "./journal-service";
import { auditAccounting } from "./audit";
import { ZERO, dec } from "./money";
import { accountingDate, todayAccountingDate } from "./dates";
import { resolveRoles } from "./posting";
import { processEvent, type ProcessOutcome } from "./event-processor";
import { isKsaVatNumber } from "./bill-rules";
import { computeSalesLine, vatInside } from "./sales-rules";
import { postedBankLines } from "./bank-posted";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

const FOUR_DP = /^\d{1,14}(\.\d{1,4})?$/;
function num(raw: unknown, field: string, opts: { positive?: boolean; max?: number } = {}): Prisma.Decimal {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.replace(/,/g, "").trim() : "";
  if (!FOUR_DP.test(s)) throw new AccountingError(`${field} must be a number with at most four decimals.`, 400);
  const d = new Prisma.Decimal(s);
  if (opts.positive && d.lte(0)) throw new AccountingError(`${field} must be greater than zero.`, 400);
  if (opts.max !== undefined && d.gt(opts.max)) throw new AccountingError(`${field} must be at most ${opts.max}.`, 400);
  return d;
}
const money2 = (raw: unknown, field: string) => {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.replace(/,/g, "").trim() : "";
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(s)) throw new AccountingError(`${field} must be an amount with at most two decimals.`, 400);
  const d = new Prisma.Decimal(s);
  if (d.lte(0)) throw new AccountingError(`${field} must be greater than zero.`, 400);
  return d;
};

export type SalesLineInput = {
  accountId?: string | null; productSkuId?: string | null; orderItemId?: string | null; description?: string | null;
  quantity: string | number; unitPrice: string | number; discountPercent?: string | number; taxCategoryId?: string | null; costCenterId?: string | null;
};
export type SalesDocInput = {
  customerId: string; issueDate: string; supplyDate?: string | null; dueDate?: string | null; orderId?: string | null;
  branchId?: string | null; description?: string | null; reason?: string | null; lines: SalesLineInput[];
};

async function buildLines(tx: Tx, raw: SalesLineInput[]) {
  if (!Array.isArray(raw) || raw.length === 0) throw new AccountingError("A sales document needs at least one line.", 400);
  if (raw.length > 200) throw new AccountingError("A sales document may have at most 200 lines.", 400);
  const def = (await resolveRoles(tx, ["SALES_REVENUE"])).get("SALES_REVENUE")!;
  const ids = [...new Set(raw.map((l) => l.accountId || def))];
  const accounts = new Map((await tx.account.findMany({ where: { id: { in: ids } }, include: { _count: { select: { children: true } } } })).map((a) => [a.id, a]));
  const taxes = new Map((await tx.taxCategory.findMany({ where: { id: { in: raw.map((l) => l.taxCategoryId).filter(Boolean) as string[] } } })).map((t) => [t.id, t]));
  return raw.map((l, i) => {
    const n = i + 1;
    const a = accounts.get(l.accountId || def);
    if (!a) throw new AccountingError(`Line ${n}: choose a revenue account.`, 400);
    if (!a.isActive || !a.allowPosting || a._count.children > 0) throw new AccountingError(`Line ${n}: account ${a.code} cannot receive postings.`, 400);
    if (a.type !== "REVENUE" || a.controlKind !== "NONE") throw new AccountingError(`Line ${n}: a sales line credits a revenue account (${a.code} is not one).`, 400);
    const quantity = num(l.quantity, `Line ${n} quantity`, { positive: true });
    const unitPrice = num(l.unitPrice, `Line ${n} unit price`);
    const discountPercent = l.discountPercent === undefined || l.discountPercent === "" ? ZERO : num(l.discountPercent, `Line ${n} discount`, { max: 100 });
    let rate = ZERO; let taxCategoryId: string | null = null;
    if (l.taxCategoryId) {
      const t = taxes.get(l.taxCategoryId);
      if (!t || !t.isActive) throw new AccountingError(`Line ${n}: the tax category is unknown or inactive.`, 400);
      rate = dec(t.rate); taxCategoryId = t.id;
    }
    const { net, vat, gross } = computeSalesLine(quantity, unitPrice, discountPercent, rate);
    const description = typeof l.description === "string" ? l.description.trim().slice(0, 300) || null : null;
    return { lineNo: n, accountId: a.id, productSkuId: l.productSkuId || null, orderItemId: l.orderItemId || null, description, quantity, unitPrice, discountPercent, net, taxCategoryId, vatRate: rate, vat, gross, costCenterId: l.costCenterId || null };
  });
}

async function header(tx: Tx, input: SalesDocInput, invoiceFor?: { selfId?: string }) {
  const customer = await tx.customer.findUnique({ where: { id: String(input.customerId ?? "") } });
  if (!customer) throw new AccountingError("Choose a customer.", 400);
  const issueDate = accountingDate(input.issueDate);
  const dueDate = input.dueDate ? accountingDate(input.dueDate) : new Date(issueDate.getTime() + customer.paymentTermsDays * 86_400_000);
  if (dueDate < issueDate) throw new AccountingError("The due date cannot be before the issue date.", 400);
  if (input.orderId) {
    const o = await tx.order.findUnique({ where: { id: input.orderId } });
    if (!o) throw new AccountingError("Order not found.", 404);
    if (o.customerId !== customer.id) throw new AccountingError("The order belongs to another customer.", 400);
    if (invoiceFor) {
      const live = await tx.salesInvoice.findFirst({ where: { orderId: o.id, kind: "INVOICE", status: { not: "REVERSED" }, ...(invoiceFor.selfId ? { id: { not: invoiceFor.selfId } } : {}) } });
      if (live) throw new AccountingError(`This order already has an invoice that is not reversed (INV-${live.invoiceNo}).`, 409);
    }
  }
  return {
    customer, data: {
      customerId: customer.id, issueDate, dueDate, supplyDate: input.supplyDate ? accountingDate(input.supplyDate) : null,
      orderId: input.orderId || null, branchId: input.branchId || null, description: input.description?.trim().slice(0, 500) || null,
    },
  };
}

const totals = (lines: { net: Prisma.Decimal; vat: Prisma.Decimal; gross: Prisma.Decimal }[]) => ({
  totalNet: lines.reduce((s, l) => s.add(l.net), ZERO), totalVat: lines.reduce((s, l) => s.add(l.vat), ZERO), totalGross: lines.reduce((s, l) => s.add(l.gross), ZERO),
});

/** Gross still creditable on an invoice: total less posted and pending credit notes. */
async function creditable(db: Db, invoiceId: string, exceptId?: string) {
  const inv = await db.salesInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new AccountingError("Invoice not found.", 404);
  const used = await db.salesInvoice.aggregate({ where: { originalInvoiceId: invoiceId, status: { in: ["DRAFT", "SUBMITTED", "APPROVED", "POSTED"] }, ...(exceptId ? { id: { not: exceptId } } : {}) }, _sum: { totalGross: true } });
  return { inv, remaining: dec(inv.totalGross).sub(dec(used._sum.totalGross)) };
}

export async function createSalesDoc(input: SalesDocInput & { kind?: "INVOICE" | "CREDIT_NOTE"; originalInvoiceId?: string | null }, userId: string) {
  return ledgerTx(async (tx) => {
    const kind = input.kind === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE";
    const { data } = await header(tx, input, kind === "INVOICE" ? {} : undefined);
    const lines = await buildLines(tx, input.lines);
    let originalInvoiceId: string | null = null;
    let reason: string | null = null;
    if (kind === "CREDIT_NOTE") {
      if (!input.originalInvoiceId) throw new AccountingError("A credit note names the invoice it credits.", 400);
      const { inv, remaining } = await creditable(tx, input.originalInvoiceId);
      if (inv.kind !== "INVOICE" || inv.status !== "POSTED") throw new AccountingError("A credit note credits a posted invoice.", 409);
      if (inv.customerId !== data.customerId) throw new AccountingError("The credit note must be for the invoice's customer.", 400);
      if (totals(lines).totalGross.gt(remaining)) throw new AccountingError(`The credit note exceeds what is left to credit on the invoice (${remaining.toFixed(2)}).`, 400);
      reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
      if (!reason || reason.length < 5) throw new AccountingError("A credit note needs a reason (at least 5 characters).", 400);
      originalInvoiceId = inv.id;
      data.orderId = inv.orderId;
    }
    const doc = await tx.salesInvoice.create({ data: { ...data, kind, originalInvoiceId, reason, ...totals(lines), createdBy: userId, lines: { create: lines } }, include: { lines: true } });
    await auditAccounting(tx, { action: `${kind === "INVOICE" ? "invoice" : "credit_note"}.create`, entityType: "sales_document", entityId: doc.id, userId, after: { no: doc.invoiceNo, gross: doc.totalGross } });
    return doc;
  }).catch(uniqueOrder);
}

function uniqueOrder(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new AccountingError("This order already has an invoice that is not reversed.", 409);
  throw e;
}

export async function updateDraftSalesDoc(id: string, input: SalesDocInput, userId: string) {
  return ledgerTx(async (tx) => {
    const d = await tx.salesInvoice.findUnique({ where: { id } });
    if (!d) throw new AccountingError("Document not found.", 404);
    if (d.status !== "DRAFT") throw new AccountingError("Only a draft can be edited.", 409);
    const { data } = await header(tx, { ...input, orderId: d.kind === "CREDIT_NOTE" ? d.orderId : input.orderId }, d.kind === "INVOICE" ? { selfId: d.id } : undefined);
    const lines = await buildLines(tx, input.lines);
    if (d.kind === "CREDIT_NOTE") {
      if (data.customerId !== d.customerId) throw new AccountingError("A credit note stays with the invoice's customer.", 400);
      const { remaining } = await creditable(tx, d.originalInvoiceId!, d.id);
      if (totals(lines).totalGross.gt(remaining)) throw new AccountingError(`The credit note exceeds what is left to credit on the invoice (${remaining.toFixed(2)}).`, 400);
    }
    await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: id } });
    const doc = await tx.salesInvoice.update({ where: { id }, data: { ...data, ...totals(lines), ...(d.kind === "CREDIT_NOTE" && input.reason ? { reason: String(input.reason).trim().slice(0, 300) } : {}), lines: { create: lines } }, include: { lines: true } });
    await auditAccounting(tx, { action: "sales_document.update", entityType: "sales_document", entityId: id, userId, before: { gross: d.totalGross }, after: { gross: doc.totalGross } });
    return doc;
  }).catch(uniqueOrder);
}

export async function deleteDraftSalesDoc(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const d = await tx.salesInvoice.findUnique({ where: { id } });
    if (!d) throw new AccountingError("Document not found.", 404);
    if (d.status !== "DRAFT") throw new AccountingError("Only a draft can be deleted.", 409);
    await tx.salesInvoice.delete({ where: { id } });
    await auditAccounting(tx, { action: "sales_document.delete", entityType: "sales_document", entityId: id, userId, before: { no: d.invoiceNo } });
    return { deleted: true };
  });
}

async function transition(tx: Tx, id: string, from: SalesInvoiceStatus[], to: SalesInvoiceStatus, data: Prisma.SalesInvoiceUpdateManyMutationInput) {
  const r = await tx.salesInvoice.updateMany({ where: { id, status: { in: from } }, data: { ...data, status: to } });
  if (r.count !== 1) throw new AccountingError(`The document is no longer ${from.join(" or ").toLowerCase()}; refresh and try again.`, 409);
  return tx.salesInvoice.findUniqueOrThrow({ where: { id }, include: { lines: true, customer: true } });
}

export async function submitSalesDoc(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const d = await transition(tx, id, ["DRAFT"], "SUBMITTED", { submittedAt: new Date(), submittedBy: userId, rejectedAt: null, rejectedBy: null, rejectedReason: null });
    await auditAccounting(tx, { action: "sales_document.submit", entityType: "sales_document", entityId: id, userId });
    return d;
  });
}

export async function approveSalesDoc(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const d = await tx.salesInvoice.findUnique({ where: { id } });
    if (!d) throw new AccountingError("Document not found.", 404);
    if (d.createdBy === userId || d.submittedBy === userId) throw new AccountingError("You prepared or submitted this document; someone else must approve it.", 403);
    const doc = await transition(tx, id, ["SUBMITTED"], "APPROVED", { approvedAt: new Date(), approvedBy: userId });
    await auditAccounting(tx, { action: "sales_document.approve", entityType: "sales_document", entityId: id, userId });
    return doc;
  });
}

export async function rejectSalesDoc(id: string, userId: string, reason: string) {
  const why = reason?.trim();
  if (!why || why.length < 5) throw new AccountingError("A rejection needs a reason (at least 5 characters).", 400);
  return ledgerTx(async (tx) => {
    const d = await tx.salesInvoice.findUnique({ where: { id } });
    if (!d) throw new AccountingError("Document not found.", 404);
    if (d.createdBy === userId) throw new AccountingError("You prepared this document; edit or delete it instead of rejecting it.", 403);
    const doc = await transition(tx, id, ["SUBMITTED"], "DRAFT", { rejectedAt: new Date(), rejectedBy: userId, rejectedReason: why, submittedAt: null, submittedBy: null });
    await auditAccounting(tx, { action: "sales_document.reject", entityType: "sales_document", entityId: id, userId, reason: why });
    return doc;
  });
}

export type SalesPostOutcome = { document: Awaited<ReturnType<typeof transition>>; ledger: ProcessOutcome | null };

export async function postSalesDoc(id: string, userId: string): Promise<SalesPostOutcome> {
  const document = await ledgerTx(async (tx) => {
    const d = await tx.salesInvoice.findUnique({ where: { id } });
    if (!d) throw new AccountingError("Document not found.", 404);
    if (d.status !== "APPROVED") throw new AccountingError("Only an approved document can be posted.", 409);
    const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: d.issueDate }, endDate: { gte: d.issueDate } } });
    if (!period) throw new AccountingError("No fiscal period covers the issue date.", 409);
    if (period.status !== "OPEN") throw new AccountingError(`The period of the issue date is ${period.status.toLowerCase()}; documents post only into open periods.`, 409);
    const posted = await transition(tx, id, ["APPROVED"], "POSTED", { postedAt: new Date(), postedBy: userId });
    if (d.kind === "CREDIT_NOTE") {
      // The credit settles its invoice first; any rest stays as the customer's unapplied credit.
      const open = await invoiceOpen(tx, d.originalInvoiceId!);
      const amt = Prisma.Decimal.min(open, posted.totalGross);
      if (amt.gt(0)) await tx.arAllocation.create({ data: { invoiceId: d.originalInvoiceId!, creditNoteId: d.id, amount: amt, allocatedOn: d.issueDate, createdBy: userId } });
    } else if (d.orderId) {
      await tx.order.update({ where: { id: d.orderId }, data: { vatInvoiceStatus: "Sent" } });
    }
    await auditAccounting(tx, { action: "sales_document.post", entityType: "sales_document", entityId: id, userId });
    return posted;
  });
  return { document, ledger: await processDocEvent(document.id, document.kind === "CREDIT_NOTE" ? "ar.credit_note.posted" : "ar.invoice.posted") };
}

export async function reverseSalesDoc(id: string, userId: string, reason: string): Promise<SalesPostOutcome> {
  const why = reason?.trim();
  if (!why || why.length < 5) throw new AccountingError("A reversal needs a reason (at least 5 characters).", 400);
  const document = await ledgerTx(async (tx) => {
    const d = await tx.salesInvoice.findUnique({ where: { id } });
    if (!d) throw new AccountingError("Document not found.", 404);
    if (d.status !== "POSTED") throw new AccountingError("Only a posted document can be reversed.", 409);
    if (d.kind === "CREDIT_NOTE") {
      // A credit note's own allocations are released with it (re-applications post their mirror).
      await tx.arAllocation.updateMany({ where: { creditNoteId: d.id, active: true }, data: { active: false, removedAt: new Date() } });
    } else {
      const alloc = await tx.arAllocation.count({ where: { invoiceId: d.id, active: true } });
      if (alloc) throw new AccountingError("Receipts, credits or advances are allocated to this invoice; release them or issue a credit note instead.", 409);
    }
    const reversed = await transition(tx, id, ["POSTED"], "REVERSED", { reversedAt: new Date(), reversedBy: userId, reversalReason: why });
    if (d.kind === "INVOICE" && d.orderId) await tx.order.update({ where: { id: d.orderId }, data: { vatInvoiceStatus: "Not Yet" } });
    await auditAccounting(tx, { action: "sales_document.reverse", entityType: "sales_document", entityId: id, userId, reason: why });
    return reversed;
  });
  const ledger = await processDocEvent(document.id, document.kind === "CREDIT_NOTE" ? "ar.credit_note.reversed" : "ar.invoice.reversed");
  if (document.kind === "CREDIT_NOTE") {
    const released = await prisma.accountingEvent.findMany({ where: { eventType: "ar.credit.released", status: "PENDING", partyKey: `CUSTOMER:${document.customerId}` }, orderBy: { createdAt: "asc" }, select: { id: true } });
    for (const e of released) await processEvent(e.id);
  }
  return { document, ledger };
}

async function processDocEvent(docId: string, et: string): Promise<ProcessOutcome | null> {
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `receivables:${docId}:${et}` }, select: { id: true } });
  return ev ? processEvent(ev.id) : null;
}

// ─── Open amounts ───────────────────────────────────────────────────────────────

/** What a posted invoice is still owed (active allocations only). */
export async function invoiceOpen(db: Db, invoiceId: string) {
  const inv = await db.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const used = await db.arAllocation.aggregate({ where: { invoiceId, active: true }, _sum: { amount: true } });
  return dec(inv.totalGross).sub(dec(used._sum.amount));
}

/**
 * What customers owe on invoices, as the ledger sees it: an allocation from a receipt counts only
 * once its bank line has posted (as in the aging). `awaiting` is the part allocated from receipts
 * whose bank line has not posted yet — reserved against over-allocation, but still owed.
 */
export async function invoiceBalances(db: Db, invoiceIds: string[]) {
  const allocs = await db.arAllocation.findMany({ where: { invoiceId: { in: invoiceIds }, active: true }, select: { invoiceId: true, amount: true, receipt: { select: { bankTransactionId: true } } } });
  const posted = await postedBankLines(db, allocs.flatMap((a) => (a.receipt ? [a.receipt.bankTransactionId] : [])));
  const out = new Map<string, { settled: Prisma.Decimal; awaiting: Prisma.Decimal }>();
  for (const a of allocs) {
    const e = out.get(a.invoiceId) ?? { settled: ZERO, awaiting: ZERO };
    if (a.receipt && !posted.has(a.receipt.bankTransactionId)) e.awaiting = e.awaiting.add(a.amount); else e.settled = e.settled.add(a.amount);
    out.set(a.invoiceId, e);
  }
  return out;
}

/** Open posted invoices of a customer, oldest due first. */
export async function openInvoices(db: Db, customerId: string) {
  const invs = await db.salesInvoice.findMany({ where: { customerId, kind: "INVOICE", status: "POSTED" }, orderBy: [{ dueDate: "asc" }, { invoiceNo: "asc" }] });
  const used = await db.arAllocation.groupBy({ by: ["invoiceId"], where: { invoiceId: { in: invs.map((i) => i.id) }, active: true }, _sum: { amount: true } });
  const u = new Map(used.map((x) => [x.invoiceId, dec(x._sum.amount)]));
  return invs.map((i) => ({ id: i.id, invoiceNo: i.invoiceNo, issueDate: i.issueDate, dueDate: i.dueDate, orderId: i.orderId, gross: dec(i.totalGross), open: dec(i.totalGross).sub(u.get(i.id) ?? ZERO) })).filter((i) => i.open.gt(0));
}

/** A customer's advance still to apply (from posted receipt lines), and the VAT inside it. */
export async function advanceBalance(db: Db, customerId: string) {
  const receipts = await db.customerReceipt.findMany({ where: { customerId, voided: false } });
  const posted = await postedBankLines(db, receipts.map((r) => r.bankTransactionId));
  const rec = receipts.filter((r) => posted.has(r.bankTransactionId));
  const apps = await db.advanceApplication.aggregate({ where: { customerId, status: "POSTED" }, _sum: { amount: true, vatPortion: true } });
  const amount = rec.reduce((s, r) => s.add(r.advanceAmount), ZERO).sub(dec(apps._sum.amount));
  const vat = rec.reduce((s, r) => s.add(r.advanceVat), ZERO).sub(dec(apps._sum.vatPortion));
  return { amount, vat };
}

async function defaultVatRate(db: Db) {
  const t = await db.taxCategory.findFirst({ where: { isDefault: true, isActive: true } });
  return t ? dec(t.rate) : new Prisma.Decimal(15);
}

// ─── Receipts: assign a customer bank line ─────────────────────────────────────

export async function assignReceipt(bankTransactionId: string, body: { customerId?: unknown; allocations?: unknown; salesCollectionId?: unknown }, userId: string) {
  const out = await ledgerTx(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "BankTransaction" WHERE "id" = ${bankTransactionId} FOR UPDATE`;
    const t = await tx.bankTransaction.findUnique({ where: { id: bankTransactionId }, include: { matches: { where: { active: true, targetType: "SALES_COLLECTION" } } } });
    if (!t) throw new AccountingError("Bank line not found.", 404);
    if (t.status === "VOID") throw new AccountingError("The line is void.", 409);
    if (!["CUSTOMER_RECEIPT", "CUSTOMER_REFUND"].includes(t.classification)) throw new AccountingError("Only lines classified as a customer receipt or refund are assigned to customers.", 409);
    if ((await postedBankLines(tx, [t.id])).size) throw new AccountingError("This line has posted; correct it through Accounting → Bank corrections.", 409);
    const amount = dec(t.amount);

    // A sales collection linked in Finance names the customer (and cannot be contradicted).
    const linkedCollection = t.matches[0]?.targetId ?? null;
    const salesCollectionId = typeof body.salesCollectionId === "string" && body.salesCollectionId ? body.salesCollectionId : linkedCollection;
    let customerId = typeof body.customerId === "string" ? body.customerId : "";
    if (salesCollectionId) {
      // Serialise claims on the collection so a concurrent claim sees the first one committed.
      await tx.$queryRaw`SELECT 1 FROM "SalesCollection" WHERE "id" = ${salesCollectionId} FOR UPDATE`;
      const c = await tx.salesCollection.findUnique({ where: { id: salesCollectionId } });
      if (!c) throw new AccountingError("Sales collection not found.", 404);
      if (c.status !== "APPROVED") throw new AccountingError("Only a finance-verified (approved) sales collection can name the customer.", 409);
      if (linkedCollection && linkedCollection !== c.id) throw new AccountingError("The bank line is linked to another sales collection in Finance.", 409);
      if (c.customerId) { if (customerId && customerId !== c.customerId) throw new AccountingError("The customer differs from the sales collection's customer.", 400); customerId = c.customerId; }
      const taken = await tx.customerReceipt.findFirst({ where: { salesCollectionId: c.id, bankTransactionId: { not: t.id }, voided: false } });
      if (taken) throw new AccountingError(`That sales collection is already assigned to receipt ${taken.receiptNo}.`, 409);
    }
    const customer = customerId ? await tx.customer.findUnique({ where: { id: customerId } }) : null;
    if (!customer) throw new AccountingError("Choose the customer.", 400);

    const allocIn = Array.isArray(body.allocations) ? body.allocations as Record<string, unknown>[] : [];
    const allocations = allocIn.map((a, i) => ({ invoiceId: String(a.invoiceId ?? ""), amount: money2(a.amount, `Allocation ${i + 1}`) }));
    if (amount.isNegative() && allocations.length) throw new AccountingError("A refund is not allocated to invoices.", 400);
    const arPart = allocations.reduce((s, a) => s.add(a.amount), ZERO);
    if (arPart.gt(amount.abs())) throw new AccountingError("Allocations exceed the receipt.", 400);
    const open = new Map((await openInvoices(tx, customer.id)).map((i) => [i.id, i]));
    for (const a of allocations) {
      const inv = open.get(a.invoiceId);
      if (!inv) throw new AccountingError("An allocation names an invoice that is not an open posted invoice of this customer.", 400);
      if (a.amount.gt(inv.open)) throw new AccountingError(`INV-${inv.invoiceNo} is owed only ${inv.open.toFixed(2)}.`, 400);
    }

    let arAmount: Prisma.Decimal, advanceAmount: Prisma.Decimal, advanceVat = ZERO;
    const settings = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { advanceVatTreatment: true } });
    // Undecided D-2 falls back to the recommended treatment (VAT at receipt); such postings are
    // provisional in an isolated test database and wait for the decision everywhere else.
    const vatAtReceipt = settings?.advanceVatTreatment !== "NOT_AT_RECEIPT";
    const rate = await defaultVatRate(tx);
    if (amount.isPositive()) {
      arAmount = arPart; advanceAmount = amount.sub(arPart);
      if (vatAtReceipt) advanceVat = vatInside(advanceAmount, rate);
    } else {
      // A refund returns the customer's advance first, then any credit left on account.
      const bal = await advanceBalance(tx, customer.id);
      const fromAdvance = Prisma.Decimal.min(bal.amount.gt(0) ? bal.amount : ZERO, amount.abs());
      advanceAmount = fromAdvance.neg(); arAmount = amount.sub(advanceAmount);
      if (fromAdvance.gt(0) && bal.amount.gt(0)) advanceVat = bal.vat.mul(fromAdvance).div(bal.amount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).neg();
    }

    const existing = await tx.customerReceipt.findUnique({ where: { bankTransactionId: t.id } });
    if (existing) await tx.arAllocation.updateMany({ where: { receiptId: existing.id, active: true }, data: { active: false, removedAt: new Date() } });
    const data = { customerId: customer.id, salesCollectionId, amount, arAmount, advanceAmount, advanceVat, voided: false };
    const r = existing ? await tx.customerReceipt.update({ where: { id: existing.id }, data }) : await tx.customerReceipt.create({ data: { ...data, bankTransactionId: t.id, createdBy: userId } });
    for (const a of allocations) await tx.arAllocation.create({ data: { invoiceId: a.invoiceId, receiptId: r.id, amount: a.amount, allocatedOn: t.txnDate, createdBy: userId } });
    await auditAccounting(tx, { action: existing ? "receipt.reassign" : "receipt.assign", entityType: "customer_receipt", entityId: r.id, userId, before: existing ?? undefined, after: r, refs: { bankTransactionId: t.id, allocations } });
    return r;
  }).catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new AccountingError("That sales collection is already assigned to another receipt.", 409);
    throw e;
  });
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `bank:${bankTransactionId}:confirmed` }, select: { id: true } });
  return { receipt: out, ledger: ev ? await processEvent(ev.id) : null };
}

/** Called when a bank line is voided (Finance void of an unposted line, or an approved correction). */
export async function releaseCustomerReceipt(tx: Tx, bankTransactionId: string) {
  const r = await tx.customerReceipt.findUnique({ where: { bankTransactionId } });
  if (!r || r.voided) return;
  await tx.arAllocation.updateMany({ where: { receiptId: r.id, active: true }, data: { active: false, removedAt: new Date() } });
  await tx.customerReceipt.update({ where: { id: r.id }, data: { voided: true, salesCollectionId: null } });   // the collection may be assigned to the corrected line
}

// ─── Advances and credits ───────────────────────────────────────────────────────

export async function applyAdvance(body: { invoiceId?: unknown; amount?: unknown; appliedOn?: unknown }, userId: string) {
  const app = await ledgerTx(async (tx) => {
    const inv = await tx.salesInvoice.findUnique({ where: { id: String(body.invoiceId ?? "") } });
    if (!inv || inv.kind !== "INVOICE" || inv.status !== "POSTED") throw new AccountingError("Choose a posted invoice.", 400);
    await tx.$queryRaw`SELECT 1 FROM "Customer" WHERE "id" = ${inv.customerId} FOR UPDATE`;   // one application per customer at a time
    const amount = money2(body.amount, "Amount");
    const appliedOn = body.appliedOn ? accountingDate(body.appliedOn) : todayAccountingDate();
    const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: appliedOn }, endDate: { gte: appliedOn } } });
    if (!period || period.status !== "OPEN") throw new AccountingError("The application date must be in an open period.", 409);
    const bal = await advanceBalance(tx, inv.customerId);
    if (amount.gt(bal.amount)) throw new AccountingError(`The customer's advance is ${bal.amount.toFixed(2)}.`, 409);
    const open = await invoiceOpen(tx, inv.id);
    if (amount.gt(open)) throw new AccountingError(`The invoice is owed ${open.toFixed(2)}.`, 409);
    const vatPortion = bal.amount.isZero() ? ZERO : bal.vat.mul(amount).div(bal.amount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const a = await tx.advanceApplication.create({ data: { customerId: inv.customerId, invoiceId: inv.id, amount, vatPortion, appliedOn, createdBy: userId } });
    await tx.arAllocation.create({ data: { invoiceId: inv.id, applicationId: a.id, amount, allocatedOn: appliedOn, createdBy: userId } });
    await auditAccounting(tx, { action: "advance.apply", entityType: "advance_application", entityId: a.id, userId, after: a });
    return a;
  });
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `receivables:${app.id}:ar.advance.applied` }, select: { id: true } });
  return { application: app, ledger: ev ? await processEvent(ev.id) : null };
}

export async function reverseAdvanceApplication(id: string, userId: string, reason: string) {
  const why = reason?.trim();
  if (!why || why.length < 5) throw new AccountingError("A reversal needs a reason (at least 5 characters).", 400);
  const a = await ledgerTx(async (tx) => {
    const r = await tx.advanceApplication.updateMany({ where: { id, status: "POSTED" }, data: { status: "REVERSED", reversedAt: new Date(), reversedBy: userId, reversalReason: why } });
    if (r.count !== 1) throw new AccountingError("This application is no longer posted.", 409);
    await tx.arAllocation.updateMany({ where: { applicationId: id, active: true }, data: { active: false, removedAt: new Date() } });
    const after = await tx.advanceApplication.findUniqueOrThrow({ where: { id } });
    await auditAccounting(tx, { action: "advance.reverse", entityType: "advance_application", entityId: id, userId, reason: why });
    return after;
  });
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `receivables:${id}:ar.advance.reversed` }, select: { id: true } });
  return { application: a, ledger: ev ? await processEvent(ev.id) : null };
}

/**
 * Use a credit note's unapplied balance against another open invoice of the same customer. It
 * posts a reclassification inside the receivables account (credit note → invoice, net zero), so
 * the ledger alone shows which invoice is open on any date.
 */
export async function allocateCredit(body: { creditNoteId?: unknown; invoiceId?: unknown; amount?: unknown }, userId: string) {
  const alloc = await ledgerTx(async (tx) => {
    const cn = await tx.salesInvoice.findUnique({ where: { id: String(body.creditNoteId ?? "") } });
    if (!cn || cn.kind !== "CREDIT_NOTE" || cn.status !== "POSTED") throw new AccountingError("Choose a posted credit note.", 400);
    await tx.$queryRaw`SELECT 1 FROM "SalesInvoice" WHERE "id" = ${cn.id} FOR UPDATE`;
    const cnEvent = await tx.accountingEvent.findUnique({ where: { idempotencyKey: `receivables:${cn.id}:ar.credit_note.posted` }, select: { status: true } });
    if (cnEvent?.status !== "TRANSLATED") throw new AccountingError("The credit note is not in the ledger yet; its credit can be applied once its journal has posted.", 409);
    const amount = money2(body.amount, "Amount");
    const used = await tx.arAllocation.aggregate({ where: { creditNoteId: cn.id, active: true }, _sum: { amount: true } });
    const left = dec(cn.totalGross).sub(dec(used._sum.amount));
    if (amount.gt(left)) throw new AccountingError(`The credit note has ${left.toFixed(2)} left.`, 409);
    const invoiceId = String(body.invoiceId ?? "");
    const open = await invoiceOpen(tx, invoiceId).catch(() => { throw new AccountingError("Invoice not found.", 404); });
    if (amount.gt(open)) throw new AccountingError(`The invoice is owed ${open.toFixed(2)}.`, 409);
    const a = await tx.arAllocation.create({ data: { invoiceId, creditNoteId: cn.id, amount, allocatedOn: todayAccountingDate(), isReallocation: true, createdBy: userId } });
    await auditAccounting(tx, { action: "credit.allocate", entityType: "sales_document", entityId: cn.id, userId, after: a });
    return a;
  });
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `receivables:${alloc.id}:ar.credit.allocated` }, select: { id: true } });
  return { ...alloc, ledger: ev ? await processEvent(ev.id) : null };
}

// ─── Order → invoice draft ─────────────────────────────────────────────────────

/** Lines for an invoice of an order: prices from the order's accepted quote, else the SKU price. */
export async function invoiceDraftFromOrder(orderId: string) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { customer: true, items: { include: { productSku: true } }, opportunityLinks: { include: { quote: { include: { lines: true } } } } } });
  if (!o) throw new AccountingError("Order not found.", 404);
  const live = await prisma.salesInvoice.findFirst({ where: { orderId, kind: "INVOICE", status: { not: "REVERSED" } } });
  const quote = o.opportunityLinks.map((l) => l.quote).find((q) => q?.status === "ACCEPTED") ?? null;
  const tax = await prisma.taxCategory.findFirst({ where: { isDefault: true, isActive: true } });
  const lines = o.items.map((it) => {
    const ql = quote?.lines.find((l) => l.productSkuId && l.productSkuId === it.productSkuId);
    const qty = it.quantityUnits != null ? (it.deliveredUnits || it.quantityUnits) : it.deliveredQty || it.quantityKg;
    return {
      orderItemId: it.id, productSkuId: it.productSkuId, description: it.productSku?.nameAr ?? it.productSku?.name ?? it.beanTypeName,
      quantity: String(qty), unitPrice: ql ? ql.unitPrice.toFixed(2) : (it.productSku?.price ?? 0).toFixed(2),
      discountPercent: ql ? ql.discountPercent.toFixed(2) : "0", taxCategoryId: tax?.id ?? null, priceSource: ql ? "QUOTE" : "SKU",
    };
  });
  return { order: { id: o.id, orderNumber: o.orderNumber, status: o.status, customerId: o.customerId, customer: o.customer.nameAr ?? o.customer.name }, quote: quote ? { id: quote.id, number: quote.quoteNumber } : null, existingInvoice: live ? { id: live.id, invoiceNo: live.invoiceNo, status: live.status } : null, lines };
}

// ─── Customers ──────────────────────────────────────────────────────────────────

export async function updateCustomerTaxData(id: string, body: Record<string, unknown>, userId: string) {
  const vat = body.vatNumber === undefined ? undefined : body.vatNumber === null || body.vatNumber === "" ? null : String(body.vatNumber).trim();
  if (vat && !isKsaVatNumber(vat)) throw new AccountingError("A KSA VAT registration number has 15 digits and starts and ends with 3.", 400);
  const terms = body.paymentTermsDays === undefined ? undefined : Number(body.paymentTermsDays);
  if (terms !== undefined && (!Number.isInteger(terms) || terms < 0 || terms > 365)) throw new AccountingError("Payment terms are 0–365 days.", 400);
  const limit = body.creditLimit === undefined ? undefined : body.creditLimit === null || body.creditLimit === "" ? null : money2(body.creditLimit, "Credit limit");
  return ledgerTx(async (tx) => {
    const before = await tx.customer.findUnique({ where: { id } });
    if (!before) throw new AccountingError("Customer not found.", 404);
    const c = await tx.customer.update({ where: { id }, data: {
      ...(vat !== undefined ? { vatNumber: vat } : {}),
      ...(body.crNumber !== undefined ? { crNumber: body.crNumber ? String(body.crNumber).trim().slice(0, 30) : null } : {}),
      ...(terms !== undefined ? { paymentTermsDays: terms } : {}),
      ...(limit !== undefined ? { creditLimit: limit } : {}),
    } });
    await auditAccounting(tx, { action: "customer.tax_data", entityType: "customer", entityId: id, userId, before: { vatNumber: before.vatNumber, terms: before.paymentTermsDays, limit: before.creditLimit }, after: { vatNumber: c.vatNumber, terms: c.paymentTermsDays, limit: c.creditLimit } });
    return c;
  });
}
