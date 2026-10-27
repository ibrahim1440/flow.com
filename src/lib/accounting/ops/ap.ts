// Accounting A3 — the minimal AP sub-ledger (no supplier invoice / AP model existed: PurchaseRecord is a receipt
// register, FinObligation a cash-planning forecast). Figma ACC-50 / 51 / 52 / 53 / 113.
//
//   SupplierInvoice  DRAFT → SUBMITTED → POSTED → (CANCELLED: reversed, only while unpaid)
//     posting (approve = post, by an AP holder other than its preparer / submitter — SIMPLE MODE excepted):
//       Dr GRNI (party = supplier) the matched receipts' values   · GRN lines
//       Dr INVENTORY_* / INVENTORY_VARIANCE the price variance     · capitalised while the stock is on hand
//       Dr INVENTORY_* stock lines without a costed receipt       · capitalised into the holder (rest → variance) —
//                                                                   an AP-origin bill only (legacy API); a one-step
//                                                                   purchase invoice receives its stock lines first
//       Dr INVENTORY_* landed costs (freight, duty, clearance,     · capitalised onto the target receipt's holder, the
//          insurance) on a receipt of any supplier                    consumed share → INVENTORY_VARIANCE (the GRN rule)
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
import { costRevalue, lockHolders, netLines, side, accountSide, type CostKind, type HolderRow } from "./cost-ledger";
import { opsRefuse } from "./refusals";
import { buildPurchaseTaxSnapshot, purchaseTaxCategories, purchaseTaxCodeForRate } from "./purchase-tax";
import { invoiceSummary, logPurchaseActivity, withDeniedLog } from "./purchase-activity";

type Tx = Prisma.TransactionClient;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export type InvoiceLineInput = {
  kind: "GRN" | "STOCK" | "EXPENSE" | "IMPORT_VAT" | "LANDED_COST";
  /** Phase 2: the purchase VAT category (P-S15 …); without it the rate decides (15 → P-S15, 0 → P-Z0). */
  taxCode?: string | null;
  taxCategoryId?: string | null;
  /** IMPORT_VAT lines: the customs value the import VAT is computed on. */
  customsValue?: string | number | null;
  /** LANDED_COST lines: the goods receipt (any supplier) the cost is capitalised onto, and its type. */
  targetPurchaseRecordId?: string | null;
  landedCostType?: string | null;
  purchaseRecordId?: string | null;
  stockKind?: "GREEN_BEAN" | "MATERIAL" | null;
  stockItemId?: string | null;
  expenseCategoryId?: string | null;
  description?: string | null;
  quantity?: string | number | null;
  net: string | number;
  vatRate?: string | number | null;
};
export type InvoiceInput = { supplierId: string; supplierRef: string; invoiceDate: string; dueDate?: string | null; notes?: string | null; customsDeclarationNo?: string | null; customsDeclarationDate?: string | null; lines: InvoiceLineInput[] };
export type InvoiceSupplier = { id: string; name: string; vatNumber: string | null; isNonResident: boolean; kind: string; paymentTermsDays: number | null };
export const LANDED_COST_TYPES = ["FREIGHT", "DUTY", "CLEARANCE", "INSURANCE"] as const;
/** The codes a landed cost may carry (P-RC15: freight from a non-resident carrier). */
const LANDED_TAX = new Set(["P-S15", "P-S15-NR", "P-O", "P-RC15"]);

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
export async function nextNumber(tx: Tx, prefix: "SINV" | "SPAY", on: Date): Promise<string> {
  const y = on.getUTCFullYear();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ap:number:${prefix}:${y}`}, 0))`;
  const like = `${prefix}-${y}-%`;
  const rows = prefix === "SINV"
    ? await tx.$queryRaw<{ n: string | null }[]>`SELECT max("number") AS n FROM "SupplierInvoice" WHERE "number" LIKE ${like}`
    : await tx.$queryRaw<{ n: string | null }[]>`SELECT max("number") AS n FROM "SupplierPayment" WHERE "number" LIKE ${like}`;
  const last = rows[0]?.n ? Number(rows[0].n.slice(-6)) : 0;
  return `${prefix}-${y}-${String(last + 1).padStart(6, "0")}`;
}

export type CleanLine = { kind: InvoiceLineInput["kind"]; purchaseRecordId: string | null; stockKind: string | null; stockItemId: string | null; expenseCategoryId: string | null; description: string; quantity: Decimal | null; net: Decimal; vatRate: Decimal; vat: Decimal; gross: Decimal; taxCategoryId: string; treatment: string | null; customsValue: Decimal | null; selfAssessedVat: Decimal | null; targetPurchaseRecordId: string | null; landedCostType: string | null };

/**
 * Validate and price the lines (VAT per line, rounded once — lineVat, the central money rule). Phase 2: each line has a
 * purchase VAT category (purchase-tax.ts) — its rate replaces any rate the request sends — and its rules:
 *   P-S15 needs the supplier's VAT number (else P-S15-NR or P-O); P-IMP15 is an IMPORT_VAT line (net 0, VAT on the
 *   customs VAT base) on an invoice with a customs declaration, billed by customs or a clearing agent (Supplier.kind),
 *   never a non-resident; P-RC15 is an expense or a landed cost (foreign freight) of a non-resident supplier, its VAT
 *   self-assessed (not payable to the supplier, so the line's VAT is 0). A LANDED_COST line names a receipt of any
 *   supplier and takes P-S15, P-S15-NR, P-O or P-RC15.
 */
