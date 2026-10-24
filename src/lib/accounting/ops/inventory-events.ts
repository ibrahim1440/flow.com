// Accounting A3 — the inventory events: each operational stock movement → its cost movements (moving average,
// with the unit-cost snapshot) → its journal entry by role (POSTING-CONTRACT.md §4). Called INSIDE the operation's
// transaction, after the operation has moved its own stock (so the operation's row lock is taken first). Before
// activation / go-live the cost sub-ledger still moves (costs keep flowing — the opening valuation reads them) and
// the entry is skipped; nothing is ever posted for a day before go-live.
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { reverseEntry, type PostingDims } from "../posting-engine";
import { toBusinessDay } from "../dates";
import { LOSS_WARN_POINTS } from "@/lib/station/shared";
import { Decimal, ZERO, roundMoney } from "../money";
import { qty4, roastCost, split } from "./costing";
import { costIn, costOut, lockHolder, lockHolders, postAndResolve, resolveNone, side, type CostKind, type HolderRow, type MoveResult, type Src } from "./cost-ledger";

type Tx = Prisma.TransactionClient;
const kg = (n: number | Decimal) => qty4(n);
const greenDim = (id: string): PostingDims => ({ item: { type: "GREEN_BEAN", id } });
const materialDim = (id: string): PostingDims => ({ item: { type: "MATERIAL", id } });
const productDim = (id: string | null | undefined): PostingDims | undefined => (id ? { item: { type: "COFFEE_PRODUCT", id } } : undefined);
const skuDim = (skuId: string | null | undefined, productId?: string | null): PostingDims | undefined => (skuId ? { item: { type: "PRODUCT_SKU", id: skuId } } : productDim(productId));
const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * The costing policy: the abnormal roast-loss threshold (% of green) for a roast of `productId`, or null (every
 * loss is normal). With `abnormalUseProductLimit`, the product's expected loss + LOSS_WARN_POINTS — the boundary the
 * roasting station already flags «فوق الحد» — and the fixed percentage only as the fallback.
 */
export async function abnormalThreshold(tx: Tx, productId?: string | null): Promise<Decimal | null> {
  const s = await tx.costingSettings.findUnique({ where: { id: "singleton" }, select: { abnormalRoastLossPct: true, abnormalUseProductLimit: true } });
  if (s?.abnormalUseProductLimit && productId) {
    const p = await tx.coffeeProduct.findUnique({ where: { id: productId }, select: { expectedRoastLoss: true } });
    if (p && Number.isFinite(p.expectedRoastLoss)) return new Decimal(Math.min(99, p.expectedRoastLoss + LOSS_WARN_POINTS).toFixed(2));
  }
  return s?.abnormalRoastLossPct === null || s?.abnormalRoastLossPct === undefined ? null : new Decimal(s.abnormalRoastLossPct);
}

// ─── Receipts (GRN) ──────────────────────────────────────────────────────────────────────────────

/** Green coffee received on a purchase (PurchaseRecord): Dr INVENTORY_GREEN / Cr GRNI (party = supplier). */
export async function onGreenReceipt(tx: Tx, a: { purchaseId: string; greenBeanId: string; supplierId: string; qtyKg: number; unitCost: number; purchaseDate: Date; actor: string; movementId?: string | null }) {
  const h = await lockHolder(tx, "GREEN_BEAN", a.greenBeanId);
  const value = roundMoney(new Decimal(a.qtyKg.toFixed(6)).times(new Decimal(a.unitCost.toFixed(6))));
  const src: Src = { module: "purchasing", type: "GRN", id: a.purchaseId, event: "RECEIVED" };
  const m = await costIn(tx, { holder: h, src, kind: "RECEIPT", qty: kg(a.qtyKg), value, actor: a.actor, inventoryMovementId: a.movementId, day: dayOf(a.purchaseDate) });
  return postAndResolve(tx, [m.id], {
    source: src, date: dayOf(a.purchaseDate), memo: `استلام بن أخضر (سند ${a.purchaseId})`, createdBy: a.actor,
    lines: [side(h.role, m.value, greenDim(a.greenBeanId)), side("GRNI", m.value.negated(), { party: { type: "SUPPLIER", id: a.supplierId } })],
  });
}

/**
 * Packaging / café material received. With a supplier and a unit cost it is a costed GRN (Dr INVENTORY_PACKAGING
 * or INVENTORY_CAFE / Cr GRNI); without a cost the quantity is received at zero value and the supplier invoice
 * later capitalises its cost (a STOCK line).
 */
