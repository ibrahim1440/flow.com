// Accounting A3 — the minimal AP sub-ledger (no supplier invoice / AP model existed: PurchaseRecord is a receipt
// register, FinObligation a cash-planning forecast). Figma ACC-50 / 51 / 52 / 53 / 113.
//
//   SupplierInvoice  DRAFT → SUBMITTED → POSTED → (CANCELLED: reversed, only while unpaid)
//     posting (approve = post, by an AP holder other than its preparer / submitter — SIMPLE MODE excepted):
//       Dr GRNI (party = supplier) the matched receipts' values   · GRN lines
//       Dr INVENTORY_* / INVENTORY_VARIANCE the price variance     · capitalised while the stock is on hand
//       Dr INVENTORY_* stock lines without a costed receipt       · capitalised into the holder (rest → variance)
//       Dr <category account> expense lines                      · ExpenseCategory → account (never a hard-coded code)
//       Dr VAT_INPUT the VAT (per line)
//       Cr AP (party = supplier) the gross                        — `purchasing · SUPPLIER_INVOICE · POSTED`
//   SupplierPayment  POSTED → VOIDED; applied in full to the supplier's posted invoices
//       Dr AP (party) / Cr BANK (CASH for a cash payment)         — `purchasing · SUPPLIER_PAYMENT · PAID`
// The documents are the operational sub-ledger (open items, aging); the GL AP control by party is the books
// (statement); the reconciliation compares the two.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { isSimpleMode } from "@/lib/simple-mode";
import { sodDecision, sodPolicy } from "@/lib/accounting/sod";
import { reverseEntry, postEntry, type PostingLineInput } from "../posting-engine";
import { Decimal, ZERO, toDecimal, MoneyError } from "../money";
import { dayText, parseBusinessDay, riyadhDay, addDaysUtc } from "../dates";
import { setAuditContext, type AuditContext } from "../audit";
import { qty4, lineVat, agingBucket, varianceOnHand, AGING_BUCKETS, type AgingBucket } from "./costing";
import { costRevalue, lockHolder, netLines, side, accountSide, type CostKind } from "./cost-ledger";
import { opsRefuse } from "./refusals";

type Tx = Prisma.TransactionClient;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export type InvoiceLineInput = {
  kind: "GRN" | "STOCK" | "EXPENSE";
  purchaseRecordId?: string | null;
  stockKind?: "GREEN_BEAN" | "MATERIAL" | null;
  stockItemId?: string | null;
  expenseCategoryId?: string | null;
  description?: string | null;
  quantity?: string | number | null;
  net: string | number;
  vatRate?: string | number | null;
};
export type InvoiceInput = { supplierId: string; supplierRef: string; invoiceDate: string; dueDate?: string | null; notes?: string | null; lines: InvoiceLineInput[] };

function money(v: unknown, what: string): Decimal {
  try {
    const d = toDecimal(typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v ?? ""));
    if (!d.equals(d.toDecimalPlaces(2))) throw new MoneyError("2 decimals at most");
    return d;
  } catch { throw opsRefuse("OPS_BAD_INPUT", `${what} is an amount with at most 2 decimals.`, `${what}: مبلغ بخانتين عشريتين كحد أقصى.`); }
}
function day(v: unknown, what: string): Date {
  try { return parseBusinessDay(String(v ?? "")); } catch { throw opsRefuse("OPS_BAD_INPUT", `${what} is YYYY-MM-DD.`, `${what}: تاريخ بصيغة YYYY-MM-DD.`); }
}

/** Gapless-enough internal numbers «SINV-2026-000001» / «SPAY-2026-000001» (serialised per prefix and year). */
async function nextNumber(tx: Tx, prefix: "SINV" | "SPAY", on: Date): Promise<string> {
  const y = on.getUTCFullYear();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ap:number:${prefix}:${y}`}, 0))`;
  const like = `${prefix}-${y}-%`;
  const rows = prefix === "SINV"
    ? await tx.$queryRaw<{ n: string | null }[]>`SELECT max("number") AS n FROM "SupplierInvoice" WHERE "number" LIKE ${like}`
    : await tx.$queryRaw<{ n: string | null }[]>`SELECT max("number") AS n FROM "SupplierPayment" WHERE "number" LIKE ${like}`;
  const last = rows[0]?.n ? Number(rows[0].n.slice(-6)) : 0;
  return `${prefix}-${y}-${String(last + 1).padStart(6, "0")}`;
}

type CleanLine = { kind: InvoiceLineInput["kind"]; purchaseRecordId: string | null; stockKind: string | null; stockItemId: string | null; expenseCategoryId: string | null; description: string; quantity: Decimal | null; net: Decimal; vatRate: Decimal; vat: Decimal; gross: Decimal };

