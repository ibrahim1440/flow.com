// Unified inventory, phase 2 — «فاتورة مشتريات», the ONE-STEP purchase invoice (owner decision 2026-10-26: buy as in
// Qoyod — one document receives the goods into stock and records the bill against the supplier).
//
//   «حفظ كمسودة»             DRAFT: nothing touches stock or the books (stock lines are kept as STOCK lines; a new green
//                            lot entered inline is created as an empty lot record — master data, no quantity).
//   «حفظ واستلام»            ONE transaction: every stock line is RECEIVED through the shared receive service
//                            (src/lib/services/purchase-receipts.ts — the same lock, movement, balance, audit and GRN
//                            cost / entry as a receipt recorded on its own) at exactly the line's net, so the bill's GRN
//                            line matches it with no price variance; the invoice is created with those GRN lines and
//                            its expense lines and is SUBMITTED.
//   «حفظ واستلام واعتماد»    the same, then posted in the same transaction (postInvoiceTx) — only when the SoD setting
//                            lets the preparer post (or SIMPLE MODE); the route also requires accounting › ap.
//   edit after receiving     (not posted, goods untouched) ONE transaction: the receipts whose lines changed or went
//                            are reversed (stock and cost back, the GRN entry reversed), the new lines received.
//   cancel after receiving   (not posted, goods untouched) ONE transaction: every receipt of the invoice reversed, the
//                            invoice kept as CANCELLED («ملغاة») with who, when and why — never deleted: its SINV
//                            number stays issued (20261113090000_purchase_invoice_phase2).
//   landed cost              «تكلفة إضافية على شحنة»: freight, duty, clearance or insurance on a receipt of ANY supplier,
//                            capitalised onto that receipt's holder when the invoice is posted (ap.ts).
//
// Every invoice this service creates is origin PURCHASES (its STOCK lines are only ever received here — the legacy AP
// routes refuse it); an AP-origin draft with value-only STOCK lines is refused here (LEGACY_STOCK_DRAFT). An edit sends
// the `expectedUpdatedAt` it read (else INVOICE_STALE). Grants are deny-by-default: the caller states both.
//
// The receipt ↔ invoice link: the GRN line names its receipt (purchaseRecordId); the receipt's cost movement names
// the invoice as its source line (lineKey `SINV:<invoice id>`, immutable — the cost sub-ledger is append-only).
// Idempotency: the business key (supplier, supplier invoice no.) is unique among live invoices (index
// SupplierInvoice_supplier_ref_live_key) and serialised here by an advisory lock — the same request sent twice by
// its preparer returns the invoice the first one made and receives nothing again; anything else is a duplicate.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { setAuditContext, type AuditContext } from "../audit";
import { dayText, parseBusinessDay, riyadhDay } from "../dates";
import { Decimal, ZERO, toDecimal } from "../money";
import { flushPostings, lockHolders, type CostKind } from "./cost-ledger";
import { qty4, stockLineNet } from "./costing";
import { opsRefuse } from "./refusals";
import { cleanLines, getInvoice, header, lineRows, lockInvoice, nextNumber, ownReceipts, postInvoiceTx, receiptReversed, refDuplicate, totals, type InvoiceInput, type InvoiceLineInput } from "./ap";
import { receiveGreen, receiveMaterial, reverseReceipt, type ReceiptUser } from "@/lib/services/purchase-receipts";
import { greenLotFields } from "@/lib/services/green-lots";
import { receivingLocationId as resolveReceivingLocation } from "@/lib/services/stock-locations";
import { invoiceSummary, logPurchaseActivity, withDeniedLog } from "./purchase-activity";

type Tx = Prisma.TransactionClient;

export type PurchaseAction = "draft" | "receive" | "post";
export type PurchaseLineInput = {
  kind: "STOCK" | "GRN" | "EXPENSE" | "IMPORT_VAT" | "LANDED_COST";
  /** LANDED_COST: the receipt (any supplier) and FREIGHT | DUTY | CLEARANCE | INSURANCE. */
  targetPurchaseRecordId?: string | null;
  landedCostType?: string | null;
  /** The purchase VAT category (P-S15, P-S15-NR, P-Z0, P-E0, P-O, P-IMP15, P-RC15 — purchase-tax.ts). */
  taxCode?: string | null;
  /** IMPORT_VAT: the customs value the import VAT is computed on. */
  customsValue?: string | number | null;
  stockKind?: "GREEN_BEAN" | "MATERIAL" | null;
  stockItemId?: string | null;
  /** «لوط جديد»: the green lot form's fields; the lot is created in the same save. */
  newLot?: Record<string, unknown> | null;
  quantity?: string | number | null;
  unitCost?: string | number | null;
  purchaseRecordId?: string | null;
  expenseCategoryId?: string | null;
  description?: string | null;
  net?: string | number | null;
  vatRate?: string | number | null;
};
export type PurchaseInvoiceInput = {
  supplierId: string; supplierRef: string; invoiceDate: string; dueDate?: string | null; notes?: string | null;
  customsDeclarationNo?: string | null; customsDeclarationDate?: string | null;
  /** CA4: the day the goods were received (default: today in Riyadh) — the receipts' and cost moves' day. */
  receivedDate?: string | null;
  /** Phase 3: «موقع الاستلام» — the location the goods are received at (default: the default receiving site). */
  receivingLocationId?: string | null;
  /** SA3: an edit sends the invoice's updatedAt as it read it; anything else is INVOICE_STALE. */
  expectedUpdatedAt?: string | null;
  lines: PurchaseLineInput[]; action?: PurchaseAction;
};
/** What the caller's gates allowed (src/lib/purchases/gates.ts); the service enforces them. Deny by default: required. */
export type PurchaseGrants = { mayReceive: boolean; mayChangeReceived: boolean };