export async function onMaterialReceipt(tx: Tx, a: { sourceId: string; materialItemId: string; supplierId: string | null; qty: number; unitCost: number | null; actor: string; movementId?: string | null }) {
  const h = await lockHolder(tx, "MATERIAL", a.materialItemId);
  const value = a.unitCost && a.unitCost > 0 ? roundMoney(new Decimal(a.qty.toFixed(6)).times(new Decimal(a.unitCost.toFixed(6)))) : ZERO;
  const src: Src = { module: "purchasing", type: "GRN", id: a.sourceId, event: "RECEIVED" };
  const m = await costIn(tx, { holder: h, src, kind: "RECEIPT", qty: kg(a.qty), value, actor: a.actor, inventoryMovementId: a.movementId });
  if (!a.supplierId || value.isZero()) { await resolveNone(tx, [m.id]); return { status: "none" as const }; }
  return postAndResolve(tx, [m.id], {
    source: src, memo: `استلام مواد (سند ${a.sourceId})`, createdBy: a.actor,
    lines: [side(h.role, m.value, materialDim(a.materialItemId)), side("GRNI", m.value.negated(), { party: { type: "SUPPLIER", id: a.supplierId } })],
  });
}

/** Stock a new green lot / material is created with (no cost given): received at zero value — the opening valuation costs it. */
export async function onOpeningStock(tx: Tx, a: { kind: "GREEN_BEAN" | "MATERIAL"; entityId: string; qty: number; actor: string; movementId?: string | null }) {
  const h = await lockHolder(tx, a.kind, a.entityId);
  const m = await costIn(tx, { holder: h, src: { module: "inventory", type: "OPENING_STOCK", id: a.entityId, event: "CREATED" }, kind: "RECEIPT", qty: kg(a.qty), value: ZERO, actor: a.actor, inventoryMovementId: a.movementId, reason: "رصيد عند الإنشاء بلا تكلفة" });
  await resolveNone(tx, [m.id]);
}

// ─── Stock adjustments / counts ──────────────────────────────────────────────────────────────────

/**
 * An approved count / adjustment (a reason is required by the operation): a shortage is issued at the moving
 * average (Dr INVENTORY_VARIANCE / Cr INVENTORY_*), a surplus received at the average — or the last known cost
 * when the holder is empty (Dr INVENTORY_* / Cr INVENTORY_VARIANCE). The movement id is the source.
 */
export async function onAdjustment(tx: Tx, a: { kind: "GREEN_BEAN" | "MATERIAL"; entityId: string; qtyChange: number; newQty: number; movementId: string; reason: string; actor: string }) {
  const h = await lockHolder(tx, a.kind, a.entityId);
  const src: Src = { module: "inventory", type: "STOCK_ADJUSTMENT", id: a.movementId, event: "APPROVED" };
  const q = kg(Math.abs(a.qtyChange));
  let m: MoveResult;
  if (a.qtyChange < 0) {
    m = await costOut(tx, { holder: h, src, kind: "ADJUSTMENT", qty: q, closeOut: a.newQty <= 0, actor: a.actor, inventoryMovementId: a.movementId, reason: a.reason });
  } else {
    const unit = h.qty.gt(0) ? h.avgCost : h.lastInCost ?? ZERO;
    m = await costIn(tx, { holder: h, src, kind: "ADJUSTMENT", qty: q, value: roundMoney(q.times(unit)), actor: a.actor, inventoryMovementId: a.movementId, reason: a.reason });
  }
  const dims = a.kind === "GREEN_BEAN" ? greenDim(a.entityId) : materialDim(a.entityId);
  const sign = a.qtyChange < 0 ? -1 : 1;
  return postAndResolve(tx, [m.id], {
    source: src, memo: `تسوية مخزون: ${a.reason}`.slice(0, 480), createdBy: a.actor,
    lines: [side(h.role, m.value.times(sign), dims), side("INVENTORY_VARIANCE", m.value.times(-sign), dims)],
  });
}

// ─── Production: the roast ───────────────────────────────────────────────────────────────────────

/**
 * A roast recorded: green out at the moving average (GREEN_ISSUED: Dr WIP_ROASTING / Cr INVENTORY_GREEN), roasted
 * coffee in (COMPLETED: Dr INVENTORY_ROASTED green cost − abnormal loss, Dr ROAST_LOSS abnormal loss / Cr
 * WIP_ROASTING). A roast is recorded with its measured output in one step, so both events post in its transaction.
 */