export async function cleanLines(tx: Tx, supplier: InvoiceSupplier, lines: unknown, customs: { no: string | null } = { no: null }): Promise<CleanLine[]> {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 200) throw opsRefuse("INVOICE_LINES_REQUIRED");
  const supplierId = supplier.id;
  const tax = await purchaseTaxCategories(tx);
  const out: CleanLine[] = [];
  for (const [i, raw] of (lines as InvoiceLineInput[]).entries()) {
    if (!raw || typeof raw !== "object") throw opsRefuse("OPS_BAD_INPUT", `Line ${i + 1}.`);
    const kind = raw.kind;
    if (kind !== "GRN" && kind !== "STOCK" && kind !== "EXPENSE" && kind !== "IMPORT_VAT" && kind !== "LANDED_COST") throw opsRefuse("OPS_BAD_INPUT", `Line ${i + 1}: kind is GRN, STOCK, EXPENSE, IMPORT_VAT or LANDED_COST.`);
    let net = kind === "IMPORT_VAT" ? ZERO : money(raw.net, `Line ${i + 1} net`);
    if (net.isNegative()) throw opsRefuse("OPS_BAD_INPUT", `Line ${i + 1}: the net is not negative (a credit note is a separate document).`);
    const givenRate = raw.vatRate === undefined || raw.vatRate === null || raw.vatRate === "" ? null : money(raw.vatRate, `Line ${i + 1} VAT rate`);
    const code = str(raw.taxCode, 20) ?? (raw.taxCategoryId ? tax.byId.get(String(raw.taxCategoryId))?.code ?? null : null)
      ?? (kind === "IMPORT_VAT" ? "P-IMP15" : purchaseTaxCodeForRate(givenRate === null ? 15 : Number(givenRate)));
    const tc = code ? tax.byCode.get(code) : undefined;
    if (!tc || !tc.isActive) throw opsRefuse("TAX_CATEGORY_INVALID", `Line ${i + 1}.`, `السطر ${i + 1}.`);
    const treatment = tc.inputVatTreatment;
    const vatRate = new Decimal(tc.rate);
    let quantity: Decimal | null = null;
    if (raw.quantity !== undefined && raw.quantity !== null && raw.quantity !== "") {
      const q = Number(raw.quantity);
      if (!Number.isFinite(q) || q <= 0) throw opsRefuse("OPS_BAD_INPUT", `Line ${i + 1}: quantity > 0.`);
      quantity = qty4(q);
    }
    let description = str(raw.description, 300);
    let purchaseRecordId: string | null = null, stockKind: string | null = null, stockItemId: string | null = null, expenseCategoryId: string | null = null;
    let customsValue: Decimal | null = null, targetPurchaseRecordId: string | null = null, landedCostType: string | null = null;
    if (kind === "LANDED_COST") {
      targetPurchaseRecordId = str(raw.targetPurchaseRecordId, 64);
      landedCostType = (LANDED_COST_TYPES as readonly string[]).includes(String(raw.landedCostType)) ? String(raw.landedCostType) : null;
      const pr = targetPurchaseRecordId ? await tx.purchaseRecord.findUnique({ where: { id: targetPurchaseRecordId }, select: { id: true, type: true, quantity: true } }) : null;
      if (!pr || !landedCostType || (await receiptReversed(tx, pr.id))) throw opsRefuse("LANDED_COST_TARGET", `Line ${i + 1}.`, `السطر ${i + 1}.`);
      if (!(await tx.costMove.count({ where: { sourceType: "GRN", sourceId: pr.id, sourceEvent: "RECEIVED" } }))) throw opsRefuse("GRN_NOT_COSTED");
      if (!LANDED_TAX.has(tc.code)) throw opsRefuse("LANDED_COST_TAX", `Line ${i + 1}.`, `السطر ${i + 1}.`);
      description = description ?? `${({ FREIGHT: "شحن", DUTY: "رسوم جمركية", CLEARANCE: "تخليص", INSURANCE: "تأمين" } as Record<string, string>)[landedCostType]} · استلام ${pr.id.slice(-6)}`;
    } else if (kind === "GRN") {
      purchaseRecordId = str(raw.purchaseRecordId, 64);
      const pr = purchaseRecordId ? await tx.purchaseRecord.findUnique({ where: { id: purchaseRecordId }, select: { id: true, supplierId: true, quantity: true, type: true, itemId: true, materialItemId: true } }) : null;
      if (!pr) throw opsRefuse("GRN_NOT_FOUND");
      if (pr.supplierId !== supplierId) throw opsRefuse("GRN_OTHER_SUPPLIER");
      if (await receiptReversed(tx, pr.id)) throw opsRefuse("RECEIPT_REVERSED");
      quantity = quantity ?? qty4(pr.quantity);
      description = description ?? `استلام ${pr.id.slice(-6)} · ${pr.quantity} ${pr.type === "GREEN_BEAN" ? "كغ" : ""}`.trim();
    } else if (kind === "STOCK") {
      stockKind = raw.stockKind === "GREEN_BEAN" || raw.stockKind === "MATERIAL" ? raw.stockKind : null;
      stockItemId = str(raw.stockItemId, 64);
      const exists = stockKind === "GREEN_BEAN" ? await tx.greenBean.count({ where: { id: stockItemId ?? "" } }) : stockKind === "MATERIAL" ? await tx.materialItem.count({ where: { id: stockItemId ?? "" } }) : 0;
      if (!stockKind || !stockItemId || !exists) throw opsRefuse("STOCK_ITEM_INVALID");
    } else if (kind === "EXPENSE") {
      expenseCategoryId = str(raw.expenseCategoryId, 64);
      const c = expenseCategoryId ? await tx.expenseCategory.findUnique({ where: { id: expenseCategoryId }, select: { isActive: true, nameAr: true } }) : null;
      if (!c || !c.isActive) throw opsRefuse("EXPENSE_CATEGORY_INVALID");
      description = description ?? c.nameAr;
    } else {
      customsValue = money(raw.customsValue, `Line ${i + 1} customs value`);
      if (!customsValue.gt(0)) throw opsRefuse("TAX_IMPORT_VALUE", `Line ${i + 1}.`, `السطر ${i + 1}.`);
      description = description ?? "ضريبة استيراد مدفوعة في الجمارك";
    }
    // The category's rules.
    if (treatment === "RECOVERABLE" && !supplier.vatNumber) throw opsRefuse("TAX_SUPPLIER_VAT_REQUIRED", `Line ${i + 1}.`, `السطر ${i + 1}.`);
    if ((treatment === "IMPORT") !== (kind === "IMPORT_VAT")) throw opsRefuse("TAX_IMPORT_LINE", `Line ${i + 1}.`, `السطر ${i + 1}.`);
    // Import VAT is paid to customs (directly or through a clearing agent) — never owed to a foreign goods supplier.
    if (treatment === "IMPORT" && (supplier.isNonResident || (supplier.kind !== "CUSTOMS" && supplier.kind !== "CLEARING_AGENT"))) throw opsRefuse("TAX_IMPORT_SUPPLIER", `Line ${i + 1}.`, `السطر ${i + 1}.`);
    if (treatment === "IMPORT" && !customs.no) throw opsRefuse("TAX_CUSTOMS_REQUIRED");
    if (treatment === "REVERSE_CHARGE" && !supplier.isNonResident) throw opsRefuse("TAX_RC_NON_RESIDENT", `Line ${i + 1}.`, `السطر ${i + 1}.`);
    if (treatment === "REVERSE_CHARGE" && kind !== "EXPENSE" && kind !== "LANDED_COST") throw opsRefuse("TAX_RC_SERVICES", `Line ${i + 1}.`, `السطر ${i + 1}.`);
    let vat: Decimal, selfAssessedVat: Decimal | null = null;
    if (treatment === "IMPORT") { net = ZERO; vat = lineVat(customsValue as Decimal, vatRate); }
    else if (treatment === "REVERSE_CHARGE") { vat = ZERO; selfAssessedVat = lineVat(net, vatRate); }
    else vat = lineVat(net, vatRate);
    out.push({ kind, purchaseRecordId, stockKind, stockItemId, expenseCategoryId, description: description ?? "—", quantity, net, vatRate, vat, gross: net.plus(vat), taxCategoryId: tc.id, treatment, customsValue, selfAssessedVat, targetPurchaseRecordId, landedCostType });
  }
  if (out.every((l) => l.gross.isZero() && !(l.selfAssessedVat ?? ZERO).gt(0))) throw opsRefuse("INVOICE_LINES_REQUIRED");
  return out;
}