/** Validate and price the lines (VAT per line, rounded once). */
async function cleanLines(tx: Tx, supplierId: string, lines: unknown): Promise<CleanLine[]> {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 200) throw opsRefuse("INVOICE_LINES_REQUIRED");
  const out: CleanLine[] = [];
  for (const [i, raw] of (lines as InvoiceLineInput[]).entries()) {
    if (!raw || typeof raw !== "object") throw opsRefuse("OPS_BAD_INPUT", `Line ${i + 1}.`);
    const kind = raw.kind;
    if (kind !== "GRN" && kind !== "STOCK" && kind !== "EXPENSE") throw opsRefuse("OPS_BAD_INPUT", `Line ${i + 1}: kind is GRN, STOCK or EXPENSE.`);
    const net = money(raw.net, `Line ${i + 1} net`);
    if (net.isNegative()) throw opsRefuse("OPS_BAD_INPUT", `Line ${i + 1}: the net is not negative (a credit note is a separate document).`);
    const vatRate = raw.vatRate === undefined || raw.vatRate === null || raw.vatRate === "" ? new Decimal(15) : money(raw.vatRate, `Line ${i + 1} VAT rate`);
    if (vatRate.isNegative() || vatRate.gt(100)) throw opsRefuse("OPS_BAD_INPUT", `Line ${i + 1}: VAT rate 0–100.`);
    let quantity: Decimal | null = null;
    if (raw.quantity !== undefined && raw.quantity !== null && raw.quantity !== "") {
      const q = Number(raw.quantity);
      if (!Number.isFinite(q) || q <= 0) throw opsRefuse("OPS_BAD_INPUT", `Line ${i + 1}: quantity > 0.`);
      quantity = qty4(q);
    }
    let description = str(raw.description, 300);
    let purchaseRecordId: string | null = null, stockKind: string | null = null, stockItemId: string | null = null, expenseCategoryId: string | null = null;
    if (kind === "GRN") {
      purchaseRecordId = str(raw.purchaseRecordId, 64);
      const pr = purchaseRecordId ? await tx.purchaseRecord.findUnique({ where: { id: purchaseRecordId }, select: { id: true, supplierId: true, quantity: true, type: true, itemId: true, materialItemId: true } }) : null;
      if (!pr) throw opsRefuse("GRN_NOT_FOUND");
      if (pr.supplierId !== supplierId) throw opsRefuse("GRN_OTHER_SUPPLIER");
      quantity = quantity ?? qty4(pr.quantity);
      description = description ?? `استلام ${pr.id.slice(-6)} · ${pr.quantity} ${pr.type === "GREEN_BEAN" ? "كغ" : ""}`.trim();
    } else if (kind === "STOCK") {
      stockKind = raw.stockKind === "GREEN_BEAN" || raw.stockKind === "MATERIAL" ? raw.stockKind : null;
      stockItemId = str(raw.stockItemId, 64);
      const exists = stockKind === "GREEN_BEAN" ? await tx.greenBean.count({ where: { id: stockItemId ?? "" } }) : stockKind === "MATERIAL" ? await tx.materialItem.count({ where: { id: stockItemId ?? "" } }) : 0;
      if (!stockKind || !stockItemId || !exists) throw opsRefuse("STOCK_ITEM_INVALID");
    } else {
      expenseCategoryId = str(raw.expenseCategoryId, 64);
      const c = expenseCategoryId ? await tx.expenseCategory.findUnique({ where: { id: expenseCategoryId }, select: { isActive: true, nameAr: true } }) : null;
      if (!c || !c.isActive) throw opsRefuse("EXPENSE_CATEGORY_INVALID");
      description = description ?? c.nameAr;
    }
    const vat = lineVat(net, vatRate);
    out.push({ kind, purchaseRecordId, stockKind, stockItemId, expenseCategoryId, description: description ?? "—", quantity, net, vatRate, vat, gross: net.plus(vat) });
  }
  if (out.every((l) => l.gross.isZero())) throw opsRefuse("INVOICE_LINES_REQUIRED");
  return out;
}

async function header(tx: Tx, input: InvoiceInput) {
  const supplierId = str(input?.supplierId, 64);
  if (!supplierId) throw opsRefuse("SUPPLIER_REQUIRED");
  const supplier = await tx.supplier.findUnique({ where: { id: supplierId }, select: { id: true, paymentTermsDays: true } });
  if (!supplier) throw opsRefuse("SUPPLIER_REQUIRED");
  const supplierRef = str(input.supplierRef, 60);
  if (!supplierRef) throw opsRefuse("SUPPLIER_REF_REQUIRED");
  const invoiceDate = day(input.invoiceDate, "invoiceDate");
  const dueDate = input.dueDate ? day(input.dueDate, "dueDate") : addDaysUtc(invoiceDate, supplier.paymentTermsDays ?? 30);
  if (dueDate < invoiceDate) throw opsRefuse("OPS_BAD_INPUT", "The due date is on or after the invoice date.", "تاريخ الاستحقاق لا يسبق تاريخ الفاتورة.");
  return { supplierId, supplierRef, invoiceDate, dueDate, notes: str(input.notes, 1000) };
}