const ACTIONS: PurchaseAction[] = ["draft", "receive", "post"];
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** A unit cost: > 0, at most 6 decimals. */
function unitCostOf(v: unknown, i: number): Decimal {
  let d: Decimal;
  try { d = toDecimal(typeof v === "number" ? v.toString() : String(v ?? "")); } catch { throw opsRefuse("STOCK_LINE_INVALID", `Line ${i + 1}.`, `السطر ${i + 1}.`); }
  if (!d.gt(0) || !d.equals(d.toDecimalPlaces(6)) || d.gt(1e9)) throw opsRefuse("STOCK_LINE_INVALID", `Line ${i + 1}: unit cost > 0, at most 6 decimals.`, `السطر ${i + 1}: تكلفة الوحدة أكبر من صفر بست خانات عشرية كحد أقصى.`);
  return d;
}
function quantityOf(v: unknown, i: number): Decimal {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}(\.\d{1,4})?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw opsRefuse("STOCK_LINE_INVALID", `Line ${i + 1}: quantity > 0 (at most 4 decimals).`, `السطر ${i + 1}: الكمية أكبر من صفر (4 خانات عشرية كحد أقصى).`);
  return qty4(n);
}


type Stock = { i: number; stockKind: "GREEN_BEAN" | "MATERIAL"; stockItemId: string | null; newLot: Record<string, unknown> | null; quantity: Decimal; unitCost: Decimal; net: Decimal; vatRate: string | number | null | undefined; description: string | null };

/** Validate the raw lines (shape and stock maths) before anything is written. */
function parseLines(raw: unknown): { stock: Stock[]; lines: PurchaseLineInput[] } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) throw opsRefuse("INVOICE_LINES_REQUIRED");
  const stock: Stock[] = [];
  for (const [i, l] of (raw as PurchaseLineInput[]).entries()) {
    if (!l || typeof l !== "object" || !["STOCK", "GRN", "EXPENSE", "IMPORT_VAT", "LANDED_COST"].includes(l.kind)) throw opsRefuse("OPS_BAD_INPUT", `Line ${i + 1}: kind is STOCK, GRN, EXPENSE, IMPORT_VAT or LANDED_COST.`, `السطر ${i + 1}.`);
    if (l.kind !== "STOCK") continue;
    const stockKind = l.stockKind === "GREEN_BEAN" || l.stockKind === "MATERIAL" ? l.stockKind : null;
    const newLot = stockKind === "GREEN_BEAN" && l.newLot && typeof l.newLot === "object" ? l.newLot : null;
    const stockItemId = newLot ? null : str(l.stockItemId, 64);
    if (!stockKind || (!stockItemId && !newLot)) throw opsRefuse("STOCK_LINE_INVALID", `Line ${i + 1}.`, `السطر ${i + 1}.`);
    const quantity = quantityOf(l.quantity, i);
    const unitCost = unitCostOf(l.unitCost, i);
    stock.push({ i, stockKind, stockItemId, newLot, quantity, unitCost, net: stockLineNet(quantity, unitCost), vatRate: l.vatRate, description: str(l.description, 300) });
  }
  return { stock, lines: raw as PurchaseLineInput[] };
}

/** The net a request would make (to recognise the same request sent twice). */
async function expectedNet(tx: Tx, lines: PurchaseLineInput[], stock: Stock[]): Promise<Decimal> {
  let total = ZERO;
  for (const [i, l] of lines.entries()) {
    if (l.kind === "STOCK") total = total.plus(stock.find((s) => s.i === i)?.net ?? ZERO);
    else if (l.kind === "IMPORT_VAT") continue;
    else if (l.kind === "GRN" && (l.net === undefined || l.net === null || l.net === "")) total = total.plus(await grnValue(tx, String(l.purchaseRecordId ?? "")));
    else total = total.plus(new Decimal(String(l.net ?? 0)));
  }
  return total;
}

type LotOut = { id: string; serialNumber: string; beanType: string; beanTypeAr: string | null; country: string; created: boolean };

/**
 * Save a purchase invoice — new (`id` null) or an existing draft / received, un-posted one — with its action.
 * Returns the invoice, whether it is a replay, and the green lots it received (for «اطبع الملصق»).
 */
export async function savePurchaseInvoice(input: PurchaseInvoiceInput, id: string | null, user: ReceiptUser, ctx: AuditContext, opts: PurchaseGrants) {
  return withDeniedLog(ctx, id ? "edit" : "save", id, () => saveTx(input, id, user, ctx, opts));
}