export async function header(tx: Tx, input: InvoiceInput) {
  const supplierId = str(input?.supplierId, 64);
  if (!supplierId) throw opsRefuse("SUPPLIER_REQUIRED");
  const supplier = await tx.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true, vatNumber: true, isNonResident: true, kind: true, paymentTermsDays: true } });
  if (!supplier) throw opsRefuse("SUPPLIER_REQUIRED");
  const supplierRef = str(input.supplierRef, 60);
  if (!supplierRef) throw opsRefuse("SUPPLIER_REF_REQUIRED");
  const invoiceDate = day(input.invoiceDate, "invoiceDate");
  const dueDate = input.dueDate ? day(input.dueDate, "dueDate") : addDaysUtc(invoiceDate, supplier.paymentTermsDays ?? 30);
  if (dueDate < invoiceDate) throw opsRefuse("OPS_BAD_INPUT", "The due date is on or after the invoice date.", "تاريخ الاستحقاق لا يسبق تاريخ الفاتورة.");
  // Phase 2: the customs declaration (import VAT, P-IMP15) — both its number and date, or neither.
  const customsDeclarationNo = str(input.customsDeclarationNo, 60);
  const customsDeclarationDate = input.customsDeclarationDate ? day(input.customsDeclarationDate, "customsDeclarationDate") : null;
  if (!!customsDeclarationNo !== !!customsDeclarationDate) throw opsRefuse("TAX_CUSTOMS_REQUIRED");
  return { h: { supplierId, supplierRef, invoiceDate, dueDate, notes: str(input.notes, 1000), customsDeclarationNo, customsDeclarationDate }, supplier };
}