async function refDuplicate(tx: Tx, supplierId: string, ref: string, exceptId: string | null) {
  const n = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "SupplierInvoice" WHERE "supplierId" = ${supplierId} AND lower(btrim("supplierRef")) = lower(btrim(${ref})) AND "status" <> 'CANCELLED' AND "id" <> ${exceptId ?? ""}`;
  if ((n[0]?.n ?? 0) > 0) throw opsRefuse("SUPPLIER_REF_DUPLICATE");
}

const totals = (lines: CleanLine[]) => ({ netTotal: lines.reduce((s, l) => s.plus(l.net), ZERO), vatTotal: lines.reduce((s, l) => s.plus(l.vat), ZERO), grossTotal: lines.reduce((s, l) => s.plus(l.gross), ZERO) });
const lineRows = (lines: CleanLine[]) => lines.map((l, i) => ({ lineNo: i + 1, kind: l.kind, purchaseRecordId: l.purchaseRecordId, stockKind: l.stockKind, stockItemId: l.stockItemId, expenseCategoryId: l.expenseCategoryId, description: l.description, quantity: l.quantity, net: l.net, vatRate: l.vatRate, vat: l.vat, gross: l.gross }));

export async function createInvoice(input: InvoiceInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const h = await header(tx, input);
    const lines = await cleanLines(tx, h.supplierId, input.lines);
    await refDuplicate(tx, h.supplierId, h.supplierRef, null);
    const number = await nextNumber(tx, "SINV", riyadhDay());
    const inv = await tx.supplierInvoice.create({ data: { ...h, number, ...totals(lines), createdBy: actorId, lastEditedBy: actorId, lines: { create: lineRows(lines) } }, select: { id: true } });
    return getInvoice(inv.id, tx);
  }, TX_OPTS);
}

export async function updateInvoice(id: string, input: InvoiceInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const cur = await lockInvoice(tx, id);
    if (cur.status !== "DRAFT") throw opsRefuse("INVOICE_STATE", "Only a draft is edited.", "تُعدَّل المسودة فقط.");
    const h = await header(tx, input);
    const lines = await cleanLines(tx, h.supplierId, input.lines);
    await refDuplicate(tx, h.supplierId, h.supplierRef, id);
    await tx.supplierInvoiceLine.deleteMany({ where: { invoiceId: id } });
    await tx.supplierInvoice.update({ where: { id }, data: { ...h, ...totals(lines), lastEditedBy: actorId, lines: { create: lineRows(lines) } } });
    return getInvoice(id, tx);
  }, TX_OPTS);
}

export async function deleteInvoice(id: string) {
  return prisma.$transaction(async (tx) => {
    const cur = await lockInvoice(tx, id);
    if (cur.status !== "DRAFT") throw opsRefuse("INVOICE_STATE", "Only a draft is deleted.", "تُحذف المسودة فقط.");
    await tx.supplierInvoice.delete({ where: { id } });
    return { deleted: true };
  }, TX_OPTS);
}

export async function submitInvoice(id: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const cur = await lockInvoice(tx, id);
    if (cur.status !== "DRAFT") throw opsRefuse("INVOICE_STATE");
    await tx.supplierInvoice.update({ where: { id }, data: { status: "SUBMITTED", submittedBy: actorId, submittedAt: new Date() } });
    return getInvoice(id, tx);
  }, TX_OPTS);
}

/** Back to draft (the approver returns it with a reason, recorded in the notes). */
export async function returnInvoice(id: string, reason: string, actorId: string) {
  const r = str(reason, 300);
  if (!r || r.length < 3) throw opsRefuse("OPS_BAD_INPUT", "A reason is required.", "السبب مطلوب.");
  return prisma.$transaction(async (tx) => {
    const cur = await lockInvoice(tx, id);
    if (cur.status !== "SUBMITTED") throw opsRefuse("INVOICE_STATE");
    await tx.supplierInvoice.update({ where: { id }, data: { status: "DRAFT", submittedBy: null, submittedAt: null, notes: `${cur.notes ? cur.notes + "\n" : ""}أُعيدت للمسودة (${dayText(riyadhDay())}، ${actorId}): ${r}`.slice(0, 1000) } });
    return getInvoice(id, tx);
  }, TX_OPTS);
}

async function lockInvoice(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "SupplierInvoice" WHERE "id" = ${id} FOR UPDATE`;
  if (!rows.length) throw opsRefuse("OPS_NOT_FOUND");
  return tx.supplierInvoice.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
}

/** The receipt (GRN) value the cost ledger recorded, and its holder. */
async function grnOf(tx: Tx, purchaseRecordId: string) {
  return tx.costMove.findFirst({ where: { sourceType: "GRN", sourceId: purchaseRecordId, sourceEvent: "RECEIVED" }, include: { costItem: { select: { kind: true, entityId: true } } } });
}