/** CA4: the receipt day — given (YYYY-MM-DD, not in the future) or today in Riyadh. */
function receivedDayOf(v: unknown): Date {
  const today = riyadhDay();
  if (v === undefined || v === null || v === "") return today;
  let d: Date;
  try { d = parseBusinessDay(String(v)); } catch { throw opsRefuse("RECEIVED_DATE_INVALID"); }
  if (d > today) throw opsRefuse("RECEIVED_DATE_INVALID", `${dayText(d)} is after today.`, `${dayText(d)} بعد اليوم.`);
  return d;
}

async function saveTx(input: PurchaseInvoiceInput, id: string | null, user: ReceiptUser, ctx: AuditContext, opts: PurchaseGrants) {
  const action: PurchaseAction = ACTIONS.includes(input?.action as PurchaseAction) ? (input.action as PurchaseAction) : "draft";
  const { stock, lines } = parseLines(input?.lines);
  // Receiving (a stock line saved with «استلام»), a new lot record, or reversing a receipt is the receiving duty.
  const mayReceive = opts?.mayReceive === true, mayChangeReceived = opts?.mayChangeReceived === true;
  if (!mayReceive && (stock.some((x) => x.newLot) || (action !== "draft" && stock.length))) throw opsRefuse("RECEIVE_REQUIRED");
  const receivedDate = receivedDayOf(input?.receivedDate);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const { h, supplier } = await header(tx, input as InvoiceInput);
    // Phase 3: where the goods are received (an active location; none given → the default site).
    const receivingLocationId = await resolveReceivingLocation(tx, input?.receivingLocationId);
    // Serialise every save of one (supplier, supplier invoice no.): a double submit waits for the first.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ap:ref:${h.supplierId}:${h.supplierRef.trim().toLowerCase()}`}, 0))`;
    const cur = id ? await lockInvoice(tx, id) : null;
    if (cur) {
      // SA3: the edit is based on what its author read — a concurrent change makes it stale, not silently lost.
      const expected = input.expectedUpdatedAt ? Date.parse(String(input.expectedUpdatedAt)) : NaN;
      if (!Number.isFinite(expected) || expected !== cur.updatedAt.getTime()) throw opsRefuse("INVOICE_STALE");
      // SA1: an accounts-payable draft whose STOCK lines only add cost (no goods) is not a purchase invoice.
      if (cur.origin === "AP" && cur.lines.some((l) => l.kind === "STOCK")) throw opsRefuse("LEGACY_STOCK_DRAFT");
      if (cur.status === "POSTED") throw (await ownReceipts(tx, cur.id)).length ? opsRefuse("INVOICE_POSTED_RECEIVED") : opsRefuse("INVOICE_STATE");
      if (cur.status === "CANCELLED") throw opsRefuse("INVOICE_STATE");
    } else {
      // The same request again (a double click, a retry after a lost answer): its preparer gets the first one back.
      const twin = await tx.$queryRaw<{ id: string; status: string; createdBy: string; createdAt: Date; netTotal: Prisma.Decimal; n: number }[]>`
        SELECT v."id", v."status", v."createdBy", v."createdAt", v."netTotal", (SELECT count(*)::int FROM "SupplierInvoiceLine" l WHERE l."invoiceId" = v."id") AS n
          FROM "SupplierInvoice" v WHERE v."supplierId" = ${h.supplierId} AND lower(btrim(v."supplierRef")) = lower(btrim(${h.supplierRef})) AND v."status" <> 'CANCELLED' LIMIT 1`;
      const t = twin[0];
      const wanted = action === "draft" ? ["DRAFT"] : action === "receive" ? ["SUBMITTED"] : ["POSTED"];
      if (t && t.createdBy === user.id && Date.now() - t.createdAt.getTime() < 15 * 60_000 && wanted.includes(t.status) && t.n === lines.length && new Decimal(t.netTotal).equals(await expectedNet(tx, lines, stock))) {
        return { invoice: await getInvoice(t.id, tx), replayed: true, lots: [] as LotOut[] };
      }
    }
    await refDuplicate(tx, h.supplierId, h.supplierRef, cur?.id ?? null);

    const own = cur ? await ownReceipts(tx, cur.id) : [];
    const before = cur ? await invoiceSummary(tx, cur.id) : null;
    if (action === "draft" && own.length) throw opsRefuse("INVOICE_RECEIVED");
    if (cur?.status === "SUBMITTED" && !own.length) throw opsRefuse("INVOICE_STATE", "Return it to draft to change it.", "أعدها للمسودة لتعديلها.");

    // The header first: the receipts name the invoice as their source line.
    const number = cur?.number ?? (await nextNumber(tx, "SINV", riyadhDay()));
    const invId = cur
      ? cur.id
      : (await tx.supplierInvoice.create({ data: { ...h, number, origin: "PURCHASES", createdBy: user.id, lastEditedBy: user.id }, select: { id: true } })).id;

    // Lock every stock row this save will touch, in one fixed order (green lots, then materials, by id): two saves
    // naming the same items in different line orders queue instead of deadlocking. The receive and reverse services
    // take the same row locks again (a no-op) and then the cost holders — the one direction every stock operation uses.
    const ownRows = own.length ? await tx.purchaseRecord.findMany({ where: { id: { in: own } }, select: { type: true, itemId: true, materialItemId: true } }) : [];
    const greenIds = [...new Set([...stock.filter((x) => x.stockKind === "GREEN_BEAN" && x.stockItemId).map((x) => x.stockItemId as string), ...ownRows.filter((r) => r.type === "GREEN_BEAN" && r.itemId).map((r) => r.itemId as string)])].sort();
    const matIds = [...new Set([...stock.filter((x) => x.stockKind === "MATERIAL" && x.stockItemId).map((x) => x.stockItemId as string), ...ownRows.filter((r) => r.materialItemId).map((r) => r.materialItemId as string)])].sort();
    if (action !== "draft") {
      for (const g of greenIds) await tx.$queryRaw`SELECT "id" FROM "GreenBean" WHERE "id" = ${g} FOR UPDATE`;
      for (const m of matIds) await tx.$queryRaw`SELECT "id" FROM "MaterialItem" WHERE "id" = ${m} FOR UPDATE`;
      // CC2: then EVERY cost holder this save (and its posting) touches, at once, in the one fixed order (lockHolders):
      // the stock lines' items, the receipts being reversed, the receipts matched on GRN lines and the landed costs'
      // target receipts. The receive / reverse / post steps take them again (a no-op).
      const viaReceipts = lines.filter((l) => (l.kind === "GRN" || l.kind === "LANDED_COST") && (l.purchaseRecordId || l.targetPurchaseRecordId)).map((l) => String(l.kind === "GRN" ? l.purchaseRecordId : l.targetPurchaseRecordId));
      const recHolders = viaReceipts.length ? await tx.costMove.findMany({ where: { sourceType: "GRN", sourceId: { in: viaReceipts }, sourceEvent: "RECEIVED" }, select: { costItem: { select: { kind: true, entityId: true } } } }) : [];
      const held = await lockHolders(tx, [
        ...greenIds.map((entityId) => ({ kind: "GREEN_BEAN" as CostKind, entityId })), ...matIds.map((entityId) => ({ kind: "MATERIAL" as CostKind, entityId })),
        ...recHolders.map((m) => ({ kind: m.costItem.kind as CostKind, entityId: m.costItem.entityId })),
      ]);
      // CA4: a receipt is never dated before the item's last cost movement (the moving average is chronological).
      if (stock.length) {
        const touched = [...held.values()].filter((h) => (h.kind === "GREEN_BEAN" && greenIds.includes(h.entityId)) || (h.kind === "MATERIAL" && stock.some((x) => x.stockItemId === h.entityId)));
        const last = touched.length ? await tx.costMove.aggregate({ where: { costItemId: { in: touched.map((h) => h.id) } }, _max: { businessDay: true } }) : null;
        if (last?._max.businessDay && last._max.businessDay > receivedDate) throw opsRefuse("RECEIVED_DATE_INVALID", `The last cost movement is on ${dayText(last._max.businessDay)}.`, `آخر حركة تكلفة في ${dayText(last._max.businessDay)}.`);
      }
    }

    // Receipts this invoice holds and keeps (a GRN line naming one of them); the rest are reversed.
    const keep = new Set(lines.filter((l) => l.kind === "GRN" && l.purchaseRecordId && own.includes(String(l.purchaseRecordId))).map((l) => String(l.purchaseRecordId)));
    const reversing = own.filter((x) => !keep.has(x));
    // CC4: reversing a receipt takes BOTH the receiving duty and its own grant (purchases › received_change).
    if (reversing.length && !mayChangeReceived) throw opsRefuse("RECEIVED_CHANGE_REQUIRED");
    if (reversing.length && !mayReceive) throw opsRefuse("RECEIVE_REQUIRED");
    for (const pr of reversing) {
      const reason = `تعديل فاتورة المشتريات ${number}`;
      await reverseReceipt(tx, user, { purchaseRecordId: pr, reason, label: number, exceptInvoiceId: invId });
      await logPurchaseActivity(tx, { ...ctx, reason }, "PURCHASE_RECEIPT_REVERSED", invId, { purchaseRecordId: pr });
    }
    // A receipt recorded on its own (matched here) must not be on another live invoice.
    for (const l of lines) {
      if (l.kind !== "GRN" || !l.purchaseRecordId || keep.has(String(l.purchaseRecordId))) continue;
      const prId = String(l.purchaseRecordId);
      if (await receiptReversed(tx, prId)) throw opsRefuse("RECEIPT_REVERSED");
      const elsewhere = await tx.supplierInvoiceLine.count({ where: { purchaseRecordId: prId, invoiceId: { not: invId }, invoice: { status: { not: "CANCELLED" } } } });
      if (elsewhere) throw opsRefuse("GRN_ALREADY_MATCHED");
    }

    // Stock lines: a new lot is created (empty) in this save; on receive each line becomes a receipt.
    const lots: LotOut[] = [];
    const out: InvoiceLineInput[] = [];
    for (const [i, l] of lines.entries()) {
      const vatRate = l.vatRate ?? null;
      const taxCode = l.taxCode ?? null;
      if (l.kind === "EXPENSE") { out.push({ kind: "EXPENSE", expenseCategoryId: l.expenseCategoryId ?? null, description: l.description ?? null, net: l.net ?? "0", vatRate, taxCode }); continue; }
      if (l.kind === "IMPORT_VAT") { out.push({ kind: "IMPORT_VAT", description: l.description ?? null, net: "0", customsValue: l.customsValue ?? null, vatRate, taxCode: taxCode ?? "P-IMP15" }); continue; }
      if (l.kind === "LANDED_COST") { out.push({ kind: "LANDED_COST", targetPurchaseRecordId: l.targetPurchaseRecordId ?? null, landedCostType: l.landedCostType ?? null, description: l.description ?? null, net: l.net ?? "0", vatRate, taxCode }); continue; }
      if (l.kind === "GRN") { out.push({ kind: "GRN", purchaseRecordId: l.purchaseRecordId ?? null, description: l.description ?? null, quantity: l.quantity ?? null, net: l.net ?? (await grnValue(tx, String(l.purchaseRecordId ?? ""))).toFixed(2), vatRate, taxCode }); continue; }
      const s = stock.find((x) => x.i === i) as Stock;
      let itemId = s.stockItemId;
      let lot: LotOut | null = null;
      if (s.stockKind === "GREEN_BEAN") {
        if (s.newLot) {
          const f = greenLotFields(s.newLot);
          const b = await tx.greenBean.create({ data: { ...f, quantityKg: 0 }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true, country: true } });
          itemId = b.id;
          lot = { ...b, created: true };
          await logPurchaseActivity(tx, ctx, "PURCHASE_LOT_CREATED", invId, { lot: { id: b.id, serialNumber: b.serialNumber, beanType: b.beanType } });
        } else {
          const b = await tx.greenBean.findUnique({ where: { id: itemId ?? "" }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true, country: true, isActive: true } });
          if (!b || !b.isActive) throw opsRefuse("STOCK_ITEM_INVALID");
          lot = { id: b.id, serialNumber: b.serialNumber, beanType: b.beanType, beanTypeAr: b.beanTypeAr, country: b.country, created: false };
        }
      }
      let label: string;
      if (lot) label = `${lot.beanTypeAr ?? lot.beanType} · ${lot.serialNumber}`;
      else {
        const m = await tx.materialItem.findFirst({ where: { id: itemId ?? "", isActive: true }, select: { code: true, name: true, nameAr: true } });
        if (!m) throw opsRefuse("STOCK_ITEM_INVALID");
        label = `${m.nameAr ?? m.name} · ${m.code}`;
      }
      const description = s.description ?? label;
      if (action === "draft") {
        out.push({ kind: "STOCK", stockKind: s.stockKind, stockItemId: itemId, description, quantity: s.quantity.toFixed(), net: s.net.toFixed(2), vatRate, taxCode: lines[i].taxCode ?? null });
        continue;
      }
      const notes = `فاتورة مشتريات ${number} · ${h.supplierRef}`;
      const common = { value: s.net, lineKey: `SINV:${invId}`, purchaseDate: receivedDate, locationId: receivingLocationId };
      const purchaseRecordId = s.stockKind === "GREEN_BEAN"
        ? (await receiveGreen(tx, user, { supplierId: h.supplierId, greenBeanId: itemId as string, quantity: Number(s.quantity), costPerUnit: Number(s.unitCost), notes, ...common })).purchase.id
        : (await receiveMaterial(tx, user, { materialItemId: itemId as string, quantity: Number(s.quantity), supplierId: h.supplierId, reference: h.supplierRef, notes: `فاتورة مشتريات ${number}`, unitCost: Number(s.unitCost), ...common })).purchase!.id;
      if (lot) lots.push(lot);
      out.push({ kind: "GRN", purchaseRecordId, description, quantity: s.quantity.toFixed(), net: s.net.toFixed(2), vatRate, taxCode: lines[i].taxCode ?? null });
    }
    // Received lots kept from an earlier save (an edit) still offer their label.
    for (const pr of keep) {
      const r = await tx.purchaseRecord.findUnique({ where: { id: pr }, select: { type: true, itemId: true } });
      if (r?.type === "GREEN_BEAN" && r.itemId && !lots.some((x) => x.id === r.itemId)) {
        const b = await tx.greenBean.findUnique({ where: { id: r.itemId }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true, country: true } });
        if (b) lots.push({ ...b, created: false });
      }
    }

    const clean = await cleanLines(tx, supplier, out, { no: h.customsDeclarationNo });
    if (cur) await tx.supplierInvoiceLine.deleteMany({ where: { invoiceId: invId } });
    const now = new Date();
    await tx.supplierInvoice.update({
      where: { id: invId },
      data: {
        ...h, ...totals(clean), lastEditedBy: user.id, lines: { create: lineRows(clean) }, receivingLocationId,
        // The receipt day: set when this save receives; kept when an edit keeps earlier receipts; none for a draft.
        receivedDate: action === "draft" ? null : stock.length ? receivedDate : keep.size ? cur?.receivedDate ?? null : null,
        ...(action === "draft" ? { status: "DRAFT", submittedBy: null, submittedAt: null } : { status: "SUBMITTED", submittedBy: user.id, submittedAt: now }),
      },
    });
    // The activity log: what this save did, with the invoice before it when it changed one that had received.
    const did = action === "draft" ? "PURCHASE_INVOICE_SAVED" : own.length ? "PURCHASE_INVOICE_EDITED_AFTER_RECEIPT" : stock.length ? "PURCHASE_INVOICE_RECEIVED" : "PURCHASE_INVOICE_SUBMITTED";
    await logPurchaseActivity(tx, ctx, did, invId, before ? { before, reversedReceipts: reversing } : {});
    // The receipts' and reversals' entries post last (the deferred-posting rule), then the invoice itself.
    await flushPostings(tx);
    if (action === "post") await postInvoiceTx(tx, invId, ctx);
    return { invoice: await getInvoice(invId, tx), replayed: false, lots };
  }, { ...TX_OPTS, timeout: 60_000 });
}