export async function refDuplicate(tx: Tx, supplierId: string, ref: string, exceptId: string | null) {
  const n = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "SupplierInvoice" WHERE "supplierId" = ${supplierId} AND lower(btrim("supplierRef")) = lower(btrim(${ref})) AND "status" <> 'CANCELLED' AND "id" <> ${exceptId ?? ""}`;
  if ((n[0]?.n ?? 0) > 0) throw opsRefuse("SUPPLIER_REF_DUPLICATE");
}

export const totals = (lines: CleanLine[]) => ({ netTotal: lines.reduce((s, l) => s.plus(l.net), ZERO), vatTotal: lines.reduce((s, l) => s.plus(l.vat), ZERO), grossTotal: lines.reduce((s, l) => s.plus(l.gross), ZERO) });
export const lineRows = (lines: CleanLine[]) => lines.map((l, i) => ({ lineNo: i + 1, kind: l.kind, purchaseRecordId: l.purchaseRecordId, stockKind: l.stockKind, stockItemId: l.stockItemId, expenseCategoryId: l.expenseCategoryId, description: l.description, quantity: l.quantity, net: l.net, vatRate: l.vatRate, vat: l.vat, gross: l.gross, taxCategoryId: l.taxCategoryId, customsValue: l.customsValue, selfAssessedVat: l.selfAssessedVat, targetPurchaseRecordId: l.targetPurchaseRecordId, landedCostType: l.landedCostType }));

/**
 * SA1 — a one-step purchase invoice (origin PURCHASES) whose STOCK lines are still to be received goes through the
 * purchase-invoice service only: the legacy AP submit / edit / post would capitalise their value with no goods.
 */
function refuseLegacyOnPurchase(inv: { origin: string; lines: { kind: string }[] }) {
  if (inv.origin === "PURCHASES" && inv.lines.some((l) => l.kind === "STOCK")) throw opsRefuse("PURCHASE_INVOICE_SERVICE_ONLY");
}

export async function createInvoice(input: InvoiceInput, actorId: string, ctx?: AuditContext) {
  return prisma.$transaction(async (tx) => {
    const { h, supplier } = await header(tx, input);
    const lines = await cleanLines(tx, supplier, input.lines, { no: h.customsDeclarationNo });
    await refDuplicate(tx, h.supplierId, h.supplierRef, null);
    const number = await nextNumber(tx, "SINV", riyadhDay());
    const inv = await tx.supplierInvoice.create({ data: { ...h, number, ...totals(lines), createdBy: actorId, lastEditedBy: actorId, lines: { create: lineRows(lines) } }, select: { id: true } });
    await logPurchaseActivity(tx, ctx ?? { actorId }, "PURCHASE_INVOICE_SAVED", inv.id);
    return getInvoice(inv.id, tx);
  }, TX_OPTS);
}

export async function updateInvoice(id: string, input: InvoiceInput, actorId: string, ctx?: AuditContext) {
  return prisma.$transaction(async (tx) => {
    const cur = await lockInvoice(tx, id);
    if (cur.status !== "DRAFT") throw opsRefuse("INVOICE_STATE", "Only a draft is edited.", "تُعدَّل المسودة فقط.");
    if ((await ownReceipts(tx, id)).length) throw opsRefuse("INVOICE_RECEIVED");
    refuseLegacyOnPurchase(cur);
    const before = await invoiceSummary(tx, id);
    const { h, supplier } = await header(tx, input);
    const lines = await cleanLines(tx, supplier, input.lines, { no: h.customsDeclarationNo });
    await refDuplicate(tx, h.supplierId, h.supplierRef, id);
    await tx.supplierInvoiceLine.deleteMany({ where: { invoiceId: id } });
    await tx.supplierInvoice.update({ where: { id }, data: { ...h, ...totals(lines), lastEditedBy: actorId, lines: { create: lineRows(lines) } } });
    await logPurchaseActivity(tx, ctx ?? { actorId }, "PURCHASE_INVOICE_SAVED", id, { before });
    return getInvoice(id, tx);
  }, TX_OPTS);
}

/**
 * EA2 — no supplier invoice is deleted: every one is numbered when it is created, and the SINV sequence has no gaps
 * and no reuse. A draft is cancelled instead (it stays «ملغاة» with its number) — cancelPurchaseInvoice. The database
 * refuses deleting anything but a DRAFT as well (ledger_ap_invoice_delete_guard).
 */
export async function deleteInvoice(id: string, ctx?: AuditContext) {
  void ctx;
  if (!(await prisma.supplierInvoice.count({ where: { id } }))) throw opsRefuse("OPS_NOT_FOUND");
  throw opsRefuse("INVOICE_NUMBER_ISSUED");
}

export async function submitInvoice(id: string, actorId: string, ctx?: AuditContext) {
  return prisma.$transaction(async (tx) => {
    const cur = await lockInvoice(tx, id);
    if (cur.status !== "DRAFT") throw opsRefuse("INVOICE_STATE");
    refuseLegacyOnPurchase(cur);
    await tx.supplierInvoice.update({ where: { id }, data: { status: "SUBMITTED", submittedBy: actorId, submittedAt: new Date() } });
    await logPurchaseActivity(tx, ctx ?? { actorId }, "PURCHASE_INVOICE_SUBMITTED", id);
    return getInvoice(id, tx);
  }, TX_OPTS);
}

/** Back to draft (the approver returns it with a reason, recorded in the notes). */
export async function returnInvoice(id: string, reason: string, actorId: string, ctx?: AuditContext) {
  const r = str(reason, 300);
  if (!r || r.length < 3) throw opsRefuse("OPS_BAD_INPUT", "A reason is required.", "السبب مطلوب.");
  return prisma.$transaction(async (tx) => {
    const cur = await lockInvoice(tx, id);
    if (cur.status !== "SUBMITTED") throw opsRefuse("INVOICE_STATE");
    // SA2: an invoice that received its goods itself is never a plain draft again (its preparer edits or cancels it).
    if ((await ownReceipts(tx, id)).length) throw opsRefuse("INVOICE_RECEIVED_RETURN");
    await tx.supplierInvoice.update({ where: { id }, data: { status: "DRAFT", submittedBy: null, submittedAt: null, notes: `${cur.notes ? cur.notes + "\n" : ""}أُعيدت للمسودة (${dayText(riyadhDay())}، ${actorId}): ${r}`.slice(0, 1000) } });
    await logPurchaseActivity(tx, { ...(ctx ?? { actorId }), reason: r }, "PURCHASE_INVOICE_RETURNED", id);
    return getInvoice(id, tx);
  }, TX_OPTS);
}

export async function lockInvoice(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "SupplierInvoice" WHERE "id" = ${id} FOR UPDATE`;
  if (!rows.length) throw opsRefuse("OPS_NOT_FOUND");
  return tx.supplierInvoice.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
}