/** Approve = post. SoD: not by its preparer or submitter (SIMPLE MODE: one owner, recorded). */
export async function postInvoice(id: string, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const inv = await lockInvoice(tx, id);
    // SIMPLE MODE (one owner) may post a DRAFT directly. Self-posting — by the preparer, last editor or submitter — is
    // decided by the SoD setting (A5, src/lib/accounting/sod.ts; SIMPLE MODE always allows); the people on the
    // invoice record it and the SoD exceptions report lists it.
    const simple = isSimpleMode();
    if (inv.status !== "SUBMITTED" && !(simple && inv.status === "DRAFT")) throw opsRefuse("INVOICE_STATE", "Submit the invoice first.", "قدّم الفاتورة للاعتماد أولًا.");
    if ([inv.createdBy, inv.lastEditedBy, inv.submittedBy].includes(ctx.actorId) && !sodDecision(await sodPolicy(tx), "SELF_APPROVAL")) throw opsRefuse("SOD_OWN_INVOICE");
    const party = { type: "SUPPLIER" as const, id: inv.supplierId };
    const posting: (PostingLineInput | null)[] = [];
    const moveIds: string[] = [];
    let vat = ZERO;
    for (const l of inv.lines) {
      const net = new Decimal(l.net);
      vat = vat.plus(l.vat);
      let matched: Decimal | null = null, variance: Decimal | null = null, capitalized: Decimal | null = null;
      if (l.kind === "GRN") {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ap:grn:${l.purchaseRecordId}`}, 0))`;
        const taken = await tx.supplierInvoiceLine.count({ where: { purchaseRecordId: l.purchaseRecordId, invoiceId: { not: id }, invoice: { status: "POSTED" } } });
        if (taken) throw opsRefuse("GRN_ALREADY_MATCHED");
        const grn = await grnOf(tx, l.purchaseRecordId as string);
        if (!grn) throw opsRefuse("GRN_NOT_COSTED");
        matched = new Decimal(grn.value).abs();
        variance = net.minus(matched);
        const h = await lockHolder(tx, grn.costItem.kind as CostKind, grn.costItem.entityId);
        const want = varianceOnHand(variance, new Decimal(grn.qty).abs(), h.qty);
        const r = await costRevalue(tx, { holder: h, src: { module: "purchasing", type: "SUPPLIER_INVOICE", id, event: "POSTED" }, lineKey: `${l.lineNo}`, kind: "REVALUATION", delta: want, actor: ctx.actorId, reason: `فرق سعر فاتورة ${inv.number}` });
        if (r.id) moveIds.push(r.id);
        capitalized = r.value;
        const dims = { item: { type: grn.costItem.kind === "GREEN_BEAN" ? "GREEN_BEAN" as const : "MATERIAL" as const, id: grn.costItem.entityId } };
        posting.push(side("GRNI", matched, { party }), side(h.role, r.value, dims), side("INVENTORY_VARIANCE", variance.minus(r.value), dims));
      } else if (l.kind === "STOCK") {
        const h = await lockHolder(tx, l.stockKind as CostKind, l.stockItemId as string);
        const want = l.quantity ? varianceOnHand(net, new Decimal(l.quantity), h.qty) : net;
        const r = await costRevalue(tx, { holder: h, src: { module: "purchasing", type: "SUPPLIER_INVOICE", id, event: "POSTED" }, lineKey: `${l.lineNo}`, kind: "REVALUATION", delta: want, actor: ctx.actorId, reason: `تكلفة فاتورة ${inv.number}` });
        if (r.id) moveIds.push(r.id);
        capitalized = r.value;
        const dims = { item: { type: l.stockKind === "GREEN_BEAN" ? "GREEN_BEAN" as const : "MATERIAL" as const, id: l.stockItemId as string } };
        posting.push(side(h.role, r.value, dims), side("INVENTORY_VARIANCE", net.minus(r.value), dims));
      } else {
        const c = await tx.expenseCategory.findUniqueOrThrow({ where: { id: l.expenseCategoryId as string }, select: { accountId: true } });
        posting.push(accountSide(c.accountId, net, { party }, l.description));
      }
      if (matched || capitalized) await tx.supplierInvoiceLine.update({ where: { id: l.id }, data: { matchedValue: matched, variance, capitalized } });
    }
    posting.push(side("VAT_INPUT", vat, { party }), side("AP", new Decimal(inv.grossTotal).negated(), { party }));
    const lines = netLines(posting);
    let journalEntryId: string | null = null;
    if (lines.length >= 2) {
      const r = await postEntry(tx, { source: { module: "purchasing", type: "SUPPLIER_INVOICE", id, event: "POSTED" }, date: dayText(inv.invoiceDate), whenPeriodNotOpen: "nextOpenPeriod", memo: `فاتورة مورد ${inv.number} · ${inv.supplierRef}`, createdBy: ctx.actorId, lines });
      if (r.status === "posted") journalEntryId = r.entryId;
      if (moveIds.length) await tx.costMove.updateMany({ where: { id: { in: moveIds } }, data: r.status === "posted" ? { glState: "POSTED", journalEntryId: r.entryId } : { glState: "SKIPPED" } });
    } else if (moveIds.length) await tx.costMove.updateMany({ where: { id: { in: moveIds } }, data: { glState: "NONE" } });
    const now = new Date();
    await tx.supplierInvoice.update({ where: { id }, data: { status: "POSTED", postedBy: ctx.actorId, postedAt: now, journalEntryId, ...(inv.status === "DRAFT" ? { submittedBy: ctx.actorId, submittedAt: now } : {}) } });
    return getInvoice(id, tx);
  }, TX_OPTS);
}

/**
 * Cancel a posted, unpaid invoice: its entry is reversed (mirror) and what it capitalised leaves the holders again;
 * a part a holder can no longer give back (the stock moved on) goes to INVENTORY_VARIANCE in a correction entry.
 */
export async function cancelInvoice(id: string, reason: string, ctx: AuditContext) {
  const r = str(reason, 500);
  if (!r || r.length < 3) throw opsRefuse("OPS_BAD_INPUT", "A reason is required.", "السبب مطلوب.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    const inv = await lockInvoice(tx, id);
    if (inv.status !== "POSTED") throw opsRefuse("INVOICE_STATE");
    if (new Decimal(inv.paidTotal).gt(0)) throw opsRefuse("INVOICE_PAID");
    const src = { module: "purchasing" as const, type: "SUPPLIER_INVOICE", id, event: "CANCELLED" };
    const moveIds: string[] = [];
    const correction: (PostingLineInput | null)[] = [];
    for (const l of inv.lines) {
      const cap = l.capitalized ? new Decimal(l.capitalized) : ZERO;
      if (cap.isZero()) continue;
      const kind = (l.kind === "GRN" ? (await grnOf(tx, l.purchaseRecordId as string))?.costItem.kind : l.stockKind) as CostKind;
      const entityId = l.kind === "GRN" ? (await grnOf(tx, l.purchaseRecordId as string))?.costItem.entityId as string : (l.stockItemId as string);
      const h = await lockHolder(tx, kind, entityId);
      const back = await costRevalue(tx, { holder: h, src, lineKey: `${l.lineNo}`, kind: "REVALUATION", delta: cap.negated(), actor: ctx.actorId, reason: r });
      if (back.id) moveIds.push(back.id);
      const notReturned = cap.plus(back.value); // cap − |released|
      const dims = { item: { type: kind === "GREEN_BEAN" ? "GREEN_BEAN" as const : "MATERIAL" as const, id: entityId } };
      correction.push(side(h.role, notReturned, dims), side("INVENTORY_VARIANCE", notReturned.negated(), dims));
    }
    let reversalId: string | null = null;
    if (inv.journalEntryId) reversalId = (await reverseEntry(tx, { entryId: inv.journalEntryId, reason: r, actorId: ctx.actorId })).entryId;
    const fix = netLines(correction);
    if (inv.journalEntryId && fix.length >= 2) {
      await postEntry(tx, { source: src, memo: `تصحيح تكلفة إلغاء فاتورة ${inv.number}`, createdBy: ctx.actorId, date: dayText(riyadhDay()), whenPeriodNotOpen: "nextOpenPeriod", lines: fix });
    }
    if (moveIds.length) await tx.costMove.updateMany({ where: { id: { in: moveIds } }, data: reversalId ? { glState: "POSTED", journalEntryId: reversalId } : { glState: "SKIPPED" } });
    await tx.supplierInvoice.update({ where: { id }, data: { status: "CANCELLED", cancelledBy: ctx.actorId, cancelledAt: new Date(), cancelReason: r } });
    return getInvoice(id, tx);
  }, TX_OPTS);
}