async function grnValue(tx: Tx, purchaseRecordId: string): Promise<Decimal> {
  const m = await tx.costMove.findFirst({ where: { sourceType: "GRN", sourceId: purchaseRecordId, sourceEvent: "RECEIVED" }, select: { value: true } });
  return m ? new Decimal(m.value).abs() : ZERO;
}

/**
 * Cancel an invoice that is not posted: its own receipts are reversed (stock and cost back, their entries reversed)
 * and the invoice becomes CANCELLED with who, when and why (20261113090000_purchase_invoice_phase2) — it stays in
 * the list as «ملغاة» and its SINV number stays issued; nothing is ever deleted (a plain draft is cancelled the same
 * way, «إلغاء المسودة»). One transaction. A green lot this invoice brought in that has nothing else left (no stock,
 * no other movement, receipt, invoice line or roast) is set inactive, not deleted. A posted invoice is refused here
 * (its goods stay; the bill alone is cancelled by accounts payable, cancelInvoice).
 */
export async function cancelPurchaseInvoice(id: string, reason: string, user: ReceiptUser, ctx: AuditContext, opts: PurchaseGrants) {
  const r = str(reason, 500);
  if (!r || r.length < 3) throw opsRefuse("OPS_BAD_INPUT", "A reason is required.", "السبب مطلوب.");
  return withDeniedLog({ ...ctx, reason: r }, "cancel", id, () => prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    const inv = await lockInvoice(tx, id);
    const own = await ownReceipts(tx, id);
    if (inv.status === "POSTED") throw own.length ? opsRefuse("INVOICE_POSTED_RECEIVED") : opsRefuse("INVOICE_STATE");
    if (inv.status === "CANCELLED") throw opsRefuse("INVOICE_STATE");
    // A submitted invoice that received nothing itself goes back to draft first (returnInvoice), as before.
    if (inv.status === "SUBMITTED" && !own.length) throw opsRefuse("INVOICE_STATE", "Return it to draft first.", "أعدها للمسودة أولًا.");
    // CC4: reversing its receipts takes both the received-change grant and the receiving duty.
    if (own.length && opts?.mayChangeReceived !== true) throw opsRefuse("RECEIVED_CHANGE_REQUIRED");
    if (own.length && opts?.mayReceive !== true) throw opsRefuse("RECEIVE_REQUIRED");
    const reason480 = `إلغاء فاتورة المشتريات ${inv.number}: ${r}`.slice(0, 480);
    const before = await invoiceSummary(tx, id);
    // CC2 / N2 — the one lock order every stock operation takes (as saveTx): the stock rows of the receipts to reverse,
    // sorted (green lots, then materials, by id), then all their cost holders at once (lockHolders: sorted). The reverse
    // service takes them again (a no-op), so cancelling never waits in a circle with a packaging run or a save.
    if (own.length) {
      const rows = await tx.purchaseRecord.findMany({ where: { id: { in: own } }, select: { type: true, itemId: true, materialItemId: true } });
      const greens = [...new Set(rows.filter((x) => x.type === "GREEN_BEAN" && x.itemId).map((x) => x.itemId as string))].sort();
      const mats = [...new Set(rows.filter((x) => x.materialItemId).map((x) => x.materialItemId as string))].sort();
      for (const g of greens) await tx.$queryRaw`SELECT "id" FROM "GreenBean" WHERE "id" = ${g} FOR UPDATE`;
      for (const m of mats) await tx.$queryRaw`SELECT "id" FROM "MaterialItem" WHERE "id" = ${m} FOR UPDATE`;
      const recHolders = await tx.costMove.findMany({ where: { sourceType: "GRN", sourceId: { in: own }, sourceEvent: "RECEIVED" }, select: { costItem: { select: { kind: true, entityId: true } } } });
      await lockHolders(tx, recHolders.map((m) => ({ kind: m.costItem.kind as CostKind, entityId: m.costItem.entityId })));
    }
    for (const pr of own) {
      await reverseReceipt(tx, user, { purchaseRecordId: pr, reason: reason480, label: inv.number, exceptInvoiceId: id });
      await logPurchaseActivity(tx, { ...ctx, reason: r }, "PURCHASE_RECEIPT_REVERSED", id, { purchaseRecordId: pr });
    }
    await tx.supplierInvoice.update({ where: { id }, data: { status: "CANCELLED", cancelledBy: user.id, cancelledAt: new Date(), cancelReason: r } });
    const retired = await retireOrphanLots(tx, id);
    await logPurchaseActivity(tx, { ...ctx, reason: r }, "PURCHASE_INVOICE_CANCELLED", id, { before, reversedReceipts: own });
    for (const lot of retired) await logPurchaseActivity(tx, { ...ctx, reason: r }, "PURCHASE_LOT_RETIRED", id, { lot: { serialNumber: lot } });
    await flushPostings(tx);
    return { cancelled: true, number: inv.number, reversedReceipts: own.length, retiredLots: retired };
  }, { ...TX_OPTS, timeout: 60_000 }));
}

