/**
 * Goods receipts — the ONE place that receives purchased stock, shared by every receive path:
 *   · POST /api/purchases                 — a green-coffee receipt («استلام بدون فاتورة», the exception path);
 *   · POST /api/materials/:id/receive     — a packaging / café material delivery (routine receiving);
 *   · the one-step purchase invoice       — «حفظ واستلام» (src/lib/accounting/ops/purchase-invoice.ts).
 * Extracted from the two routes unchanged, so the invoice raises stock, the movement ledger, the audit and the cost
 * sub-ledger exactly as a receipt always has. Each runs INSIDE the caller's transaction, which must call
 * flushPostings(tx) last (the receipt's entry is queued, cost-ledger.ts).
 *
 * The reverse — a receipt undone before its goods were used (phase 2: an un-posted purchase invoice cancelled or
 * edited) — is here too: the quantity leaves the stock row (an OUT movement on the PURCHASE source) and the cost
 * holder at the value it came in at, the receipt's entry is reversed (onReceiptReversed), and the person audit
 * records it. Refused once anything has drawn on the item since the receipt (a roast, a pack, an issue, a count):
 * the goods are no longer the ones received, and a supplier return is a separate document (a later phase).
 *
 * Phase 3 (20261115090000_stock_locations): a receipt books INTO a location — `locationId` (the invoice's «موقع
 * الاستلام»), else the default site — and records it on the receipt (PurchaseRecord.locationId); the reversal takes the
 * goods back from that same location (refused, STOCK_LOCATION_SHORT, when they have been moved from it).
 */
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/hr/core";
import { Decimal } from "@/lib/accounting/money";
import { onGreenReceipt, onMaterialReceipt, onReceiptReversed } from "@/lib/accounting/ops/inventory-events";
import { auditInventoryReceipt } from "./inventory-receiving";
import { parseStockQuantity } from "./stock-quantity";
import { defaultLocationId, withStockLocation } from "./stock-locations";

type Tx = Prisma.TransactionClient;
export type ReceiptUser = { id: string; name?: string | null; sessionId?: string };
type AppError = { _appCode: number; message: string; code?: string; errorAr?: string; errorEn?: string };
const appError = (status: number, en: string, ar: string, code: string): AppError => ({ _appCode: status, message: ar, errorAr: ar, errorEn: en, code });

/** A green-coffee receipt (PurchaseRecord GREEN_BEAN + IN movement + the lot's balance + the GRN cost / entry). */
export async function receiveGreen(tx: Tx, user: ReceiptUser, a: { supplierId: string; greenBeanId: string; quantity: number; costPerUnit: number; purchaseDate: Date; notes: string | null; value?: Decimal; lineKey?: string; locationId?: string | null }) {
  // Lock the coffee BEFORE the loose rows are written (PurchaseRecord.itemId and the movement's referenceEntityId
  // carry no foreign key): it queues this receipt behind a concurrent DELETE /api/green-beans/:id, which locks the
  // same row and refuses while references exist — either the delete sees these rows, or this receipt finds the
  // coffee gone and rolls back. GreenBean stays the first lock the transaction takes.
  const locked = await tx.$queryRaw<{ id: string; quantityKg: number }[]>`
    SELECT "id", "quantityKg" FROM "GreenBean" WHERE "id" = ${a.greenBeanId} FOR UPDATE`;
  const bean = locked[0];
  if (!bean) throw { _appCode: 404, message: "Green bean not found." };
  // The receiving site: the one asked for, else the default receiving site — named explicitly, restored after.
  const loc = a.locationId ?? (await defaultLocationId(tx));
  return withStockLocation(tx, loc, async () => {
    const previousQuantity = bean.quantityKg;
    const newQuantity = previousQuantity + a.quantity;
    const totalCost = a.value ? Number(a.value.toFixed(2)) : +(a.quantity * a.costPerUnit).toFixed(4);

    const purchase = await tx.purchaseRecord.create({
      data: { supplierId: a.supplierId, type: "GREEN_BEAN", itemId: a.greenBeanId, quantity: a.quantity, costPerUnit: a.costPerUnit, totalCost, purchaseDate: a.purchaseDate, notes: a.notes, userId: user.id, locationId: loc },
      include: { supplier: true },
    });
    const movement = await tx.inventoryMovement.create({
      data: { type: "IN", category: "RAW_MATERIAL", referenceEntityId: a.greenBeanId, quantityChanged: a.quantity, previousQuantity, newQuantity, sourceDocType: "PURCHASE", sourceDocId: purchase.id, userId: user.id, notes: a.notes, locationId: loc },
    });
    const updatedBean = await tx.greenBean.update({ where: { id: a.greenBeanId }, data: { quantityKg: { increment: a.quantity } } });
    // Accounting A3: the receipt is a GRN — costed into the green lot's moving average, and (once accounting is live)
    // posted Dr INVENTORY_GREEN / Cr GRNI for the supplier, in this transaction.
    await onGreenReceipt(tx, { purchaseId: purchase.id, greenBeanId: a.greenBeanId, supplierId: a.supplierId, qtyKg: a.quantity, unitCost: a.costPerUnit, purchaseDate: purchase.purchaseDate, actor: user.id, movementId: movement.id, value: a.value, lineKey: a.lineKey });
    return { purchase, updatedBean, movementId: movement.id };
  });
}