// ─── Payments ────────────────────────────────────────────────────────────────────────────────────

export type PaymentInput = { supplierId: string; paymentDate: string; amount: string | number; method: "BANK_TRANSFER" | "CASH" | "CHEQUE"; reference?: string | null; allocations: { invoiceId: string; amount: string | number }[] };

/**
 * A5 council fix — the supplier's OPENING balance still unpaid: the credit the opening entry (go-live, from the old
 * books) put on the AP account for this supplier, less the part of every posted payment not applied to an invoice
 * (amount − Σ allocations). Lets the opening AP be paid through the AP module (the AP account refuses manual journals).
 */
export async function supplierOpeningOutstanding(db: Tx | typeof prisma, supplierId: string): Promise<Decimal> {
  const role = await db.accountRole.findUnique({ where: { tenantId_role: { tenantId: "hiqbah", role: "AP" } }, select: { accountId: true } });
  if (!role) return ZERO;
  const [o] = await db.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT coalesce(sum(l."credit" - l."debit"), 0) AS v FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
     WHERE l."accountId" = ${role.accountId} AND l."partyType" = 'SUPPLIER' AND l."partyId" = ${supplierId} AND j."type"::text = 'OPENING' AND j."status" IN ('POSTED', 'REVERSED')`;
  const [p] = await db.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT coalesce(sum(p."amount" - coalesce((SELECT sum(a."amount") FROM "SupplierPaymentAllocation" a WHERE a."paymentId" = p."id"), 0)), 0) AS v
      FROM "SupplierPayment" p WHERE p."supplierId" = ${supplierId} AND p."status" = 'POSTED'`;
  return new Decimal(o?.v ?? 0).minus(new Decimal(p?.v ?? 0));
}

export async function recordPayment(input: PaymentInput, ctx: AuditContext) {
  const supplierId = str(input?.supplierId, 64);
  if (!supplierId) throw opsRefuse("SUPPLIER_REQUIRED");
  const paymentDate = day(input.paymentDate, "paymentDate");
  const amount = money(input.amount, "amount");
  if (!amount.gt(0)) throw opsRefuse("PAYMENT_ALLOCATION");
  const method = input.method;
  if (!["BANK_TRANSFER", "CASH", "CHEQUE"].includes(method)) throw opsRefuse("OPS_BAD_INPUT", "method is BANK_TRANSFER, CASH or CHEQUE.");
  if (!Array.isArray(input.allocations)) throw opsRefuse("PAYMENT_ALLOCATION");
  const allocs = input.allocations.map((a) => ({ invoiceId: String(a?.invoiceId ?? ""), amount: money(a?.amount, "allocation") }));
  if (allocs.some((a) => !a.amount.gt(0)) || new Set(allocs.map((a) => a.invoiceId)).size !== allocs.length) throw opsRefuse("PAYMENT_ALLOCATION");
  // The part not applied to an invoice pays the supplier's opening balance (A5 council fix), never more than it owes.
  const toOpening = amount.minus(allocs.reduce((s, a) => s.plus(a.amount), ZERO));
  if (toOpening.isNegative()) throw opsRefuse("PAYMENT_ALLOCATION");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    if (toOpening.gt(0)) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ap:opening:${supplierId}`}, 0))`;
      if (toOpening.gt(await supplierOpeningOutstanding(tx, supplierId))) throw opsRefuse("PAYMENT_ALLOCATION", "More than the invoices and the supplier's opening balance owe.", "أكثر مما تستحقه الفواتير والرصيد الافتتاحي للمورد.");
    }
    for (const a of [...allocs].sort((x, y) => (x.invoiceId < y.invoiceId ? -1 : 1))) {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "SupplierInvoice" WHERE "id" = ${a.invoiceId} FOR UPDATE`;
      const inv = rows.length ? await tx.supplierInvoice.findUnique({ where: { id: a.invoiceId }, select: { supplierId: true, status: true, grossTotal: true, paidTotal: true } }) : null;
      if (!inv || inv.supplierId !== supplierId || inv.status !== "POSTED") throw opsRefuse("PAYMENT_ALLOCATION");
      if (a.amount.gt(new Decimal(inv.grossTotal).minus(inv.paidTotal))) throw opsRefuse("PAYMENT_ALLOCATION");
    }
    const number = await nextNumber(tx, "SPAY", paymentDate);
    const pay = await tx.supplierPayment.create({ data: { number, supplierId, paymentDate, amount, method, reference: str(input.reference, 120), createdBy: ctx.actorId, allocations: { create: allocs.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) } }, select: { id: true } });
    for (const a of allocs) await tx.supplierInvoice.update({ where: { id: a.invoiceId }, data: { paidTotal: { increment: a.amount } } });
    const party = { type: "SUPPLIER" as const, id: supplierId };
    const r = await postEntry(tx, {
      source: { module: "purchasing", type: "SUPPLIER_PAYMENT", id: pay.id, event: "PAID" }, date: dayText(paymentDate), whenPeriodNotOpen: "nextOpenPeriod",
      memo: `سداد مورد ${number}`, createdBy: ctx.actorId,
      lines: [{ role: "AP", debit: amount.toFixed(2), dims: { party } }, { role: method === "CASH" ? "CASH" : "BANK", credit: amount.toFixed(2) }],
    });
    if (r.status === "posted") await tx.supplierPayment.update({ where: { id: pay.id }, data: { journalEntryId: r.entryId } });
    return getPayment(pay.id, tx);
  }, TX_OPTS);
}

export async function voidPayment(id: string, reason: string, ctx: AuditContext) {
  const r = str(reason, 500);
  if (!r || r.length < 3) throw opsRefuse("OPS_BAD_INPUT", "A reason is required.", "السبب مطلوب.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "SupplierPayment" WHERE "id" = ${id} FOR UPDATE`;
    if (!rows.length) throw opsRefuse("OPS_NOT_FOUND");
    const p = await tx.supplierPayment.findUniqueOrThrow({ where: { id }, include: { allocations: true } });
    if (p.status !== "POSTED") throw opsRefuse("PAYMENT_STATE");
    for (const a of [...p.allocations].sort((x, y) => (x.invoiceId < y.invoiceId ? -1 : 1))) {
      await tx.$queryRaw`SELECT "id" FROM "SupplierInvoice" WHERE "id" = ${a.invoiceId} FOR UPDATE`;
      await tx.supplierInvoice.update({ where: { id: a.invoiceId }, data: { paidTotal: { decrement: a.amount } } });
    }
    if (p.journalEntryId) await reverseEntry(tx, { entryId: p.journalEntryId, reason: r, actorId: ctx.actorId });
    await tx.supplierPayment.update({ where: { id }, data: { status: "VOIDED", voidedBy: ctx.actorId, voidedAt: new Date(), voidReason: r } });
    return getPayment(id, tx);
  }, TX_OPTS);
}