/**
 * The green lots of a cancelled invoice (its receipts' lots and its draft stock lines' lots) that have nothing else
 * left: no stock, no movement but this invoice's receipts and their reversals, no other receipt, no other live
 * invoice line, no roast. They are set inactive (kept, never deleted) so they do not clutter the green list.
 */
async function retireOrphanLots(tx: Tx, invoiceId: string): Promise<string[]> {
  const lines = await tx.supplierInvoiceLine.findMany({ where: { invoiceId }, select: { purchaseRecordId: true, stockKind: true, stockItemId: true } });
  const prIds = lines.map((l) => l.purchaseRecordId).filter((x): x is string => !!x);
  const prs = prIds.length ? await tx.purchaseRecord.findMany({ where: { id: { in: prIds }, type: "GREEN_BEAN" }, select: { id: true, itemId: true } }) : [];
  const lots = [...new Set([...prs.map((p) => p.itemId), ...lines.filter((l) => l.stockKind === "GREEN_BEAN").map((l) => l.stockItemId)].filter((x): x is string => !!x))];
  const retired: string[] = [];
  for (const lot of lots) {
    const b = await tx.greenBean.findUnique({ where: { id: lot }, select: { quantityKg: true, isActive: true, serialNumber: true } });
    if (!b || !b.isActive || Math.abs(b.quantityKg) > 0.0005) continue;
    const otherMoves = await tx.inventoryMovement.count({ where: { referenceEntityId: lot, NOT: { sourceDocType: "PURCHASE", sourceDocId: { in: prIds } } } });
    const otherReceipts = await tx.purchaseRecord.count({ where: { itemId: lot, type: "GREEN_BEAN", id: { notIn: prIds } } });
    const otherLines = await tx.supplierInvoiceLine.count({ where: { stockItemId: lot, invoiceId: { not: invoiceId }, invoice: { status: { not: "CANCELLED" } } } });
    const roasts = await tx.roastingBatch.count({ where: { greenBeanId: lot } });
    if (otherMoves || otherReceipts || otherLines || roasts) continue;
    await tx.greenBean.update({ where: { id: lot }, data: { isActive: false } });
    retired.push(b.serialNumber);
  }
  return retired;
}