export async function onRoast(tx: Tx, a: { batchId: string; batchNumber: string; greenBeanId: string; greenKg: number; roastedKg: number; productId: string | null; actor: string; movementId?: string | null }) {
  const holders = await lockHolders(tx, [{ kind: "GREEN_BEAN", entityId: a.greenBeanId }, { kind: "ROASTED_BATCH", entityId: a.batchId }]);
  const green = holders.get(`GREEN_BEAN:${a.greenBeanId}`) as HolderRow;
  const roasted = holders.get(`ROASTED_BATCH:${a.batchId}`) as HolderRow;
  const issueSrc: Src = { module: "production", type: "ROAST_BATCH", id: a.batchId, event: "GREEN_ISSUED" };
  const doneSrc: Src = { module: "production", type: "ROAST_BATCH", id: a.batchId, event: "COMPLETED" };
  const out = await costOut(tx, { holder: green, src: issueSrc, kind: "ISSUE", qty: kg(a.greenKg), actor: a.actor, inventoryMovementId: a.movementId });
  const c = roastCost(kg(a.greenKg), kg(a.roastedKg), out.value, await abnormalThreshold(tx, a.productId));
  const inn = await costIn(tx, { holder: roasted, src: doneSrc, kind: "RECEIPT", qty: c.roastedKg, value: c.roastedCost, actor: a.actor, reason: c.abnormalCost.gt(0) ? `فاقد غير طبيعي ${c.abnormalLossKg.toFixed(3)} كغ` : null });
  const pDim = productDim(a.productId);
  await postAndResolve(tx, [out.id], {
    source: issueSrc, memo: `صرف بن أخضر للتحميص · دفعة ${a.batchNumber}`, createdBy: a.actor,
    lines: [side("WIP_ROASTING", out.value, pDim), side(green.role, out.value.negated(), greenDim(a.greenBeanId))],
  });
  await postAndResolve(tx, [inn.id], {
    source: doneSrc, memo: `اكتمال التحميص · دفعة ${a.batchNumber} · فاقد ${c.lossPct.toFixed(2)}%`, createdBy: a.actor,
    lines: [side(roasted.role, c.roastedCost, pDim), side("ROAST_LOSS", c.abnormalCost, pDim), side("WIP_ROASTING", out.value.negated(), pDim)],
  });
  return c;
}

/**
 * A roast cancelled (deleted). Restocked: the green comes back at its original cost; the roasted stock left and any
 * abnormal loss / QC write-off of this roast are credited back (Dr INVENTORY_GREEN / Cr INVENTORY_ROASTED, ROAST_LOSS,
 * WASTAGE — or INVENTORY_VARIANCE when the roast itself was never posted). Not restocked: the roasted stock left is
 * written off (Dr WASTAGE / Cr INVENTORY_ROASTED). `production · ROAST_BATCH · CANCELLED`.
 */