// ─── Reads ───────────────────────────────────────────────────────────────────────────────────────

const f2 = (d: Decimal | Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : new Decimal(d).toFixed(2));

export async function getInvoice(id: string, db: Tx | typeof prisma = prisma) {
  const inv = await db.supplierInvoice.findUnique({ where: { id }, include: { supplier: { select: { id: true, name: true, vatNumber: true } }, lines: { orderBy: { lineNo: "asc" }, include: { expenseCategory: { select: { code: true, nameAr: true, account: { select: { code: true, nameAr: true, nameEn: true } } } } } }, allocations: { include: { payment: { select: { id: true, number: true, paymentDate: true, status: true } } } } } });
  if (!inv) throw opsRefuse("OPS_NOT_FOUND");
  return {
    ...inv, invoiceDate: dayText(inv.invoiceDate), dueDate: dayText(inv.dueDate), netTotal: f2(inv.netTotal), vatTotal: f2(inv.vatTotal), grossTotal: f2(inv.grossTotal), paidTotal: f2(inv.paidTotal),
    outstanding: f2(new Decimal(inv.grossTotal).minus(inv.paidTotal)),
    lines: inv.lines.map((l) => ({ ...l, quantity: l.quantity ? new Decimal(l.quantity).toFixed() : null, net: f2(l.net), vatRate: new Decimal(l.vatRate).toFixed(), vat: f2(l.vat), gross: f2(l.gross), matchedValue: f2(l.matchedValue), variance: f2(l.variance), capitalized: f2(l.capitalized) })),
    allocations: inv.allocations.map((a) => ({ id: a.id, amount: f2(a.amount), payment: { ...a.payment, paymentDate: dayText(a.payment.paymentDate) } })),
  };
}

export async function getPayment(id: string, db: Tx | typeof prisma = prisma) {
  const p = await db.supplierPayment.findUnique({ where: { id }, include: { supplier: { select: { id: true, name: true } }, allocations: { include: { invoice: { select: { id: true, number: true, supplierRef: true } } } } } });
  if (!p) throw opsRefuse("OPS_NOT_FOUND");
  return { ...p, paymentDate: dayText(p.paymentDate), amount: f2(p.amount), allocations: p.allocations.map((a) => ({ ...a, amount: f2(a.amount) })) };
}

export async function listInvoices(q: { status?: string | null; supplierId?: string | null; take?: number }) {
  const rows = await prisma.supplierInvoice.findMany({
    where: { ...(q.status ? { status: q.status } : {}), ...(q.supplierId ? { supplierId: q.supplierId } : {}) },
    orderBy: [{ invoiceDate: "desc" }, { number: "desc" }], take: Math.min(q.take ?? 500, 1000),
    include: { supplier: { select: { name: true } } },
  });
  const today = riyadhDay();
  const counts = await prisma.supplierInvoice.groupBy({ by: ["status"], _count: { _all: true }, _sum: { grossTotal: true, paidTotal: true } });
  return {
    rows: rows.map((r) => {
      const outstanding = new Decimal(r.grossTotal).minus(r.paidTotal);
      const overdueDays = r.status === "POSTED" && outstanding.gt(0) ? Math.max(0, Math.floor((today.getTime() - r.dueDate.getTime()) / 86_400_000)) : 0;
      return { id: r.id, number: r.number, supplierId: r.supplierId, supplierName: r.supplier.name, supplierRef: r.supplierRef, invoiceDate: dayText(r.invoiceDate), dueDate: dayText(r.dueDate), status: r.status, grossTotal: f2(r.grossTotal), paidTotal: f2(r.paidTotal), outstanding: f2(outstanding), overdueDays, createdBy: r.createdBy, submittedBy: r.submittedBy };
    }),
    summary: Object.fromEntries(counts.map((c) => [c.status, { count: c._count._all, gross: f2(c._sum.grossTotal ?? ZERO), outstanding: f2(new Decimal(c._sum.grossTotal ?? 0).minus(c._sum.paidTotal ?? 0)) }])),
  };
}