// ─── Reads for the purchases screen ──────────────────────────────────────────────────────────────

/** The invoice with what the purchases screen needs on its lines: each GRN line's receipt (item, qty, unit cost, own). */
export async function getPurchaseInvoice(id: string) {
  const inv = await getInvoice(id);
  const live = new Set(await ownReceipts(prisma, id));
  // The receipts it received itself, reversed ones included (a cancelled invoice shows what it gave back).
  const own = new Set(await ownReceipts(prisma, id, { includeReversed: true }));
  const prIds = inv.lines.map((l) => l.purchaseRecordId).filter((x): x is string => !!x);
  const prs = prIds.length ? await prisma.purchaseRecord.findMany({ where: { id: { in: prIds } }, select: { id: true, type: true, itemId: true, materialItemId: true, quantity: true, costPerUnit: true, purchaseDate: true } }) : [];
  const reversed = new Set((prIds.length ? await prisma.costMove.findMany({ where: { sourceType: "GRN", sourceId: { in: prIds }, sourceEvent: "REVERSED" }, select: { sourceId: true } }) : []).map((m) => m.sourceId));
  const beanIds = [...prs.filter((p) => p.type === "GREEN_BEAN" && p.itemId).map((p) => p.itemId as string), ...inv.lines.filter((l) => l.stockKind === "GREEN_BEAN" && l.stockItemId).map((l) => l.stockItemId as string)];
  const matIds = [...prs.filter((p) => p.materialItemId).map((p) => p.materialItemId as string), ...inv.lines.filter((l) => l.stockKind === "MATERIAL" && l.stockItemId).map((l) => l.stockItemId as string)];
  const [beans, mats] = await Promise.all([
    beanIds.length ? prisma.greenBean.findMany({ where: { id: { in: beanIds } }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true, country: true } }) : [],
    matIds.length ? prisma.materialItem.findMany({ where: { id: { in: matIds } }, select: { id: true, code: true, name: true, nameAr: true, unitOfMeasure: true, categoryId: true } }) : [],
  ]);
  const prOf = new Map(prs.map((p) => [p.id, p]));
  return {
    ...inv,
    received: live.size > 0,
    reversedReceipts: [...own].filter((x) => !live.has(x)).length,
    lines: inv.lines.map((l) => {
      const p = l.purchaseRecordId ? prOf.get(l.purchaseRecordId) : undefined;
      const stockKind = p ? (p.type === "GREEN_BEAN" ? "GREEN_BEAN" : "MATERIAL") : l.stockKind;
      const itemId = p ? (p.type === "GREEN_BEAN" ? p.itemId : p.materialItemId) : l.stockItemId;
      return {
        ...l,
        receipt: p ? { id: p.id, own: own.has(p.id), reversed: reversed.has(p.id), quantity: p.quantity, costPerUnit: p.costPerUnit, date: p.purchaseDate.toISOString().slice(0, 10) } : null,
        item: stockKind && itemId ? { stockKind, id: itemId, bean: beans.find((b) => b.id === itemId) ?? null, material: mats.find((m) => m.id === itemId) ?? null } : null,
      };
    }),
  };
}