/**
 * A material delivery (bags, labels, cartons, café stock). With a supplier and a unit cost > 0 it is a costed GRN
 * (a purchase record); otherwise the quantity arrives at zero cost. `quantity` is validated by the caller's parser;
 * the whole-number rule of a piece-counted material is checked here, under the row lock.
 */
export async function receiveMaterial(tx: Tx, user: ReceiptUser, a: { materialItemId: string; quantity: number; rawQuantity?: unknown; supplierId: string | null; reference: string | null; notes: string | null; unitCost: number | null; purchaseDate?: Date; value?: Decimal; lineKey?: string; locationId?: string | null }) {
  // Lock the material row first. A count (PATCH /api/materials/:id) takes the same lock, so a receipt and a count
  // are serialised and neither loses the other's units; a packaging draw decrements atomically and reads back.
  const locked = await tx.$queryRaw<{ id: string; quantityOnHand: number; isActive: boolean; unitOfMeasure: string }[]>`
    SELECT "id", "quantityOnHand", "isActive", "unitOfMeasure"::text AS "unitOfMeasure" FROM "MaterialItem" WHERE "id" = ${a.materialItemId} FOR UPDATE`;
  const item = locked[0];
  if (!item) throw { _appCode: 404, message: "Material not found." };
  if (!parseStockQuantity(a.rawQuantity ?? a.quantity, { allowZero: false, unitOfMeasure: item.unitOfMeasure }).ok)
    throw { _appCode: 400, message: `quantity must be a whole number for a material counted in ${item.unitOfMeasure.toLowerCase()}s.`, code: "RECEIVE_QUANTITY_INVALID" };
  if (!item.isActive) throw { _appCode: 409, message: "This material is inactive; reactivate it before receiving." };
  const loc = a.locationId ?? (await defaultLocationId(tx));
  return withStockLocation(tx, loc, async () => {
    const supplier = a.supplierId ? await tx.supplier.findUnique({ where: { id: a.supplierId }, select: { id: true, name: true } }) : null;
    if (a.supplierId && !supplier) throw { _appCode: 404, message: "Supplier not found." };

    const previousQuantity = item.quantityOnHand;
    const newQuantity = Number((previousQuantity + a.quantity).toFixed(4));
    const label = [supplier ? `Supplier: ${supplier.name}` : null, a.reference ? `Ref: ${a.reference}` : null, a.notes].filter(Boolean).join(" · ");
    const movement = await tx.inventoryMovement.create({
      data: { type: "IN", category: "PACKAGING_MATERIAL", referenceEntityId: a.materialItemId, quantityChanged: a.quantity, previousQuantity, newQuantity, sourceDocType: "RECEIVING", sourceDocId: supplier?.id ?? a.materialItemId, userId: user.id, notes: `Received · ${label}`.slice(0, 1000), locationId: loc },
    });
    const updated = await tx.materialItem.update({ where: { id: a.materialItemId }, data: { quantityOnHand: newQuantity } });
    const costed = !!supplier && a.unitCost !== null && a.unitCost > 0;
    const purchase = costed
      ? await tx.purchaseRecord.create({ data: { supplierId: supplier!.id, type: "PACKAGING", itemId: a.materialItemId, materialItemId: a.materialItemId, quantity: a.quantity, costPerUnit: a.unitCost!, totalCost: a.value ? Number(a.value.toFixed(2)) : +(a.quantity * a.unitCost!).toFixed(4), purchaseDate: a.purchaseDate ?? new Date(), notes: [a.reference ? `Ref: ${a.reference}` : null, a.notes].filter(Boolean).join(" · ") || null, userId: user.id, locationId: loc } })
      : null;
    await onMaterialReceipt(tx, { sourceId: purchase?.id ?? movement.id, materialItemId: a.materialItemId, supplierId: purchase ? supplier!.id : null, qty: a.quantity, unitCost: purchase ? a.unitCost : null, actor: user.id, movementId: movement.id, value: purchase ? a.value : undefined, lineKey: a.lineKey, purchaseDate: a.purchaseDate });
    await auditInventoryReceipt(tx, user, { entityId: a.materialItemId, opening: false, movementId: movement.id, quantity: a.quantity, previousQuantity, newQuantity, supplier, reference: a.reference, notes: a.notes });
    return { material: updated, movement, purchase };
  });
}