export async function onRoastCancelled(tx: Tx, a: { batchId: string; batchNumber: string; greenBeanId: string | null; greenKg: number; restock: boolean; productId: string | null; reason: string | null; actor: string; movementId?: string | null }) {
  const src: Src = { module: "production", type: "ROAST_BATCH", id: a.batchId, event: "CANCELLED" };
  const roasted = await lockHolder(tx, "ROASTED_BATCH", a.batchId);
  const pDim = productDim(a.productId);
  if (!a.restock || !a.greenBeanId) {
    const out = await costOut(tx, { holder: roasted, src, kind: "WRITE_OFF", qty: roasted.qty, closeOut: true, actor: a.actor, reason: a.reason });
    return postAndResolve(tx, [out.id], {
      source: src, memo: `إلغاء دفعة ${a.batchNumber} وشطب المحمص`, createdBy: a.actor,
      lines: [side("WASTAGE", out.value, pDim), side(roasted.role, out.value.negated(), pDim)],
    });
  }
  const moves = await tx.costMove.findMany({ where: { sourceType: "ROAST_BATCH", sourceId: a.batchId, sourceEvent: { in: ["GREEN_ISSUED", "COMPLETED"] } }, select: { sourceEvent: true, value: true, glState: true } });
  const issued = moves.find((m) => m.sourceEvent === "GREEN_ISSUED");
  const completed = moves.find((m) => m.sourceEvent === "COMPLETED");
  const green = await lockHolder(tx, "GREEN_BEAN", a.greenBeanId);
  const out = await costOut(tx, { holder: roasted, src, kind: "RETURN", qty: roasted.qty, closeOut: true, actor: a.actor, reason: a.reason });
  // A roast costed before the cost ledger existed (no GREEN_ISSUED movement): the green comes back at what the roast
  // still holds (its opening value), so nothing is expensed or credited for a history the books never saw.
  const g = issued ? new Decimal(issued.value).abs() : out.value;
  const r = completed ? new Decimal(completed.value) : out.value;
  const back = await costIn(tx, { holder: green, src, kind: "RETURN", qty: kg(a.greenKg), value: g, actor: a.actor, inventoryMovementId: a.movementId, reason: a.reason });
  const abnormal = g.minus(r);                  // ROAST_LOSS posted at completion
  const writtenOff = r.minus(out.value);         // WASTAGE posted by QC write-offs of this roast
  const wasPosted = issued?.glState === "POSTED";
  return postAndResolve(tx, [out.id, back.id], {
    source: src, memo: `إلغاء دفعة ${a.batchNumber} وإرجاع البن الأخضر`, createdBy: a.actor,
    lines: [
      side(green.role, back.value, greenDim(a.greenBeanId)),
      side(roasted.role, out.value.negated(), pDim),
      side(wasPosted ? "ROAST_LOSS" : "INVENTORY_VARIANCE", abnormal.negated(), pDim),
      side(wasPosted ? "WASTAGE" : "INVENTORY_VARIANCE", writtenOff.negated(), pDim),
    ],
  });
}

/**
 * Roasted coffee written off — a QC rejection (G05) or an approved destruction (QC disposition): Dr WASTAGE /
 * Cr INVENTORY_ROASTED at the roast's cost. `closeOut` when the roast holds nothing more.
 */
export async function onRoastedWriteOff(tx: Tx, a: { batchId: string; kg: number; closeOut: boolean; src: Src; productId: string | null; memo: string; reason: string | null; actor: string; movementId?: string | null }) {
  const h = await lockHolder(tx, "ROASTED_BATCH", a.batchId);
  const out = await costOut(tx, { holder: h, src: a.src, kind: "WRITE_OFF", qty: kg(a.kg), closeOut: a.closeOut, actor: a.actor, inventoryMovementId: a.movementId, reason: a.reason });
  const pDim = productDim(a.productId);
  return postAndResolve(tx, [out.id], { source: a.src, memo: a.memo, createdBy: a.actor, lines: [side("WASTAGE", out.value, pDim), side(h.role, out.value.negated(), pDim)] });
}

// ─── Production: blending and packaging ──────────────────────────────────────────────────────────

/** A blend: roasted coffee moves from its sources into the blend roast at their costs (cost carried over). One role → nothing to post. */
export async function onBlend(tx: Tx, a: { blendBatchId: string; consumed: { sourceId: string; taken: number; after: number }[]; actor: string }) {
  const src: Src = { module: "production", type: "BLEND", id: a.blendBatchId, event: "BLENDED" };
  const holders = await lockHolders(tx, [...a.consumed.map((c) => ({ kind: "ROASTED_BATCH" as CostKind, entityId: c.sourceId })), { kind: "ROASTED_BATCH", entityId: a.blendBatchId }]);
  const ids: string[] = [];
  let value = ZERO, qty = ZERO;
  for (const c of a.consumed) {
    const out = await costOut(tx, { holder: holders.get(`ROASTED_BATCH:${c.sourceId}`) as HolderRow, src, kind: "TRANSFER_OUT", qty: kg(c.taken), closeOut: c.after <= 0.0005, actor: a.actor });
    ids.push(out.id); value = value.plus(out.value); qty = qty.plus(out.qty);
  }
  const inn = await costIn(tx, { holder: holders.get(`ROASTED_BATCH:${a.blendBatchId}`) as HolderRow, src, kind: "TRANSFER_IN", qty: kg(a.consumed.reduce((s, c) => s + c.taken, 0)), value, actor: a.actor });
  await resolveNone(tx, [...ids, inn.id]);
  return { value };
}

export type PackedLot = { lotId: string; grams: number; skuId: string | null; productId: string | null; lineIndex: number };

/**
 * A packaging run: roasted coffee out (packed + declared loss), materials out at their averages, finished lots in at
 * coffee cost (by grams) + the materials their lines used. Dr INVENTORY_PACKED (per SKU) + WASTAGE (declared loss) /
 * Cr INVENTORY_ROASTED, INVENTORY_PACKAGING (and INVENTORY_CAFE). `production · PACKAGING_RUN · COMPLETED`.
 */
