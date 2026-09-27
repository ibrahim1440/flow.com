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
import { ZERO, dec, round2 } from "./money";
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
};
export type BillInput = {
  supplierId: string; supplierInvoiceNo: string; billDate: string; dueDate?: string | null;
  branchId?: string | null; description?: string | null; purchaseObligationId?: string | null; lines: BillLineInput[];
};

async function buildLines(tx: Tx, raw: BillLineInput[]) {
  if (!Array.isArray(raw) || raw.length === 0) throw new AccountingError("A bill needs at least one line.", 400);
  if (raw.length > 200) throw new AccountingError("A bill may have at most 200 lines.", 400);
  const needsGrni = raw.some((l) => l.kind === "STOCK_RECEIPT");
  const grni = needsGrni ? (await resolveRoles(tx, ["GRNI"])).get("GRNI")! : null;
  const accountIds = [...new Set(raw.filter((l) => l.kind !== "STOCK_RECEIPT").map((l) => l.accountId).filter(Boolean) as string[])];
  const accounts = await tx.account.findMany({ where: { id: { in: accountIds } }, include: { _count: { select: { children: true } } } });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const taxIds = [...new Set(raw.map((l) => l.taxCategoryId).filter(Boolean) as string[])];
  const taxes = await tx.taxCategory.findMany({ where: { id: { in: taxIds } } });
  const taxById = new Map(taxes.map((t) => [t.id, t]));
  return raw.map((l, i) => {
    const n = i + 1;
    const kind: BillLineKind = l.kind === "STOCK_RECEIPT" ? "STOCK_RECEIPT" : "EXPENSE";
    let accountId: string;
    if (kind === "STOCK_RECEIPT") accountId = grni!;
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
    return { lineNo: n, kind, accountId, description, quantity, unitPrice, net, taxCategoryId, vatRate: rate, vat, gross, costCenterId: l.costCenterId || null };
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

export async function createBill(input: BillInput, userId: string) {
  return ledgerTx(async (tx) => {
    const { data } = await header(tx, input);
    const lines = await buildLines(tx, input.lines);
    const bill = await tx.supplierBill.create({ data: { ...data, ...totals(lines), createdBy: userId, lines: { create: lines } }, include: { lines: true } });
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
    const lines = await buildLines(tx, input.lines);
    await tx.supplierBillLine.deleteMany({ where: { billId: id } });
    const bill = await tx.supplierBill.update({ where: { id }, data: { ...data, ...totals(lines), lines: { create: lines } }, include: { lines: true } });
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
  return { bill, ledger: await processBillEvent(bill.id, "ap.bill.posted") };
}

export async function reverseBill(id: string, userId: string, reason: string): Promise<PostOutcome> {
  const why = reason?.trim();
  if (!why || why.length < 5) throw new AccountingError("A reversal needs a reason (at least 5 characters).", 400);
  const bill = await ledgerTx(async (tx) => {
    const b = await tx.supplierBill.findUnique({ where: { id } });
    if (!b) throw new AccountingError("Bill not found.", 404);
    if (b.status !== "POSTED") throw new AccountingError("Only a posted bill can be reversed.", 409);
    if (b.obligationId) {
      const paid = await tx.bankTransactionMatch.aggregate({ where: { targetType: "OBLIGATION", targetId: b.obligationId, active: true, transaction: { status: { not: "VOID" } } }, _sum: { amount: true } });
      if (dec(paid._sum.amount).gt(0)) throw new AccountingError("Payments are matched to this bill; unmatch them before reversing it.", 409);
      await tx.finObligation.update({ where: { id: b.obligationId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: userId, cancelReason: `Supplier bill reversed: ${why}` } });
    }
    const reversed = await transition(tx, id, ["POSTED"], "REVERSED", { reversedAt: new Date(), reversedBy: userId, reversalReason: why });
    await auditAccounting(tx, { action: "bill.reverse", entityType: "bill", entityId: id, userId, reason: why });
    return reversed;
  });
  return { bill, ledger: await processBillEvent(bill.id, "ap.bill.reversed") };
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