export async function listPayments(q: { supplierId?: string | null }) {
  const rows = await prisma.supplierPayment.findMany({ where: q.supplierId ? { supplierId: q.supplierId } : {}, orderBy: [{ paymentDate: "desc" }, { number: "desc" }], take: 500, include: { supplier: { select: { name: true } }, allocations: { select: { amount: true, invoice: { select: { number: true } } } } } });
  return rows.map((p) => ({ id: p.id, number: p.number, supplierId: p.supplierId, supplierName: p.supplier.name, paymentDate: dayText(p.paymentDate), amount: f2(p.amount), method: p.method, reference: p.reference, status: p.status, journalEntryId: p.journalEntryId, invoices: p.allocations.map((a) => a.invoice.number) }));
}

/** The AP control account's GL balance (credit-positive), optionally for one supplier, as of a day. */
export async function apGlBalance(asOf: Date, supplierId?: string | null): Promise<Decimal | null> {
  const role = await prisma.accountRole.findUnique({ where: { tenantId_role: { tenantId: "hiqbah", role: "AP" } }, select: { accountId: true } });
  if (!role) return null;
  const rows = await prisma.$queryRaw<{ bal: Decimal | null }[]>`
    SELECT coalesce(sum(l."credit") - sum(l."debit"), 0) AS bal FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE l."accountId" = ${role.accountId} AND e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" <= ${asOf}
       AND (${supplierId ?? null}::text IS NULL OR (l."partyType" = 'SUPPLIER' AND l."partyId" = ${supplierId ?? null}))`;
  return new Decimal(rows[0]?.bal ?? 0);
}

/** Open items as of a day and their aging (documents); with the GL AP balance to compare. */
export async function apAging(asOfText: string | null, supplierId: string | null) {
  const asOf = asOfText ? day(asOfText, "asOf") : riyadhDay();
  const invoices = await prisma.supplierInvoice.findMany({
    where: { status: "POSTED", invoiceDate: { lte: asOf }, ...(supplierId ? { supplierId } : {}) },
    include: { supplier: { select: { name: true } }, allocations: { include: { payment: { select: { paymentDate: true, status: true } } } } },
    orderBy: { dueDate: "asc" },
  });
  const empty = () => Object.fromEntries(AGING_BUCKETS.map((b) => [b, ZERO])) as Record<AgingBucket, Decimal>;
  const total = empty();
  const counts = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
  const bySupplier = new Map<string, { supplierId: string; name: string; buckets: Record<AgingBucket, Decimal>; total: Decimal }>();
  const items = [];
  for (const inv of invoices) {
    const paid = inv.allocations.filter((a) => a.payment.status === "POSTED" && a.payment.paymentDate <= asOf).reduce((s, a) => s.plus(a.amount), ZERO);
    const open = new Decimal(inv.grossTotal).minus(paid);
    if (!open.gt(0)) continue;
    const b = agingBucket(inv.dueDate, asOf);
    total[b] = total[b].plus(open); counts[b] += 1;
    const s = bySupplier.get(inv.supplierId) ?? { supplierId: inv.supplierId, name: inv.supplier.name, buckets: empty(), total: ZERO };
    s.buckets[b] = s.buckets[b].plus(open); s.total = s.total.plus(open);
    bySupplier.set(inv.supplierId, s);
    items.push({ id: inv.id, number: inv.number, supplierId: inv.supplierId, supplierName: inv.supplier.name, supplierRef: inv.supplierRef, invoiceDate: dayText(inv.invoiceDate), dueDate: dayText(inv.dueDate), open: open.toFixed(2), bucket: b, daysOverdue: Math.max(0, Math.floor((asOf.getTime() - inv.dueDate.getTime()) / 86_400_000)) });
  }
  const docTotal = AGING_BUCKETS.reduce((s, b) => s.plus(total[b]), ZERO);
  const gl = await apGlBalance(asOf, supplierId);
  const fmt = (r: Record<AgingBucket, Decimal>) => Object.fromEntries(AGING_BUCKETS.map((b) => [b, r[b].toFixed(2)]));
  return {
    asOf: dayText(asOf), buckets: fmt(total), counts, total: docTotal.toFixed(2),
    suppliers: [...bySupplier.values()].sort((a, b) => b.total.comparedTo(a.total)).map((s) => ({ supplierId: s.supplierId, name: s.name, buckets: fmt(s.buckets), total: s.total.toFixed(2) })),
    items,
    gl: gl === null ? null : { balance: gl.toFixed(2), difference: docTotal.minus(gl).toFixed(2) },
  };
}