export async function onPackaging(tx: Tx, a: {
  batchId: string; batchNumber: string; productId: string | null; runKey: string | null; packedGrams: number; lossGrams: number; batchEmpty: boolean;
  materials: { materialItemId: string; qty: number }[];
  /** Materials each submitted line used (lineIndex → material → qty). */
  lineMaterials: Map<number, Map<string, number>>;
  lots: PackedLot[];
  actor: string;
}) {
  const src: Src = { module: "production", type: "PACKAGING_RUN", id: `${a.batchId}.${a.runKey ? short(a.runKey) : short(`${Date.now()}:${Math.random()}`)}`, event: "COMPLETED" };
  const holders = await lockHolders(tx, [{ kind: "ROASTED_BATCH", entityId: a.batchId }, ...a.materials.map((m) => ({ kind: "MATERIAL" as CostKind, entityId: m.materialItemId })), ...a.lots.map((l) => ({ kind: "FG_LOT" as CostKind, entityId: l.lotId }))]);
  const roasted = holders.get(`ROASTED_BATCH:${a.batchId}`) as HolderRow;
  const ids: string[] = [];
  const pDim = productDim(a.productId);
  const lines = [];
  let packedValue = ZERO, lossValue = ZERO;
  if (a.packedGrams > 0) {
    const out = await costOut(tx, { holder: roasted, src, kind: "ISSUE", lineKey: "packed", qty: kg(a.packedGrams / 1000), closeOut: a.batchEmpty && a.lossGrams <= 0, actor: a.actor });
    ids.push(out.id); packedValue = out.value;
  }
  if (a.lossGrams > 0) {
    const loss = await costOut(tx, { holder: roasted, src, kind: "WRITE_OFF", lineKey: "loss", qty: kg(a.lossGrams / 1000), closeOut: a.batchEmpty, actor: a.actor, reason: "فاقد تعبئة مُعلن" });
    ids.push(loss.id); lossValue = loss.value;
    lines.push(side("WASTAGE", lossValue, pDim));
  }
  lines.push(side(roasted.role, packedValue.plus(lossValue).negated(), pDim));
  // Materials: each at its average; the value per unit then follows the lines that used it.
  const matUnit = new Map<string, { value: Decimal; qty: Decimal }>();
  for (const m of a.materials) {
    const h = holders.get(`MATERIAL:${m.materialItemId}`) as HolderRow;
    const out = await costOut(tx, { holder: h, src, kind: "ISSUE", lineKey: m.materialItemId, qty: kg(m.qty), actor: a.actor });
    ids.push(out.id);
    matUnit.set(m.materialItemId, { value: out.value, qty: kg(m.qty) });
    lines.push(side(h.role, out.value.negated(), materialDim(m.materialItemId)));
  }
  // Coffee to lots by grams; each material to the lots of the lines that used it, by the quantity each used.
  const coffeeParts = split(packedValue, a.lots.map((l) => new Decimal(l.grams)));
  const matParts = new Map<string, Decimal[]>();
  for (const [matId, mv] of matUnit) {
    const weights = a.lots.map((l) => {
      const used = a.lineMaterials.get(l.lineIndex)?.get(matId) ?? 0;
      const sameLine = a.lots.filter((x) => x.lineIndex === l.lineIndex).length || 1;
      return new Decimal((used / sameLine).toFixed(6));
    });
    matParts.set(matId, weights.some((w) => w.gt(0)) ? split(mv.value, weights) : split(mv.value, a.lots.map((l) => new Decimal(l.grams))));
  }
  for (const [i, l] of a.lots.entries()) {
    let v = coffeeParts[i] ?? ZERO;
    for (const parts of matParts.values()) v = v.plus(parts[i] ?? ZERO);
    const h = holders.get(`FG_LOT:${l.lotId}`) as HolderRow;
    const inn = await costIn(tx, { holder: h, src, kind: "RECEIPT", lineKey: `${i}`, qty: kg(l.grams / 1000), value: v, actor: a.actor });
    ids.push(inn.id);
    lines.push(side(h.role, v, skuDim(l.skuId, l.productId ?? a.productId)));
  }
  return postAndResolve(tx, ids, { source: src, memo: `تعبئة دفعة ${a.batchNumber}`, createdBy: a.actor, lines });
}