/** The bilingual refusal of a receipt whose goods have been used since it was received. */
export function receiptConsumedError(label: string): AppError {
  return appError(409,
    `The goods of receipt ${label} have been used since they were received (roasted, packed, issued or counted), so the receipt cannot be reversed. A supplier return comes in a later phase; until then, correct the difference with a stock count.`,
    `بضاعة الاستلام ${label} استُخدمت بعد استلامها (تحميص أو تعبئة أو صرف أو جرد)، فلا يمكن عكس الاستلام. مرتجع المورد يأتي في مرحلة لاحقة؛ حتى ذلك الحين تُصحَّح الفروقات بالجرد.`,
    "RECEIPT_CONSUMED");
}

/**
 * Reverse one receipt (PurchaseRecord) in the caller's transaction. Refused (RECEIPT_CONSUMED) when the item has
 * less on hand than was received or anything drew on it since the receipt. Idempotent: a receipt reversed already
 * (its REVERSED cost movement exists) is left as it is.
 */
export async function reverseReceipt(tx: Tx, user: ReceiptUser, a: { purchaseRecordId: string; reason: string; label?: string; exceptInvoiceId?: string }) {
  const pr = await tx.purchaseRecord.findUnique({ where: { id: a.purchaseRecordId } });
  if (!pr) throw appError(404, "The goods receipt was not found.", "سند الاستلام غير موجود.", "GRN_NOT_FOUND");
  const green = pr.type === "GREEN_BEAN";
  const entityId = green ? pr.itemId : pr.materialItemId;
  if (!entityId) throw appError(409, "The goods receipt names no stock item.", "سند الاستلام لا يذكر صنف مخزون.", "STOCK_ITEM_INVALID");
  // The refusal names the item (the lot's serial or the material's code) and, when given, the document.
  const item = green
    ? (await tx.greenBean.findUnique({ where: { id: entityId }, select: { serialNumber: true } }))?.serialNumber
    : (await tx.materialItem.findUnique({ where: { id: entityId }, select: { code: true } }))?.code;
  const label = [item ?? pr.id.slice(-6), a.label].filter(Boolean).join(" · ");
  // Lock the stock row first (the one direction every stock operation takes), then read the cost history.
  const rows = green
    ? await tx.$queryRaw<{ q: number }[]>`SELECT "quantityKg" AS q FROM "GreenBean" WHERE "id" = ${entityId} FOR UPDATE`
    : await tx.$queryRaw<{ q: number }[]>`SELECT "quantityOnHand" AS q FROM "MaterialItem" WHERE "id" = ${entityId} FOR UPDATE`;
  if (!rows[0]) throw appError(404, "The stock item was not found.", "صنف المخزون غير موجود.", "STOCK_ITEM_INVALID");
  // The goods leave the location they were received at (the site balance trigger refuses if they are not all there).
  return withStockLocation(tx, pr.locationId, async () => {
    if (await tx.costMove.count({ where: { sourceType: "GRN", sourceId: pr.id, sourceEvent: "REVERSED" } })) return { reversed: false, already: true };
    const rec = await tx.costMove.findFirst({ where: { sourceType: "GRN", sourceId: pr.id, sourceEvent: "RECEIVED" }, select: { costItemId: true, createdAt: true } });
    const onHand = rows[0].q;
    if (onHand + 1e-9 < pr.quantity) throw receiptConsumedError(label);
    if (rec) {
      // Anything that drew on the holder after the receipt (an issue, a write-off, a count shortage…).
      // A transfer between sites is not a use (phase 3): whether the goods are still at the receiving site is the site
      // balance's question, which stock_balance_sync answers on the reversal itself (STOCK_LOCATION_SHORT).
      const drawn = await tx.costMove.count({ where: { costItemId: rec.costItemId, createdAt: { gt: rec.createdAt }, qty: { lt: 0 }, NOT: [{ sourceType: "GRN", sourceEvent: "REVERSED" }, { sourceType: "STOCK_TRANSFER" }] } });
      if (drawn) throw receiptConsumedError(label);
    }
    // CC6: the stock movements as well — an OUT (or any decrease) on the item after the receipt that the cost ledger
    // did not see (a movement recorded before accounting was live, a zero-cost draw) still means the goods were used.
    // A receipt reversal (source PURCHASE) is not a use.
    const outs = await tx.inventoryMovement.count({ where: { referenceEntityId: entityId, timestamp: { gt: pr.createdAt }, quantityChanged: { lt: 0 }, sourceDocType: { notIn: ["PURCHASE", "STOCK_TRANSFER"] } } });
    if (outs) throw receiptConsumedError(label);
    // A landed cost (freight, duty…) capitalised — or waiting to be — onto this receipt by another live invoice.
    const landed = await tx.supplierInvoiceLine.count({ where: { targetPurchaseRecordId: pr.id, invoice: { status: { not: "CANCELLED" }, ...(a.exceptInvoiceId ? { id: { not: a.exceptInvoiceId } } : {}) } } });
    if (landed) throw appError(409, "Landed costs were added to this receipt on another invoice: cancel that invoice first, then the receipt can be reversed.", "أُضيفت تكاليف إضافية إلى هذا الاستلام في فاتورة أخرى: ألغِ تلك الفاتورة أولًا ثم يمكن عكس الاستلام.", "RECEIPT_HAS_LANDED_COST");
    // «نقص من المورد»: replacement goods for a supplier claim settle it — the receipt stays (the claim would reopen).
    if (await tx.supplierClaimSettlement.count({ where: { purchaseRecordId: pr.id, kind: "REPLACEMENT", voidedAt: null } })) throw appError(409, "This receipt is replacement goods for a supplier claim and settles it, so it is not reversed; correct a difference with a stock count.", "هذا الاستلام بضاعة بديلة عن مطالبة مورد ويسوّيها، فلا يُعكس؛ تُصحَّح الفروقات بالجرد.", "RECEIPT_REPLACES_CLAIM");
    const previousQuantity = onHand;
    const newQuantity = Number((onHand - pr.quantity).toFixed(4));
    const note = `Receipt reversed · ${a.reason}`.slice(0, 1000);
    const movement = await tx.inventoryMovement.create({
      data: { type: "OUT", category: green ? "RAW_MATERIAL" : "PACKAGING_MATERIAL", referenceEntityId: entityId, quantityChanged: -pr.quantity, previousQuantity, newQuantity, sourceDocType: "PURCHASE", sourceDocId: pr.id, userId: user.id, notes: note, locationId: pr.locationId },
    });
    if (green) await tx.greenBean.update({ where: { id: entityId }, data: { quantityKg: newQuantity } });
    else await tx.materialItem.update({ where: { id: entityId }, data: { quantityOnHand: newQuantity } });
    await onReceiptReversed(tx, { purchaseId: pr.id, reason: a.reason, actor: user.id, movementId: movement.id });
    await audit(tx, {
      action: "INVENTORY_RECEIPT_REVERSED", entityType: green ? "GreenBean" : "MaterialItem", entityId, reason: a.reason, actorId: user.id,
      before: { quantity: previousQuantity }, after: { quantity: newQuantity, purchaseRecordId: pr.id, movementId: movement.id, login: { id: user.id, name: user.name ?? null, sessionId: user.sessionId ?? null } },
    });
    return { reversed: true, already: false, movementId: movement.id };
  });
}