/** The supplier statement from the books: the AP control lines of this supplier, with a running balance (credit +). */
export async function supplierStatement(supplierId: string, fromText: string | null, toText: string | null) {
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true, vatNumber: true } });
  if (!supplier) throw opsRefuse("OPS_NOT_FOUND");
  const to = toText ? day(toText, "to") : riyadhDay();
  const from = fromText ? day(fromText, "from") : new Date(Date.UTC(to.getUTCFullYear(), 0, 1));
  const role = await prisma.accountRole.findUnique({ where: { tenantId_role: { tenantId: "hiqbah", role: "AP" } }, select: { accountId: true } });
  if (!role) return { supplier, from: dayText(from), to: dayText(to), opening: "0.00", closing: "0.00", lines: [] };
  const opening = (await apGlBalance(addDaysUtc(from, -1), supplierId)) ?? ZERO;
  const rows = await prisma.$queryRaw<{ entryId: string; entryDate: Date; postingYear: number | null; postingSeq: number | null; description: string | null; sourceType: string | null; sourceId: string | null; debit: Decimal; credit: Decimal }[]>`
    SELECT e."id" AS "entryId", e."entryDate", e."postingYear", e."postingSeq", e."description", e."sourceType", e."sourceId", l."debit", l."credit"
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE l."accountId" = ${role.accountId} AND l."partyType" = 'SUPPLIER' AND l."partyId" = ${supplierId}
       AND e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" >= ${from} AND e."entryDate" <= ${to}
     ORDER BY e."entryDate", e."postingYear", e."postingSeq", l."lineNo"`;
  let bal = opening;
  const lines = rows.map((r) => {
    bal = bal.plus(r.credit).minus(r.debit);
    return { entryId: r.entryId, date: dayText(r.entryDate), ref: r.postingYear ? `JE-${r.postingYear}-${String(r.postingSeq).padStart(6, "0")}` : "—", description: r.description, sourceType: r.sourceType, sourceId: r.sourceId, debit: new Decimal(r.debit).toFixed(2), credit: new Decimal(r.credit).toFixed(2), balance: bal.toFixed(2) };
  });
  return { supplier, from: dayText(from), to: dayText(to), opening: opening.toFixed(2), closing: bal.toFixed(2), lines };
}

/** Costed receipts of a supplier not yet matched by a posted invoice (GRNI open items), for matching and the GRNI report. One query. */
export async function openReceipts(supplierId: string | null) {
  const rows = await prisma.$queryRaw<{ purchaseRecordId: string; supplierId: string; supplierName: string; type: string; day: Date; qty: Decimal; value: Decimal; glState: string; itemKind: string; itemId: string; notes: string | null }[]>`
    SELECT m."sourceId" AS "purchaseRecordId", p."supplierId", s."name" AS "supplierName", p."type"::text AS "type", m."businessDay" AS "day", m."qty", m."value", m."glState",
           i."kind" AS "itemKind", i."entityId" AS "itemId", p."notes"
      FROM "CostMove" m
      JOIN "CostItem" i ON i."id" = m."costItemId"
      JOIN "PurchaseRecord" p ON p."id" = m."sourceId"
      JOIN "Supplier" s ON s."id" = p."supplierId"
     WHERE m."sourceType" = 'GRN' AND m."sourceEvent" = 'RECEIVED' AND m."value" > 0
       AND (${supplierId}::text IS NULL OR p."supplierId" = ${supplierId})
       AND NOT EXISTS (SELECT 1 FROM "SupplierInvoiceLine" l JOIN "SupplierInvoice" v ON v."id" = l."invoiceId" WHERE l."purchaseRecordId" = p."id" AND v."status" = 'POSTED')
     ORDER BY m."businessDay" DESC, m."createdAt" DESC
     LIMIT 2000`;
  return rows.map((r) => ({ purchaseRecordId: r.purchaseRecordId, supplierId: r.supplierId, supplierName: r.supplierName, type: r.type, date: dayText(r.day), quantity: new Decimal(r.qty).toFixed(), value: new Decimal(r.value).toFixed(2), glState: r.glState, itemKind: r.itemKind, itemId: r.itemId, notes: r.notes }));
}

// ─── Expense categories ──────────────────────────────────────────────────────────────────────────

export async function listCategories() {
  const rows = await prisma.expenseCategory.findMany({ orderBy: { code: "asc" }, include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } } });
  return rows;
}

async function checkExpenseAccount(tx: Tx, accountId: string) {
  const a = await tx.account.findUnique({ where: { id: accountId }, select: { type: true, isActive: true, allowPosting: true, controlType: true, _count: { select: { children: true } } } });
  if (!a || !a.isActive || !a.allowPosting || a._count.children > 0 || !["EXPENSE", "ASSET"].includes(String(a.type)) || a.controlType) throw opsRefuse("ROLE_ACCOUNT_TYPE");
}

export async function saveCategory(input: { id?: string | null; code?: string; nameAr?: string; nameEn?: string | null; accountId?: string; isActive?: boolean }, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const code = str(input.code, 30)?.toUpperCase() ?? null;
    const nameAr = str(input.nameAr, 120);
    const accountId = str(input.accountId, 64);
    if (input.id) {
      const cur = await tx.expenseCategory.findUnique({ where: { id: input.id } });
      if (!cur) throw opsRefuse("OPS_NOT_FOUND");
      if (accountId) await checkExpenseAccount(tx, accountId);
      return tx.expenseCategory.update({ where: { id: input.id }, data: { ...(nameAr ? { nameAr } : {}), ...(input.nameEn !== undefined ? { nameEn: str(input.nameEn, 120) } : {}), ...(accountId ? { accountId } : {}), ...(typeof input.isActive === "boolean" ? { isActive: input.isActive } : {}), updatedBy: ctx.actorId } });
    }
    if (!code || !/^[A-Z0-9_-]{2,30}$/.test(code) || !nameAr || !accountId) throw opsRefuse("OPS_BAD_INPUT", "code (A–Z, 0–9), nameAr and accountId are required.", "الرمز والاسم والحساب مطلوبة.");
    if (await tx.expenseCategory.findUnique({ where: { code } })) throw opsRefuse("CATEGORY_CODE_EXISTS");
    await checkExpenseAccount(tx, accountId);
    return tx.expenseCategory.create({ data: { code, nameAr, nameEn: str(input.nameEn, 120), accountId, updatedBy: ctx.actorId } });
  }, TX_OPTS);
}