// ─── Delivery: COGS ──────────────────────────────────────────────────────────────────────────────

/**
 * A delivery confirmed: each lot drawn is issued at its cost (the whole remaining value when the lot is emptied)
 * — Dr COGS (party = customer, item = SKU) / Cr INVENTORY_PACKED. `inventory · DELIVERY · COGS`.
 * (A2 leaves the hook on the invoice; COGS posts here, on the physical delivery — council 01, cogsPolicy OnShipping.)
 */
export async function onDelivery(tx: Tx, a: { deliveryId: string; lines: { lotId: string; kg: number; emptied: boolean; units?: number; unitsBefore?: number }[]; actor: string }) {
  if (!a.lines.length) return { status: "none" as const };
  const d = await tx.delivery.findUnique({ where: { id: a.deliveryId }, select: { orderItem: { select: { order: { select: { customerId: true, orderNumber: true } } } } } });
  const lots = await tx.finishedGoodsLot.findMany({ where: { id: { in: a.lines.map((l) => l.lotId) } }, select: { id: true, productSkuId: true, productId: true } });
  const lotOf = new Map(lots.map((l) => [l.id, l]));
  const src: Src = { module: "inventory", type: "DELIVERY", id: a.deliveryId, event: "COGS" };
  const holders = await lockHolders(tx, a.lines.map((l) => ({ kind: "FG_LOT" as CostKind, entityId: l.lotId })));
  const customerId = d?.orderItem.order.customerId ?? null;
  const ids: string[] = [];
  const lines = [];
  for (const l of a.lines) {
    const h = holders.get(`FG_LOT:${l.lotId}`) as HolderRow;
    // A unit-tracked lot is issued by the share of its units (its packages may hold more than the nominal weight the
    // delivery's kilograms are computed from); a kilogram lot by its kilograms.
    const q = l.units && l.unitsBefore && l.unitsBefore > 0 ? kg(h.qty.times(l.units).dividedBy(l.unitsBefore)) : kg(l.kg);
    const out = await costOut(tx, { holder: h, src, kind: "ISSUE", lineKey: l.lotId, qty: q, closeOut: l.emptied, actor: a.actor });
    ids.push(out.id);
    const lot = lotOf.get(l.lotId);
    const item = skuDim(lot?.productSkuId, lot?.productId);
    lines.push(side("COGS", out.value, { ...(item ?? {}), ...(customerId ? { party: { type: "CUSTOMER" as const, id: customerId } } : {}) }));
    lines.push(side(h.role, out.value.negated(), item));
  }
  return postAndResolve(tx, ids, { source: src, memo: `تكلفة بضاعة مسلّمة · طلب ${d?.orderItem.order.orderNumber ?? ""}`, createdBy: a.actor, lines });
}

/**
 * The hook for a delivery return / cancellation (no such flow exists yet): the COGS entry is reversed and each lot
 * receives back exactly what was issued (same values) — `inventory · DELIVERY · COGS.REVERSED`.
 */
export async function reverseDeliveryCogs(tx: Tx, a: { deliveryId: string; reason: string; actor: string }) {
  const src: Src = { module: "inventory", type: "DELIVERY", id: a.deliveryId, event: "RETURNED" };
  const outs = await tx.costMove.findMany({ where: { sourceType: "DELIVERY", sourceId: a.deliveryId, sourceEvent: "COGS" }, include: { costItem: { select: { kind: true, entityId: true } } } });
  const ids: string[] = [];
  for (const o of outs) {
    const h = await lockHolder(tx, o.costItem.kind as CostKind, o.costItem.entityId);
    const back = await costIn(tx, { holder: h, src, kind: "RETURN", lineKey: o.lineKey, qty: new Decimal(o.qty).abs(), value: new Decimal(o.value).abs(), actor: a.actor, reason: a.reason });
    ids.push(back.id);
  }
  const posted = outs.find((o) => o.journalEntryId);
  if (posted?.journalEntryId) {
    const rev = await reverseEntry(tx, { entryId: posted.journalEntryId, reason: a.reason, actorId: a.actor });
    if (ids.length) await tx.costMove.updateMany({ where: { id: { in: ids }, glState: "PENDING" }, data: { glState: "POSTED", journalEntryId: rev.entryId } });
  } else await resolveNone(tx, ids);
}

function dayOf(d: Date): Date {
  // A purchase date is a calendar date chosen by the user: its Riyadh day.
  return toBusinessDay(d);
}