/** Suppliers with what purchasing needs: VAT number, terms, contact, open balance (posted, unpaid) and pending. */
export async function supplierBalances() {
  const [sups, open] = await Promise.all([
    prisma.supplier.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, contact: true, vatNumber: true, isNonResident: true, kind: true, paymentTermsDays: true, createdAt: true, _count: { select: { purchases: true } } } }),
    prisma.supplierInvoice.groupBy({ by: ["supplierId", "status"], where: { status: { in: ["POSTED", "SUBMITTED"] } }, _sum: { grossTotal: true, paidTotal: true }, _count: { _all: true } }),
  ]);
  return sups.map((s) => {
    const posted = open.find((o) => o.supplierId === s.id && o.status === "POSTED");
    const pending = open.find((o) => o.supplierId === s.id && o.status === "SUBMITTED");
    return {
      id: s.id, name: s.name, contact: s.contact, vatNumber: s.vatNumber, isNonResident: s.isNonResident, kind: s.kind, paymentTermsDays: s.paymentTermsDays, receipts: s._count.purchases,
      openBalance: new Decimal(posted?._sum.grossTotal ?? 0).minus(posted?._sum.paidTotal ?? 0).toFixed(2),
      awaitingApproval: new Decimal(pending?._sum.grossTotal ?? 0).toFixed(2),
    };
  });
}