/** The receipt (GRN) value the cost ledger recorded, and its holder. */
async function grnOf(tx: Tx, purchaseRecordId: string) {
  return tx.costMove.findFirst({ where: { sourceType: "GRN", sourceId: purchaseRecordId, sourceEvent: "RECEIVED" }, include: { costItem: { select: { kind: true, entityId: true } } } });
}

/**
 * The receipts THIS invoice received itself (the one-step purchase invoice, phase 2) and that are not reversed: its
 * GRN lines whose receipt's cost movement carries the invoice as its source line (`SINV:<id>`, immutable — the cost
 * sub-ledger is append-only). A GRN line matched to a receipt recorded on its own is not one of them.
 */
export async function ownReceipts(db: Tx | typeof prisma, invoiceId: string, opts: { includeReversed?: boolean } = {}): Promise<string[]> {
  const all = opts.includeReversed === true;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT l."purchaseRecordId" AS id FROM "SupplierInvoiceLine" l
      JOIN "CostMove" m ON m."sourceType" = 'GRN' AND m."sourceId" = l."purchaseRecordId" AND m."sourceEvent" = 'RECEIVED' AND m."lineKey" = ${`SINV:${invoiceId}`}
     WHERE l."invoiceId" = ${invoiceId} AND l."kind" = 'GRN'
       AND (${all} OR NOT EXISTS (SELECT 1 FROM "CostMove" r WHERE r."sourceType" = 'GRN' AND r."sourceId" = l."purchaseRecordId" AND r."sourceEvent" = 'REVERSED'))`;
  return rows.map((r) => r.id);
}

/** Was this receipt reversed (its REVERSED cost movement exists)? */
export async function receiptReversed(db: Tx | typeof prisma, purchaseRecordId: string): Promise<boolean> {
  return (await db.costMove.count({ where: { sourceType: "GRN", sourceId: purchaseRecordId, sourceEvent: "REVERSED" } })) > 0;
}

/** Approve = post. SoD: not by its preparer or submitter (SIMPLE MODE: one owner, recorded). */
export async function postInvoice(id: string, ctx: AuditContext) {
  return withDeniedLog(ctx, "post", id, () => prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    return postInvoiceTx(tx, id, ctx);
  }, TX_OPTS));
}

/**
 * Post in the caller's transaction (the one-step purchase invoice «حفظ واستلام واعتماد» posts in its own).
 * CC2: every cost holder the posting touches (GRN lines' receipts, STOCK lines' items, landed costs' target receipts)
 * is collected first and locked at once in the one fixed order (lockHolders: kind, then entity id) — the order a
 * packaging run, a roast or a delivery takes — so two of them never wait on each other in a circle.
 */
export async function postInvoiceTx(tx: Tx, id: string, ctx: AuditContext) {
  {
    const inv = await lockInvoice(tx, id);
    // SIMPLE MODE (one owner) may post a DRAFT directly. Self-posting — by the preparer, last editor or submitter — is
    // decided by the SoD setting (A5, src/lib/accounting/sod.ts; SIMPLE MODE always allows); the people on the
    // invoice record it and the SoD exceptions report lists it.
    const simple = isSimpleMode();
    if (inv.status !== "SUBMITTED" && !(simple && inv.status === "DRAFT")) throw opsRefuse("INVOICE_STATE", "Submit the invoice first.", "قدّم الفاتورة للاعتماد أولًا.");
    refuseLegacyOnPurchase(inv);
    if ([inv.createdBy, inv.lastEditedBy, inv.submittedBy].includes(ctx.actorId) && !sodDecision(await sodPolicy(tx), "SELF_APPROVAL")) throw opsRefuse("SOD_OWN_INVOICE");
    const party = { type: "SUPPLIER" as const, id: inv.supplierId };
    const posting: (PostingLineInput | null)[] = [];
    const moveIds: string[] = [];
    // The receipts the lines value (a GRN line's own receipt, a landed cost's target), read once.
    const grns = new Map<string, NonNullable<Awaited<ReturnType<typeof grnOf>>>>();
    for (const l of inv.lines) {
      const pr = l.kind === "GRN" ? l.purchaseRecordId : l.kind === "LANDED_COST" ? l.targetPurchaseRecordId : null;
      if (!pr || grns.has(pr)) continue;
      if (l.kind === "GRN") await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ap:grn:${pr}`}, 0))`;
      const g = await grnOf(tx, pr);
      if (!g) throw opsRefuse("GRN_NOT_COSTED");
      grns.set(pr, g);
    }
    const holders = await lockHolders(tx, [
      ...[...grns.values()].map((g) => ({ kind: g.costItem.kind as CostKind, entityId: g.costItem.entityId })),
      ...inv.lines.filter((l) => l.kind === "STOCK").map((l) => ({ kind: l.stockKind as CostKind, entityId: l.stockItemId as string })),
    ]);
    const holderOf = (kind: string, entityId: string) => holders.get(`${kind}:${entityId}`) as HolderRow;
    // Phase 2: each line's VAT by its purchase VAT category — claimed (recoverable, import, reverse charge),
    // capitalised into the cost (not recoverable), or none; the category is snapshotted on the line here.
    const tax = await purchaseTaxCategories(tx);
    let vat = ZERO, selfAssessed = ZERO;
    for (const l of inv.lines) {
      const tc = l.taxCategoryId ? tax.byId.get(l.taxCategoryId) : undefined;
      // A line the migration could not classify (a legacy rate other than 15 / 0) is not posted on a guess.
      if (!tc) throw opsRefuse("TAX_CATEGORY_INVALID", `Line ${l.lineNo} has no VAT category (a legacy rate of ${new Decimal(l.vatRate).toFixed()} %): return the invoice to draft and choose one.`, `السطر ${l.lineNo} بلا فئة ضريبة (نسبة قديمة ${new Decimal(l.vatRate).toFixed()}%): أعد الفاتورة للمسودة واختر فئتها.`);
      const treatment = tc.inputVatTreatment ?? null;
      const nonRecoverable = treatment === "NON_RECOVERABLE" ? new Decimal(l.vat) : ZERO;
      const net = new Decimal(l.net);
      if (treatment !== "NON_RECOVERABLE") vat = vat.plus(l.vat);
      if (l.selfAssessedVat) selfAssessed = selfAssessed.plus(l.selfAssessedVat);
      await tx.supplierInvoiceLine.update({ where: { id: l.id }, data: { taxSnapshot: buildPurchaseTaxSnapshot(tc) } });
      let matched: Decimal | null = null, variance: Decimal | null = null, capitalized: Decimal | null = null;
      if (l.kind === "GRN") {
        const taken = await tx.supplierInvoiceLine.count({ where: { purchaseRecordId: l.purchaseRecordId, invoiceId: { not: id }, invoice: { status: "POSTED" } } });
        if (taken) throw opsRefuse("GRN_ALREADY_MATCHED");
        if (await receiptReversed(tx, l.purchaseRecordId as string)) throw opsRefuse("RECEIPT_REVERSED");
        const grn = grns.get(l.purchaseRecordId as string)!;
        matched = new Decimal(grn.value).abs();
        variance = net.minus(matched);
        // A VAT that is not recoverable is part of the cost: it follows the stock like a price variance.
        const toCost = variance.plus(nonRecoverable);
        const h = holderOf(grn.costItem.kind, grn.costItem.entityId);
        const want = varianceOnHand(toCost, new Decimal(grn.qty).abs(), h.qty);
        const r = await costRevalue(tx, { holder: h, src: { module: "purchasing", type: "SUPPLIER_INVOICE", id, event: "POSTED" }, lineKey: `${l.lineNo}`, kind: "REVALUATION", delta: want, actor: ctx.actorId, reason: `فرق سعر فاتورة ${inv.number}` });
        if (r.id) moveIds.push(r.id);
        capitalized = r.value;
        const dims = { item: { type: grn.costItem.kind === "GREEN_BEAN" ? "GREEN_BEAN" as const : "MATERIAL" as const, id: grn.costItem.entityId } };
        posting.push(side("GRNI", matched, { party }), side(h.role, r.value, dims), side("INVENTORY_VARIANCE", toCost.minus(r.value), dims));
      } else if (l.kind === "LANDED_COST") {
        // CA1 — freight, duty, clearance or insurance on a receipt (of any supplier): capitalised onto that receipt's
        // holder by the GRN-variance rule (varianceOnHand) — the share of the receipt still on hand goes into the
        // stock's cost; the share already consumed (roasted, packed, issued) is past its cost and goes to
        // INVENTORY_VARIANCE. A not-recoverable VAT is part of the cost.
        if (await receiptReversed(tx, l.targetPurchaseRecordId as string)) throw opsRefuse("RECEIPT_REVERSED");
        const grn = grns.get(l.targetPurchaseRecordId as string)!;
        const toCost = net.plus(nonRecoverable);
        const h = holderOf(grn.costItem.kind, grn.costItem.entityId);
        // N6 (accepted, informational): varianceOnHand compares the receipt's quantity with the holder's TOTAL on-hand
        // quantity. For a fungible material (several receipts in one holder) the consumed share is therefore the
        // item's, not that specific receipt's — consistent with moving-average costing, where receipts are not tracked
        // apart once they are in the holder. (A green lot is its own holder, so there it is the receipt's own share.)
        const want = varianceOnHand(toCost, new Decimal(grn.qty).abs(), h.qty);
        const r = await costRevalue(tx, { holder: h, src: { module: "purchasing", type: "SUPPLIER_INVOICE", id, event: "POSTED" }, lineKey: `${l.lineNo}`, kind: "REVALUATION", delta: want, actor: ctx.actorId, reason: `تكلفة إضافية (${l.landedCostType}) فاتورة ${inv.number}` });
        if (r.id) moveIds.push(r.id);
        capitalized = r.value;
        const dims = { item: { type: grn.costItem.kind === "GREEN_BEAN" ? "GREEN_BEAN" as const : "MATERIAL" as const, id: grn.costItem.entityId } };
        posting.push(side(h.role, r.value, dims), side("INVENTORY_VARIANCE", toCost.minus(r.value), dims));
      } else if (l.kind === "STOCK") {
        const h = holderOf(l.stockKind as string, l.stockItemId as string);
        const cost = net.plus(nonRecoverable);
        const want = l.quantity ? varianceOnHand(cost, new Decimal(l.quantity), h.qty) : cost;
        const r = await costRevalue(tx, { holder: h, src: { module: "purchasing", type: "SUPPLIER_INVOICE", id, event: "POSTED" }, lineKey: `${l.lineNo}`, kind: "REVALUATION", delta: want, actor: ctx.actorId, reason: `تكلفة فاتورة ${inv.number}` });
        if (r.id) moveIds.push(r.id);
        capitalized = r.value;
        const dims = { item: { type: l.stockKind === "GREEN_BEAN" ? "GREEN_BEAN" as const : "MATERIAL" as const, id: l.stockItemId as string } };
        posting.push(side(h.role, r.value, dims), side("INVENTORY_VARIANCE", cost.minus(r.value), dims));
      } else if (l.kind === "EXPENSE") {
        const c = await tx.expenseCategory.findUniqueOrThrow({ where: { id: l.expenseCategoryId as string }, select: { accountId: true } });
        posting.push(accountSide(c.accountId, net.plus(nonRecoverable), { party }, l.description));
      }
      // (IMPORT_VAT: no net — only its VAT, claimed below.)
      if (matched || capitalized) await tx.supplierInvoiceLine.update({ where: { id: l.id }, data: { matchedValue: matched, variance, capitalized } });
    }
    // The reverse charge: the buyer self-assesses the VAT — input and output at once (nothing owed to the supplier).
    posting.push(side("VAT_INPUT", vat.plus(selfAssessed), { party }), side("VAT_OUTPUT", selfAssessed.negated(), { party }), side("AP", new Decimal(inv.grossTotal).negated(), { party }));
    const lines = netLines(posting);
    let journalEntryId: string | null = null;
    if (lines.length >= 2) {
      // N5: an invoice that only carries import VAT is dated at its customs declaration — the period the VAT return
      // reports it in (box 8) — so the ledger and the return agree; that period must be open (no rolling forward).
      // A mixed invoice keeps its invoice date; the return's import-timing line explains the difference.
      const importOnly = inv.lines.length > 0 && inv.lines.every((l) => l.kind === "IMPORT_VAT") && !!inv.customsDeclarationDate;
      const r = await postEntry(tx, { source: { module: "purchasing", type: "SUPPLIER_INVOICE", id, event: "POSTED" }, date: dayText(importOnly ? inv.customsDeclarationDate as Date : inv.invoiceDate), whenPeriodNotOpen: importOnly ? "reject" : "nextOpenPeriod", memo: `فاتورة مورد ${inv.number} · ${inv.supplierRef}`, createdBy: ctx.actorId, lines });
      if (r.status === "posted") journalEntryId = r.entryId;
      if (moveIds.length) await tx.costMove.updateMany({ where: { id: { in: moveIds } }, data: r.status === "posted" ? { glState: "POSTED", journalEntryId: r.entryId } : { glState: "SKIPPED" } });
    } else if (moveIds.length) await tx.costMove.updateMany({ where: { id: { in: moveIds } }, data: { glState: "NONE" } });
    const now = new Date();
    await tx.supplierInvoice.update({ where: { id }, data: { status: "POSTED", postedBy: ctx.actorId, postedAt: now, journalEntryId, ...(inv.status === "DRAFT" ? { submittedBy: ctx.actorId, submittedAt: now } : {}) } });
    await logPurchaseActivity(tx, ctx, "PURCHASE_INVOICE_POSTED", id);
    return getInvoice(id, tx);
  }
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
      const viaReceipt = l.kind === "GRN" ? l.purchaseRecordId : l.kind === "LANDED_COST" ? l.targetPurchaseRecordId : null;
      const g = viaReceipt ? await grnOf(tx, viaReceipt) : null;
      const kind = (g ? g.costItem.kind : l.stockKind) as CostKind;
      const entityId = g ? g.costItem.entityId : (l.stockItemId as string);
      const h = (await lockHolders(tx, [{ kind, entityId }])).get(`${kind}:${entityId}`) as HolderRow;
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
    await logPurchaseActivity(tx, { ...ctx, reason: r }, "PURCHASE_INVOICE_CANCELLED_POSTED", id);
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
  const inv = await db.supplierInvoice.findUnique({ where: { id }, include: { supplier: { select: { id: true, name: true, vatNumber: true } }, lines: { orderBy: { lineNo: "asc" }, include: { expenseCategory: { select: { code: true, nameAr: true, account: { select: { code: true, nameAr: true, nameEn: true } } } }, taxCategory: { select: { code: true, nameAr: true, nameEn: true, inputVatTreatment: true, vatReturnBox: true } }, targetPurchaseRecord: { select: { id: true, type: true, itemId: true, materialItemId: true, quantity: true, purchaseDate: true, supplier: { select: { name: true } } } } } }, allocations: { include: { payment: { select: { id: true, number: true, paymentDate: true, status: true } } } } } });
  if (!inv) throw opsRefuse("OPS_NOT_FOUND");
  return {
    ...inv, invoiceDate: dayText(inv.invoiceDate), dueDate: dayText(inv.dueDate), customsDeclarationDate: inv.customsDeclarationDate ? dayText(inv.customsDeclarationDate) : null, receivedDate: inv.receivedDate ? dayText(inv.receivedDate) : null, updatedAt: inv.updatedAt.toISOString(), netTotal: f2(inv.netTotal), vatTotal: f2(inv.vatTotal), grossTotal: f2(inv.grossTotal), paidTotal: f2(inv.paidTotal),
    outstanding: f2(new Decimal(inv.grossTotal).minus(inv.paidTotal)),
    lines: inv.lines.map((l) => ({ ...l, quantity: l.quantity ? new Decimal(l.quantity).toFixed() : null, net: f2(l.net), vatRate: new Decimal(l.vatRate).toFixed(), vat: f2(l.vat), gross: f2(l.gross), matchedValue: f2(l.matchedValue), variance: f2(l.variance), capitalized: f2(l.capitalized), customsValue: f2(l.customsValue), selfAssessedVat: f2(l.selfAssessedVat), taxCode: l.taxCategory?.code ?? null })),
    allocations: inv.allocations.map((a) => ({ id: a.id, amount: f2(a.amount), payment: { ...a.payment, paymentDate: dayText(a.payment.paymentDate) } })),
  };
}

export async function getPayment(id: string, db: Tx | typeof prisma = prisma) {
  const p = await db.supplierPayment.findUnique({ where: { id }, include: { supplier: { select: { id: true, name: true } }, allocations: { include: { invoice: { select: { id: true, number: true, supplierRef: true } } } } } });
  if (!p) throw opsRefuse("OPS_NOT_FOUND");
  return { ...p, paymentDate: dayText(p.paymentDate), amount: f2(p.amount), allocations: p.allocations.map((a) => ({ ...a, amount: f2(a.amount) })) };
}

export async function listInvoices(q: { status?: string | null; supplierId?: string | null; take?: number; from?: string | null; to?: string | null; q?: string | null }) {
  // Phase 2 (the purchases screen): a period (invoice date, YYYY-MM-DD) and a search (number, supplier ref or name).
  const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? day(q.from, "from") : null;
  const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? day(q.to, "to") : null;
  const search = q.q?.trim().slice(0, 80) || null;
  const rows = await prisma.supplierInvoice.findMany({
    where: {
      ...(q.status ? { status: q.status } : {}), ...(q.supplierId ? { supplierId: q.supplierId } : {}),
      ...(from || to ? { invoiceDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(search ? { OR: [{ number: { contains: search, mode: "insensitive" as const } }, { supplierRef: { contains: search, mode: "insensitive" as const } }, { supplier: { name: { contains: search, mode: "insensitive" as const } } }] } : {}),
    },
    orderBy: [{ invoiceDate: "desc" }, { number: "desc" }], take: Math.min(q.take ?? 500, 1000),
    include: { supplier: { select: { name: true } } },
  });
  const today = riyadhDay();
  const counts = await prisma.supplierInvoice.groupBy({ by: ["status"], _count: { _all: true }, _sum: { grossTotal: true, paidTotal: true } });
  // Which of these received their goods themselves (one-step), in one query.
  const ids = rows.map((r) => r.id);
  const received = new Set(ids.length ? (await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT l."invoiceId" AS id FROM "SupplierInvoiceLine" l
      JOIN "CostMove" m ON m."sourceType" = 'GRN' AND m."sourceId" = l."purchaseRecordId" AND m."sourceEvent" = 'RECEIVED' AND m."lineKey" = 'SINV:' || l."invoiceId"
     WHERE l."invoiceId" = ANY(${ids}::text[]) AND l."kind" = 'GRN'
       AND NOT EXISTS (SELECT 1 FROM "CostMove" r WHERE r."sourceType" = 'GRN' AND r."sourceId" = l."purchaseRecordId" AND r."sourceEvent" = 'REVERSED')`).map((r) => r.id) : []);
  return {
    rows: rows.map((r) => {
      const outstanding = new Decimal(r.grossTotal).minus(r.paidTotal);
      const overdueDays = r.status === "POSTED" && outstanding.gt(0) ? Math.max(0, Math.floor((today.getTime() - r.dueDate.getTime()) / 86_400_000)) : 0;
      return { id: r.id, number: r.number, supplierId: r.supplierId, supplierName: r.supplier.name, supplierRef: r.supplierRef, invoiceDate: dayText(r.invoiceDate), dueDate: dayText(r.dueDate), status: r.status, netTotal: f2(r.netTotal), vatTotal: f2(r.vatTotal), received: received.has(r.id), grossTotal: f2(r.grossTotal), paidTotal: f2(r.paidTotal), outstanding: f2(outstanding), overdueDays, createdBy: r.createdBy, submittedBy: r.submittedBy };
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
       AND NOT EXISTS (SELECT 1 FROM "CostMove" r WHERE r."sourceType" = 'GRN' AND r."sourceId" = p."id" AND r."sourceEvent" = 'REVERSED')
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