/**
 * The receipts register (every goods receipt, newest first) with what became of each: the live invoice it is on
 * (number, status, whether that invoice received it itself), or not invoiced yet; reversed receipts are marked.
 */
export async function receiptRegister(q: { from?: string | null; take?: number }) {
  const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? new Date(`${q.from}T00:00:00Z`) : null;
  const rows = await prisma.purchaseRecord.findMany({
    where: from ? { purchaseDate: { gte: from } } : undefined,
    orderBy: [{ purchaseDate: "desc" }, { createdAt: "desc" }], take: Math.min(q.take ?? 1000, 2000),
    include: { supplier: { select: { id: true, name: true, contact: true } } },
  });
  const ids = rows.map((r) => r.id);
  const [lines, moves] = await Promise.all([
    ids.length ? prisma.supplierInvoiceLine.findMany({ where: { purchaseRecordId: { in: ids } }, select: { purchaseRecordId: true, invoice: { select: { id: true, number: true, status: true } } } }) : [],
    ids.length ? prisma.costMove.findMany({ where: { sourceType: "GRN", sourceId: { in: ids } }, select: { sourceId: true, sourceEvent: true, lineKey: true, value: true } }) : [],
  ]);
  const beanIds = [...new Set(rows.filter((r) => r.type === "GREEN_BEAN" && r.itemId).map((r) => r.itemId as string))];
  const matIds = [...new Set(rows.filter((r) => r.materialItemId).map((r) => r.materialItemId as string))];
  const [beans, mats] = await Promise.all([
    beanIds.length ? prisma.greenBean.findMany({ where: { id: { in: beanIds } }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true } }) : [],
    matIds.length ? prisma.materialItem.findMany({ where: { id: { in: matIds } }, select: { id: true, code: true, name: true, nameAr: true, unitOfMeasure: true } }) : [],
  ]);
  return rows.map((r) => {
    // A cancelled invoice stays (phase 2): it is shown on the receipts it reversed; a receipt it only referenced is
    // open again (not invoiced) — a live invoice always wins.
    const linked = lines.filter((l) => l.purchaseRecordId === r.id);
    const reversed = moves.some((m) => m.sourceId === r.id && m.sourceEvent === "REVERSED");
    const inv = (linked.find((l) => l.invoice.status !== "CANCELLED") ?? (reversed ? linked[0] : undefined))?.invoice ?? null;
    const rec = moves.find((m) => m.sourceId === r.id && m.sourceEvent === "RECEIVED");
    const bean = r.type === "GREEN_BEAN" ? beans.find((b) => b.id === r.itemId) ?? null : null;
    const mat = r.materialItemId ? mats.find((m) => m.id === r.materialItemId) ?? null : null;
    return {
      id: r.id, type: r.type, supplier: r.supplier, purchaseDate: r.purchaseDate.toISOString(), createdAt: r.createdAt.toISOString(),
      quantity: r.quantity, costPerUnit: r.costPerUnit, totalCost: r.totalCost, notes: r.notes, itemId: r.itemId,
      item: bean ? { kind: "GREEN_BEAN", id: bean.id, code: bean.serialNumber, name: bean.beanType, nameAr: bean.beanTypeAr, unit: "KG" } : mat ? { kind: "MATERIAL", id: mat.id, code: mat.code, name: mat.name, nameAr: mat.nameAr, unit: mat.unitOfMeasure } : null,
      value: rec ? new Decimal(rec.value).abs().toFixed(2) : null,
      reversed,
      invoice: inv ? { ...inv, own: rec?.lineKey === `SINV:${inv.id}` } : null,
    };
  });
}
