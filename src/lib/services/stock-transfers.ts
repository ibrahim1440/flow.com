/**
 * «تحويل مخزون» — stock transfers between locations (20261115090000_stock_locations, extended by
 * 20261117090000_locations_enhancements).
 *
 * Two modes:
 *   · «تحويل فوري» (IMMEDIATE, kept — owner decision 1): in ONE transaction the goods leave the source and arrive at the
 *     destination. Status POSTED; a cancel reverses it while the goods are all still at the destination.
 *   · «إرسال» → «في الطريق» → «استلام» (TWO_STEP): the send takes the goods off the source into the one system location
 *     «في الطريق» ("loc_transit") — status IN_TRANSIT; the receipt moves them from transit to the destination — status
 *     RECEIVED. A green / material line may arrive short: the shortfall is written off FROM TRANSIT as an ordinary
 *     stock adjustment (its reason, the moving average, INVENTORY_VARIANCE — a real loss is a real loss) and needs
 *     inventory › adjust; a finished-goods line is received in full only. A cancel while in transit returns everything
 *     to the source. A received transfer is not cancelled (a transfer back corrects it).
 *
 * Why one transit LOCATION and not a balance kind (council 01 / 02): in-transit stock is still the company's stock at
 * the same moving average; holding it as an ordinary "StockBalance" row at a system location keeps every invariant as
 * it is (Σ location balances = the company total, enforced by the database at commit), so it counts in the totals and
 * the valuation with no new code in either, and the transfer's lines say what is on the way for which transfer.
 *
 * Lines: a green lot / material (a balance, any decimals) or a finished-goods lot (FG_LOT: whole units of a
 * unit-tracked lot that is AVAILABLE at the source, only its free units). A finished lot moved whole changes its
 * location (and status IN_TRANSIT while on the way); part of a lot is SPLIT into a new lot that keeps the batch, the
 * roast and its own "splitFromLotId" (traceability), its FIFO date (the source's createdAt) and its share of the cost:
 * the cost ledger moves that share from the source lot's holder to the new lot's — TRANSFER_OUT / TRANSFER_IN, same
 * value, both INVENTORY_PACKED, glState NONE.
 *
 * Every balance move writes an OUT movement at the source and an IN movement at the destination (sourceDocType
 * STOCK_TRANSFER, the transfer's id on both, the other site as counterpart; their before / after are the LOCATION's
 * balance) and the cost ledger records TRANSFER_OUT then TRANSFER_IN on the item's one holder — same quantity, same
 * value (the moving average), glState NONE: no journal entry. Valuation is company-wide: same legal entity, same
 * inventory account (council 01 «inter-branch transfers at cost, no revenue»; 02 a transfer is an inventory event that
 * posts nothing within one role).
 *
 * Permissions (owner decision 4): inventory › transfer_send (create, send — both modes), transfer_receive (receive;
 * a shortfall also needs adjust), transfer_cancel (cancel). Enforced by the routes; the service takes the facts.
 *
 * Locking: the stock rows (FinishedGoodsLot / GreenBean / MaterialItem) first, in (kind, id) order — the one direction
 * every stock operation takes — then the cost holders. Every action is one row of the person audit (AuthAuditLog):
 * STOCK_TRANSFER_CREATED / _SENT / _RECEIVED / _CANCELLED.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { setAuditContext, type AuditContext } from "@/lib/accounting/audit";
import { ipHashOf } from "@/lib/accounting/ops/purchase-activity";
import { costIn, costOut, flushPostings, lockHolder, lockHolders, resolveNone, type CostKind, type HolderRow } from "@/lib/accounting/ops/cost-ledger";
import { Decimal, qty4 } from "@/lib/accounting/ops/costing";
import { dayText, parseBusinessDay, riyadhDay } from "@/lib/accounting/dates";
import {
  TRANSIT_LOCATION_ID, covers, isTransitLocation, locationName, parseReceiveLines, parseTransferLines, shortRefusal, inactiveRefusal,
  type StockItemKind, type TransferItemKind, type TransferMode,
} from "@/lib/inventory/locations";
import { applyInventoryAdjustment, type AdjustmentUser } from "./inventory-adjustment";
import { locationQty, withBalanceWriter } from "./stock-locations";
import { notify } from "@/lib/notifications/notify";
import { isSimpleMode } from "@/lib/simple-mode";

type Tx = Prisma.TransactionClient;
type Fail = { _appCode: number; message: string; errorEn: string; errorAr: string; code: string; location?: Record<string, unknown> };
const fail = (status: number, code: string, ar: string, en: string, location?: Record<string, unknown>): Fail => ({ _appCode: status, message: ar, errorAr: ar, errorEn: en, code, ...(location ? { location } : {}) });

export const TRANSFER_ACTIONS = ["STOCK_TRANSFER_CREATED", "STOCK_TRANSFER_SENT", "STOCK_TRANSFER_RECEIVED", "STOCK_TRANSFER_CANCELLED"] as const;
export const transferRef = (n: number) => `TR-${String(n).padStart(5, "0")}`;
const SHORT_UNIT: Record<string, [string, string]> = { KG: ["كغ", "kg"], GRAM: ["غ", "g"], PIECE: ["قطعة", "pcs"], UNIT: ["وحدة", "units"], LITER: ["لتر", "L"] };
const r4 = (n: number) => Number(n.toFixed(4));
const r3 = (n: number) => Number(n.toFixed(3));

type Actor = { id: string; name?: string | null };
type ItemInfo = {
  kind: TransferItemKind; id: string; code: string; name: string; nameAr: string | null; unit: string; isActive: boolean;
  /** FG_LOT: the lot's facts. */
  lot?: { skuCode: string | null; weightGrams: number; locationId: string; status: string; unitsAvailable: number; unitsReserved: number; isUnitTracked: boolean; splitFromLotId: string | null };
};

/** Names, codes and units of the items on transfer lines (a finished lot: its SKU's name, the batch as its code). */
export async function itemInfo(db: Tx | typeof prisma, refs: { itemKind: string; entityId: string; fgLotId?: string | null }[]): Promise<Map<string, ItemInfo>> {
  const g = refs.filter((r) => r.itemKind === "GREEN_BEAN").map((r) => r.entityId);
  const m = refs.filter((r) => r.itemKind === "MATERIAL").map((r) => r.entityId);
  const f = [...new Set(refs.filter((r) => r.itemKind === "FG_LOT").flatMap((r) => [r.entityId, ...(r.fgLotId ? [r.fgLotId] : [])]))];
  const [beans, mats, lots] = await Promise.all([
    g.length ? db.greenBean.findMany({ where: { id: { in: g } }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true, isActive: true } }) : [],
    m.length ? db.materialItem.findMany({ where: { id: { in: m } }, select: { id: true, code: true, name: true, nameAr: true, unitOfMeasure: true, isActive: true } }) : [],
    f.length ? db.finishedGoodsLot.findMany({
      where: { id: { in: f } },
      select: { id: true, batchNumber: true, locationId: true, status: true, unitsAvailable: true, unitsReserved: true, isUnitTracked: true, splitFromLotId: true, productSku: { select: { skuCode: true, name: true, nameAr: true, weightGrams: true } }, product: { select: { productNameEn: true, productNameAr: true } } },
    }) : [],
  ]);
  const out = new Map<string, ItemInfo>();
  for (const b of beans) out.set(`GREEN_BEAN:${b.id}`, { kind: "GREEN_BEAN", id: b.id, code: b.serialNumber, name: b.beanType, nameAr: b.beanTypeAr, unit: "KG", isActive: b.isActive });
  for (const x of mats) out.set(`MATERIAL:${x.id}`, { kind: "MATERIAL", id: x.id, code: x.code, name: x.name, nameAr: x.nameAr, unit: x.unitOfMeasure, isActive: x.isActive });
  for (const l of lots) {
    out.set(`FG_LOT:${l.id}`, {
      kind: "FG_LOT", id: l.id, code: l.batchNumber, unit: "UNIT", isActive: true,
      name: `${l.productSku?.name ?? l.product.productNameEn}${l.productSku?.skuCode ? ` · ${l.productSku.skuCode}` : ""}`,
      nameAr: `${l.productSku?.nameAr ?? l.product.productNameAr ?? l.productSku?.name ?? l.product.productNameEn}${l.productSku?.skuCode ? ` · ${l.productSku.skuCode}` : ""}`,
      lot: { skuCode: l.productSku?.skuCode ?? null, weightGrams: l.productSku?.weightGrams ?? 0, locationId: l.locationId, status: l.status, unitsAvailable: l.unitsAvailable, unitsReserved: l.unitsReserved, isUnitTracked: l.isUnitTracked, splitFromLotId: l.splitFromLotId },
    });
  }
  return out;
}

async function logTransfer(tx: Tx, ctx: Pick<AuditContext, "actorId" | "ip" | "userAgent" | "reason">, action: (typeof TRANSFER_ACTIONS)[number], t: { id: string; number: number }, extra: Record<string, unknown>) {
  await tx.authAuditLog.create({
    data: {
      userId: ctx.actorId, action, result: "SUCCESS", sourceInterface: "WEB", ipHash: await ipHashOf(ctx.ip), userAgent: ctx.userAgent ?? null,
      metadata: JSON.parse(JSON.stringify({ transferId: t.id, number: t.number, targetName: transferRef(t.number), reason: ctx.reason ?? null, ...extra })) as Prisma.InputJsonValue,
    },
  });
}

/** Lock the stock rows of the lines in (kind, id) order (a finished line: the lot that travels and its source). */
async function lockItems(tx: Tx, lines: { itemKind: string; entityId: string; fgLotId?: string | null }[]) {
  const refs = lines.flatMap((l) => (l.itemKind === "FG_LOT" ? [{ itemKind: "FG_LOT", entityId: l.entityId }, ...(l.fgLotId && l.fgLotId !== l.entityId ? [{ itemKind: "FG_LOT", entityId: l.fgLotId }] : [])] : [l]));
  const uniq = [...new Map(refs.map((r) => [`${r.itemKind}:${r.entityId}`, r])).values()].sort((a, b) => (a.itemKind + a.entityId < b.itemKind + b.entityId ? -1 : 1));
  for (const l of uniq) {
    const hit = l.itemKind === "GREEN_BEAN"
      ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "GreenBean" WHERE "id" = ${l.entityId} FOR UPDATE`
      : l.itemKind === "MATERIAL"
      ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MaterialItem" WHERE "id" = ${l.entityId} FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "FinishedGoodsLot" WHERE "id" = ${l.entityId} FOR UPDATE`;
    if (!hit[0]) throw fail(404, "STOCK_ITEM_INVALID", "صنف المخزون غير موجود.", "Stock item not found.");
  }
}

/** Move one line's quantity between two balances: the two movements and the two cost moves (net zero, glState NONE). */
async function moveLine(tx: Tx, a: {
  transfer: { id: string; number: number }; lineNo: number; kind: StockItemKind; entityId: string; qty: number; from: string; to: string;
  holder: HolderRow; day: Date; actor: string; events: [string, string]; note: string;
}) {
  const fromQty = await locationQty(tx, a.kind, a.entityId, a.from);
  const toQty = await locationQty(tx, a.kind, a.entityId, a.to);
  // Total-preserving, unrounded: what leaves the source is exactly what arrives (a balance may carry more decimals than
  // a quantity — a count's or a draw's — and Σ must stay the total to the millionth; rounding is for display only).
  const fromAfter = Math.max(0, fromQty - a.qty);
  const toAfter = toQty + (fromQty - fromAfter);
  const key = (locationId: string) => ({ locationId_itemKind_entityId: { locationId, itemKind: a.kind, entityId: a.entityId } });
  await withBalanceWriter(tx, async () => {
    await tx.stockBalance.update({ where: key(a.from), data: { qty: fromAfter } });
    await tx.stockBalance.upsert({ where: key(a.to), create: { locationId: a.to, itemKind: a.kind, entityId: a.entityId, qty: toAfter }, update: { qty: toAfter } });
  });
  const category = a.kind === "GREEN_BEAN" ? "RAW_MATERIAL" : "PACKAGING_MATERIAL";
  const common = { category, referenceEntityId: a.entityId, sourceDocType: "STOCK_TRANSFER", sourceDocId: a.transfer.id, transferId: a.transfer.id, userId: a.actor, notes: a.note.slice(0, 1000) } as const;
  const out = await tx.inventoryMovement.create({ data: { ...common, type: "OUT", quantityChanged: -(fromQty - fromAfter), previousQuantity: fromQty, newQuantity: fromAfter, locationId: a.from, counterpartLocationId: a.to } });
  const inn = await tx.inventoryMovement.create({ data: { ...common, type: "IN", quantityChanged: fromQty - fromAfter, previousQuantity: toQty, newQuantity: toAfter, locationId: a.to, counterpartLocationId: a.from } });
  // The cost ledger: out at the moving average, in at exactly the same quantity and value — the holder is unchanged.
  const src = { module: "inventory" as const, type: "STOCK_TRANSFER", id: a.transfer.id };
  const lineKey = String(a.lineNo);
  const co = await costOut(tx, { holder: a.holder, src: { ...src, event: a.events[0] }, lineKey, kind: "TRANSFER_OUT", qty: qty4(a.qty), day: a.day, actor: a.actor, inventoryMovementId: out.id, reason: a.note });
  const ci = await costIn(tx, { holder: a.holder, src: { ...src, event: a.events[1] }, lineKey, kind: "TRANSFER_IN", qty: co.qty, value: co.value, day: a.day, actor: a.actor, inventoryMovementId: inn.id, reason: a.note });
  await resolveNone(tx, [co.id, ci.id]);
  return { outMovementId: out.id, inMovementId: inn.id, fromQty, fromAfter, toQty, toAfter, value: co.value.toFixed(2) };
}

type LotRow = {
  id: string; productId: string; productSkuId: string | null; batchNumber: string; packedFromBatchId: string | null; quantityKg: number; createdAt: Date;
  status: string; locationId: string; isUnitTracked: boolean; unitsProduced: number; unitsAvailable: number; unitsReserved: number;
  actualContentGrams: number | null; nominalContentGrams: number | null; productSku: { weightGrams: number; skuCode: string } | null;
};
const LOT_SELECT = {
  id: true, productId: true, productSkuId: true, batchNumber: true, packedFromBatchId: true, quantityKg: true, createdAt: true, status: true, locationId: true,
  isUnitTracked: true, unitsProduced: true, unitsAvailable: true, unitsReserved: true, actualContentGrams: true, nominalContentGrams: true,
  productSku: { select: { weightGrams: true, skuCode: true } },
} as const;

/** The refusal when a finished lot cannot leave `from` with `units` (not unit-tracked, not available there, reserved). */
function assertLotMovable(lot: LotRow, fromId: string, fromName: string, units: number, lineNo: number) {
  if (!lot.isUnitTracked || !lot.productSkuId) {
    throw fail(409, "TRANSFER_FG_NOT_UNITS", `السطر ${lineNo}: اللوت ${lot.batchNumber} بالكيلو (قديم) — يُحوَّل المنتج المعبأ بالعبوات فقط.`, `Line ${lineNo}: lot ${lot.batchNumber} is kept in kilograms (legacy) — only packaged, unit-tracked lots are transferred.`);
  }
  if (lot.locationId !== fromId) {
    throw fail(409, "TRANSFER_FG_ELSEWHERE", `السطر ${lineNo}: اللوت ${lot.batchNumber} ليس في «${fromName}».`, `Line ${lineNo}: lot ${lot.batchNumber} is not at «${fromName}».`, { locationId: fromId });
  }
  if (lot.status !== "AVAILABLE") {
    throw fail(409, "TRANSFER_FG_NOT_AVAILABLE", `السطر ${lineNo}: اللوت ${lot.batchNumber} غير متاح (${lot.status}).`, `Line ${lineNo}: lot ${lot.batchNumber} is not available (${lot.status}).`);
  }
  const free = Math.max(0, lot.unitsAvailable - lot.unitsReserved);
  if (units > free) {
    throw fail(409, "TRANSFER_FG_SHORT", `السطر ${lineNo}: في اللوت ${lot.batchNumber} ${free} عبوة حرة فقط (المحجوز لطلبات لا يُحوَّل).`, `Line ${lineNo}: lot ${lot.batchNumber} has only ${free} free unit(s) (units reserved for orders are not transferred).`, { available: free, requested: units });
  }
}

/** One FG movement (kg, like a delivery's): the lot's balance at a site before / after. */
async function fgMovement(tx: Tx, a: { type: "IN" | "OUT"; lotId: string; kg: number; before: number; after: number; at: string; counterpart: string; transferId: string; actor: string; note: string }) {
  return tx.inventoryMovement.create({
    data: {
      type: a.type, category: "FINISHED_GOODS", referenceEntityId: a.lotId, quantityChanged: a.type === "IN" ? a.kg : -a.kg, previousQuantity: a.before, newQuantity: a.after,
      sourceDocType: "STOCK_TRANSFER", sourceDocId: a.transferId, transferId: a.transferId, userId: a.actor, notes: a.note.slice(0, 1000), locationId: a.at, counterpartLocationId: a.counterpart,
    },
  });
}

/**
 * Send `units` of a finished lot from `from` to `to` (the destination, or transit): the whole lot changes site, or the
 * units are split into a new lot (batch, roast, FIFO date kept; splitFromLotId the source) with its share of the cost.
 */
async function moveFgOut(tx: Tx, a: { transfer: { id: string; number: number }; lineNo: number; lot: LotRow; units: number; from: string; to: string; inTransit: boolean; day: Date; actor: string; note: string; holder: HolderRow }) {
  const w = a.lot.productSku?.weightGrams ?? 0;
  const kg = r3((w * a.units) / 1000);
  const status = a.inTransit ? "IN_TRANSIT" : "AVAILABLE";
  const whole = a.units === a.lot.unitsAvailable && a.lot.unitsReserved === 0;
  let lotId = a.lot.id;
  let value = "0.00";
  if (whole) {
    await tx.finishedGoodsLot.update({ where: { id: a.lot.id }, data: { locationId: a.to, status } });
  } else {
    // The share of the lot's quantity / cost: by units of what is left (as a delivery issues it).
    const shareKg = a.lot.unitsProduced > 0 ? r4((a.lot.quantityKg * a.units) / a.lot.unitsProduced) : kg;
    const created = await tx.finishedGoodsLot.create({
      data: {
        productId: a.lot.productId, productSkuId: a.lot.productSkuId, batchNumber: a.lot.batchNumber, packedFromBatchId: a.lot.packedFromBatchId,
        quantityKg: shareKg, availableQty: 0, reservedQty: 0, isUnitTracked: true, unitsProduced: a.units, unitsAvailable: a.units, unitsReserved: 0,
        status, actualContentGrams: a.lot.actualContentGrams, nominalContentGrams: a.lot.nominalContentGrams, materialsConsumed: true,
        locationId: a.to, splitFromLotId: a.lot.id, createdAt: a.lot.createdAt,
      },
      select: { id: true },
    });
    lotId = created.id;
    // Σ produced / kg over the lots of a roast stays what was packed (production orders and planning sum them).
    await tx.finishedGoodsLot.update({ where: { id: a.lot.id }, data: { unitsAvailable: { decrement: a.units }, unitsProduced: { decrement: Math.min(a.units, a.lot.unitsProduced) }, quantityKg: Math.max(0, r4(a.lot.quantityKg - shareKg)) } });
    const src = { module: "inventory" as const, type: "STOCK_TRANSFER", id: a.transfer.id };
    // The source lot's holder was locked with every other holder of the transfer, before the first move (council F5).
    const h = a.holder;
    const q = a.lot.unitsAvailable > 0 ? qty4(h.qty.times(a.units).dividedBy(a.lot.unitsAvailable)) : new Decimal(0);
    const nh = await lockHolder(tx, "FG_LOT", lotId);
    // A lot never costed (an empty holder) moves nothing in the cost ledger.
    if (q.gt(0)) {
      const co = await costOut(tx, { holder: h, src: { ...src, event: "SPLIT_OUT" }, lineKey: String(a.lineNo), kind: "TRANSFER_OUT", qty: q, day: a.day, actor: a.actor, reason: a.note });
      const ci = await costIn(tx, { holder: nh, src: { ...src, event: "SPLIT_IN" }, lineKey: String(a.lineNo), kind: "TRANSFER_IN", qty: co.qty, value: co.value, day: a.day, actor: a.actor, reason: a.note });
      await resolveNone(tx, [co.id, ci.id]);
      value = co.value.toFixed(2);
    }
  }
  const before = r3((w * a.lot.unitsAvailable) / 1000);
  await fgMovement(tx, { type: "OUT", lotId: a.lot.id, kg, before, after: r3(before - kg), at: a.from, counterpart: a.to, transferId: a.transfer.id, actor: a.actor, note: a.note });
  await fgMovement(tx, { type: "IN", lotId, kg, before: 0, after: kg, at: a.to, counterpart: a.from, transferId: a.transfer.id, actor: a.actor, note: a.note });
  return { fgLotId: lotId, split: !whole, kg, value };
}

/** Move a travelling finished lot (all of it) from one site to another (transit → destination, or back). */
async function moveFgLot(tx: Tx, a: { transferId: string; lotId: string; from: string; to: string; actor: string; note: string; lineNo: number }) {
  const lot = await tx.finishedGoodsLot.findUniqueOrThrow({ where: { id: a.lotId }, select: LOT_SELECT });
  if (lot.locationId !== a.from) {
    throw fail(409, "TRANSFER_FG_MOVED_ON", `السطر ${a.lineNo}: اللوت ${lot.batchNumber} لم يعد في موقعه المتوقع.`, `Line ${a.lineNo}: lot ${lot.batchNumber} is no longer where it was expected.`);
  }
  await tx.finishedGoodsLot.update({ where: { id: a.lotId }, data: { locationId: a.to, status: lot.unitsAvailable > 0 ? "AVAILABLE" : "SHIPPED" } });
  const kg = r3(((lot.productSku?.weightGrams ?? 0) * lot.unitsAvailable) / 1000);
  await fgMovement(tx, { type: "OUT", lotId: a.lotId, kg, before: kg, after: 0, at: a.from, counterpart: a.to, transferId: a.transferId, actor: a.actor, note: a.note });
  await fgMovement(tx, { type: "IN", lotId: a.lotId, kg, before: 0, after: kg, at: a.to, counterpart: a.from, transferId: a.transferId, actor: a.actor, note: a.note });
  return { kg, units: lot.unitsAvailable };
}

/** Create a transfer: one step («تحويل فوري», POSTED) or sent («إرسال», IN_TRANSIT — received later). */
export async function createTransfer(body: Record<string, unknown>, actor: Actor, ctx: AuditContext) {
  const parsed = parseTransferLines(body.lines);
  if (!parsed.ok) throw fail(400, parsed.code, parsed.error, parsed.errorEn);
  const mode: TransferMode = body.mode === "TWO_STEP" ? "TWO_STEP" : "IMMEDIATE";
  const fromId = typeof body.fromLocationId === "string" ? body.fromLocationId : "";
  const toId = typeof body.toLocationId === "string" ? body.toLocationId : "";
  if (!fromId || !toId) throw fail(400, "TRANSFER_SITES_REQUIRED", "اختر الموقع المحوَّل منه والمحوَّل إليه.", "Choose the from and to locations.");
  if (fromId === toId) throw fail(400, "TRANSFER_SAME_SITE", "الموقعان متطابقان: اختر موقعًا آخر للوجهة.", "The two locations are the same: choose another destination.");
  if (fromId === TRANSIT_LOCATION_ID || toId === TRANSIT_LOCATION_ID) throw fail(400, "STOCK_LOCATION_TRANSIT", "«في الطريق» ليس موقعًا يُحوَّل منه أو إليه.", "«In transit» is not a location to transfer from or to.");
  const today = riyadhDay();
  let day = today;
  if (body.transferDate) {
    try { day = parseBusinessDay(String(body.transferDate)); } catch { throw fail(400, "TRANSFER_DATE_INVALID", "تاريخ التحويل غير صالح.", "The transfer date is not valid."); }
    if (day > today) throw fail(400, "TRANSFER_DATE_INVALID", "تاريخ التحويل بعد اليوم.", "The transfer date is after today.");
  }
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 500) : null;
  const requestKey = typeof body.requestKey === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(body.requestKey) ? body.requestKey : null;
  const lines = parsed.lines;

  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    if (requestKey) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock-transfer:${requestKey}`}, 0))`;
      const twin = await tx.stockTransfer.findUnique({ where: { requestKey }, select: { id: true } });
      if (twin) return { id: twin.id, replayed: true };
    }
    const [from, to] = await Promise.all([tx.stockLocation.findUnique({ where: { id: fromId } }), tx.stockLocation.findUnique({ where: { id: toId } })]);
    if (!from || !to) throw fail(404, "STOCK_LOCATION_NOT_FOUND", "الموقع غير موجود.", "Location not found.");
    if (isTransitLocation(from) || isTransitLocation(to)) throw fail(400, "STOCK_LOCATION_TRANSIT", "«في الطريق» ليس موقعًا يُحوَّل منه أو إليه.", "«In transit» is not a location to transfer from or to.");
    for (const l of [from, to]) if (!l.isActive) { const r = inactiveRefusal(l.nameAr, l.id); throw fail(r.status, r.code, r.error, r.errorEn, { locationId: l.id }); }
    await lockItems(tx, lines);
    const info = await itemInfo(tx, lines);
    const lots = new Map((await tx.finishedGoodsLot.findMany({ where: { id: { in: lines.filter((l) => l.itemKind === "FG_LOT").map((l) => l.entityId) } }, select: LOT_SELECT })).map((l) => [l.id, l as LotRow]));
    // Every line must be covered at the source (the friendly refusal; the balance CHECK is the backstop).
    for (const [i, l] of lines.entries()) {
      const it = info.get(`${l.itemKind}:${l.entityId}`);
      if (!it) throw fail(404, "STOCK_ITEM_INVALID", `السطر ${i + 1}: الصنف غير موجود.`, `Line ${i + 1}: item not found.`);
      if (l.itemKind === "FG_LOT") { assertLotMovable(lots.get(l.entityId)!, fromId, from.nameAr, l.qty, i + 1); continue; }
      if (l.itemKind === "MATERIAL" && (it.unit === "PIECE" || it.unit === "UNIT") && !Number.isInteger(l.qty)) {
        throw fail(400, "TRANSFER_LINE_INVALID", `السطر ${i + 1}: «${it.nameAr ?? it.name}» يُعدّ بالقطعة — كمية صحيحة.`, `Line ${i + 1}: «${it.name}» is counted in pieces — a whole number.`);
      }
      const have = await locationQty(tx, l.itemKind, l.entityId, fromId);
      if (!covers(have, l.qty)) {
        const r = shortRefusal(from.nameAr, have, l.qty);
        throw fail(409, "STOCK_LOCATION_SHORT", `السطر ${i + 1} (${it.code}): ${r.error}`, `Line ${i + 1} (${it.code}): ${r.errorEn}`, { locationId: fromId, available: have, requested: l.qty, itemKind: l.itemKind, entityId: l.entityId });
      }
    }
    const twoStep = mode === "TWO_STEP";
    const t = await tx.stockTransfer.create({
      data: {
        fromLocationId: fromId, toLocationId: toId, transferDate: day, notes, requestKey, createdBy: actor.id, createdByName: actor.name ?? null,
        mode, status: twoStep ? "IN_TRANSIT" : "POSTED", sentAt: twoStep ? new Date() : null,
        lines: { create: lines.map((l, i) => ({ lineNo: i + 1, itemKind: l.itemKind, entityId: l.entityId, qty: l.qty, notes: l.notes, fgLotId: l.itemKind === "FG_LOT" ? l.entityId : null })) },
      },
      select: { id: true, number: true },
    });
    // Every cost holder the transfer may touch — the balance lines' and the finished lots' (a split moves cost from the
    // source lot) — in ONE fixed-order lock, before the first move (council F5). A split's new lot is created here, so
    // its holder cannot be contended.
    const holders = await lockHolders(tx, lines.map((l) => ({ kind: l.itemKind as CostKind, entityId: l.entityId })));
    const dest = twoStep ? TRANSIT_LOCATION_ID : toId;
    const note = `${twoStep ? "إرسال" : "تحويل"} ${transferRef(t.number)} · ${from.nameAr} ← ${to.nameAr}`;
    const moved: Record<string, unknown>[] = [];
    for (const [i, l] of lines.entries()) {
      const it = info.get(`${l.itemKind}:${l.entityId}`)!;
      if (l.itemKind === "FG_LOT") {
        const m = await moveFgOut(tx, { transfer: t, lineNo: i + 1, lot: lots.get(l.entityId)!, units: l.qty, from: fromId, to: dest, inTransit: twoStep, day, actor: actor.id, note, holder: holders.get(`FG_LOT:${l.entityId}`)! });
        if (m.fgLotId !== l.entityId) await tx.stockTransferLine.update({ where: { transferId_lineNo: { transferId: t.id, lineNo: i + 1 } }, data: { fgLotId: m.fgLotId } });
        moved.push({ lineNo: i + 1, itemKind: l.itemKind, entityId: l.entityId, fgLotId: m.fgLotId, split: m.split, code: it.code, name: it.nameAr ?? it.name, qty: l.qty, unit: "UNIT", kg: m.kg, value: m.value });
        continue;
      }
      const m = await moveLine(tx, { transfer: t, lineNo: i + 1, kind: l.itemKind, entityId: l.entityId, qty: l.qty, from: fromId, to: dest, holder: holders.get(`${l.itemKind}:${l.entityId}`)!, day, actor: actor.id, events: twoStep ? ["SENT", "IN_TRANSIT"] : ["SENT", "RECEIVED"], note });
      moved.push({ lineNo: i + 1, itemKind: l.itemKind, entityId: l.entityId, code: it.code, name: it.nameAr ?? it.name, qty: l.qty, unit: it.unit, fromBefore: m.fromQty, fromAfter: m.fromAfter, toBefore: m.toQty, toAfter: m.toAfter, value: m.value });
    }
    await logTransfer(tx, ctx, twoStep ? "STOCK_TRANSFER_SENT" : "STOCK_TRANSFER_CREATED", t, { mode, from: { id: fromId, name: from.nameAr }, to: { id: toId, name: to.nameAr }, transferDate: dayText(day), lines: moved, notes });
    await flushPostings(tx);
    return { id: t.id, replayed: false };
  }, { ...TX_OPTS, timeout: 60_000 });
}

/**
 * Receive a sent transfer («استلام»): what arrived moves from transit to the destination; a green / material shortfall is
 * written off from transit with its reason (an ordinary adjustment: INVENTORY_VARIANCE) — by the receiver (the route grants
 * `canWriteOff` with inventory › transfer_receive: the owner's decision before release), and the supervisors are notified
 * (inventory.transfer_shortfall); finished goods are received in full.
 */
export async function receiveTransfer(id: string, body: Record<string, unknown>, actor: Actor & { canWriteOff: boolean; user: AdjustmentUser }, ctx: AuditContext) {
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const locked = (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "StockTransfer" WHERE "id" = ${id} FOR UPDATE`)[0];
    if (!locked) throw fail(404, "TRANSFER_NOT_FOUND", "التحويل غير موجود.", "Transfer not found.");
    const t = await tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } }, fromLocation: true, toLocation: true } });
    if (t.status === "RECEIVED") return { id, received: true, replayed: true };
    if (t.status !== "IN_TRANSIT") throw fail(409, "TRANSFER_NOT_IN_TRANSIT", "التحويل ليس في الطريق.", "The transfer is not in transit.");
    if (!t.toLocation.isActive) { const r = inactiveRefusal(t.toLocation.nameAr, t.toLocationId); throw fail(r.status, r.code, r.error, r.errorEn, { locationId: t.toLocationId }); }
    const p = parseReceiveLines(body.lines, t.lines);
    if (!p.ok) throw fail(400, p.code, p.error, p.errorEn);
    if (p.lines.some((l) => l.qtyShort > 0) && !actor.canWriteOff) {
      throw fail(403, "TRANSFER_SHORT_NEEDS_ADJUST", "تسجيل فرق في الاستلام يشطب الكمية الناقصة من المخزون، ويحتاج صلاحية «تسوية المخزون». استلم الكمية كاملة أو اطلب من مشرف.", "Recording a shortfall writes the missing quantity off the stock and needs «adjust stock». Receive it in full or ask a supervisor.");
    }
    await lockItems(tx, t.lines);
    const info = await itemInfo(tx, t.lines);
    const balanceLines = t.lines.filter((l) => l.itemKind !== "FG_LOT");
    const holders = await lockHolders(tx, balanceLines.map((l) => ({ kind: l.itemKind as CostKind, entityId: l.entityId })));
    const day = riyadhDay();
    const msg = `استلام ${transferRef(t.number)} · ${t.fromLocation.nameAr} ← ${t.toLocation.nameAr}`;
    const done: Record<string, unknown>[] = [];
    for (const l of t.lines) {
      const r = p.lines.find((x) => x.lineNo === l.lineNo)!;
      const it = info.get(`${l.itemKind}:${l.entityId}`);
      if (l.itemKind === "FG_LOT") {
        const m = await moveFgLot(tx, { transferId: t.id, lotId: l.fgLotId ?? l.entityId, from: TRANSIT_LOCATION_ID, to: t.toLocationId, actor: actor.id, note: msg, lineNo: l.lineNo });
        done.push({ lineNo: l.lineNo, itemKind: l.itemKind, fgLotId: l.fgLotId, qtyReceived: m.units, kg: m.kg });
      } else {
        const kind = l.itemKind as StockItemKind;
        if (r.qtyReceived > 0) await moveLine(tx, { transfer: t, lineNo: l.lineNo, kind, entityId: l.entityId, qty: r.qtyReceived, from: TRANSIT_LOCATION_ID, to: t.toLocationId, holder: holders.get(`${l.itemKind}:${l.entityId}`)!, day, actor: actor.id, events: ["TRANSIT_OUT", "RECEIVED"], note: msg });
        let writeOff: string | null = null;
        if (r.qtyShort > 0) {
          const reason = `فرق استلام ${transferRef(t.number)} السطر ${l.lineNo}: ${r.varianceReason}`.slice(0, 500);
          const a = await applyInventoryAdjustment(tx, actor.user, { kind, entityId: l.entityId, target: (cur) => Math.max(0, cur - r.qtyShort), reason, locationId: TRANSIT_LOCATION_ID, sourceDocId: t.id, details: { transferId: t.id, lineNo: l.lineNo, sent: l.qty, received: r.qtyReceived, authority: "inventory.transfer_receive" } });
          writeOff = a.movementId;
        }
        done.push({ lineNo: l.lineNo, itemKind: l.itemKind, entityId: l.entityId, code: it?.code, sent: l.qty, qtyReceived: r.qtyReceived, qtyShort: r.qtyShort, varianceReason: r.varianceReason, writeOffMovementId: writeOff });
      }
      await tx.stockTransferLine.update({ where: { id: l.id }, data: { qtyReceived: r.qtyReceived, qtyShort: r.qtyShort > 0 ? r.qtyShort : null, varianceReason: r.varianceReason } });
    }
    await tx.stockTransfer.update({ where: { id }, data: { status: "RECEIVED", receivedAt: new Date(), receivedBy: actor.id, receivedByName: actor.name ?? null, receiveNote: note } });
    await logTransfer(tx, ctx, "STOCK_TRANSFER_RECEIVED", t, { from: { id: t.fromLocationId, name: t.fromLocation.nameAr }, to: { id: t.toLocationId, name: t.toLocation.nameAr }, lines: done, note });
    // A shortfall: the supervisors hear of it (in the app; by e-mail when configured — never failing the receipt).
    // One notification per transfer (dedupe key = the transfer), written in this transaction.
    const shortLines = t.lines.map((l) => ({ l, r: p.lines.find((x) => x.lineNo === l.lineNo)! })).filter((x) => x.r.qtyShort > 0);
    if (shortLines.length) {
      const unit = (u: string): [string, string] => (SHORT_UNIT[u] ?? [u.toLowerCase(), u.toLowerCase()]);
      const itemsAr = shortLines.map(({ l, r }) => { const it = info.get(`${l.itemKind}:${l.entityId}`); const n = r4(r.qtyShort); const w = it?.unit === "PIECE" && Number.isInteger(n) && n >= 3 && n <= 10 ? "قطع" : unit(it?.unit ?? "")[0]; return `${it?.nameAr ?? it?.name ?? l.entityId} ${n} ${w}`; }).join("، ");
      const itemsEn = shortLines.map(({ l, r }) => { const it = info.get(`${l.itemKind}:${l.entityId}`); return `${it?.name ?? l.entityId} ${r4(r.qtyShort)} ${unit(it?.unit ?? "")[1]}`; }).join(", ");
      const reasons = [...new Set(shortLines.map(({ r }) => r.varianceReason).filter(Boolean))].join("؛ ");
      const admins = (await tx.employee.findMany({ where: { role: "admin", active: true }, select: { id: true } })).map((e) => e.id);
      const told = await notify(tx, {
        event: "inventory.transfer_shortfall", dedupeKey: t.id, actorId: actor.id, entity: { type: "StockTransfer", id: t.id }, people: { admins },
        facts: { byName: actor.name ?? actor.id, ref: transferRef(t.number), transferId: t.id, itemsAr, itemsEn, reasonsAr: reasons, fromName: t.fromLocation.nameAr, fromNameEn: t.fromLocation.nameEn ?? t.fromLocation.nameAr, toName: t.toLocation.nameAr, toNameEn: t.toLocation.nameEn ?? t.toLocation.nameAr },
      });
      // Council F1(d): a write-off on the receiver's word is never silent — someone other than the actor is told. With
      // nobody else (the actor is the only admin and the only supervisor) it is refused, and nothing is written; SIMPLE
      // MODE (one trusted operator by design) records it — the audit still holds it.
      if (told.recipients.length === 0 && !isSimpleMode()) {
        throw fail(409, "TRANSFER_SHORT_NO_REVIEWER", "لا يوجد مشرف آخر أو مسؤول يُبلَّغ بهذا النقص؛ لا يُسجَّل نقص لا يراه غيرك. استلم الكمية كاملة أو اطلب من مشرف.", "No other supervisor or administrator would be told of this shortfall: a write-off nobody else sees is not recorded. Receive in full or ask a supervisor.");
      }
    }
    await flushPostings(tx);
    return { id, received: true, replayed: false };
  }, { ...TX_OPTS, timeout: 60_000 });
}

/**
 * Cancel a transfer. One step (POSTED): the movements are reversed, only while every line's goods are still at the
 * destination. In transit: everything returns to the source. A received transfer is corrected by a transfer back.
 */
export async function cancelTransfer(id: string, reasonRaw: unknown, actor: Actor, ctx: AuditContext) {
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim().slice(0, 500) : "";
  if (reason.length < 3) throw fail(400, "TRANSFER_REASON_REQUIRED", "اكتب سبب الإلغاء (3 أحرف على الأقل).", "Give the reason for the cancel (at least 3 characters).");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason });
    const locked = (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "StockTransfer" WHERE "id" = ${id} FOR UPDATE`)[0];
    if (!locked) throw fail(404, "TRANSFER_NOT_FOUND", "التحويل غير موجود.", "Transfer not found.");
    const t = await tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } }, fromLocation: true, toLocation: true } });
    if (t.status === "CANCELLED") throw fail(409, "TRANSFER_NOT_POSTED", "التحويل ملغى بالفعل.", "The transfer is already cancelled.");
    if (t.status === "RECEIVED") throw fail(409, "TRANSFER_RECEIVED", "استُلم التحويل فلا يُلغى. صحّح بتحويل عكسي.", "The transfer was received, so it is not cancelled. Correct it with a transfer back.");
    if (!t.fromLocation.isActive) { const r = inactiveRefusal(t.fromLocation.nameAr, t.fromLocationId); throw fail(r.status, r.code, r.error, r.errorEn); }
    const inTransit = t.status === "IN_TRANSIT";
    const at = inTransit ? TRANSIT_LOCATION_ID : t.toLocationId;
    await lockItems(tx, t.lines);
    const info = await itemInfo(tx, t.lines);
    for (const l of t.lines) {
      const it = info.get(`${l.itemKind}:${l.entityId}`);
      if (l.itemKind === "FG_LOT") {
        const lot = info.get(`FG_LOT:${l.fgLotId ?? l.entityId}`)?.lot;
        const intact = lot && lot.locationId === at && lot.unitsReserved === 0 && lot.unitsAvailable === l.qty && (inTransit ? lot.status === "IN_TRANSIT" : lot.status === "AVAILABLE");
        if (!intact) {
          throw fail(409, "TRANSFER_STOCK_MOVED_ON",
            `لا يُلغى التحويل: لوت «${it?.nameAr ?? it?.name ?? l.entityId}» لم يعد كله في «${t.toLocation.nameAr}» (شُحن منه أو حُجز). صحّح بتحويل عكسي.`,
            `The transfer cannot be cancelled: the lot «${it?.name ?? l.entityId}» is no longer all at «${t.toLocation.nameEn || t.toLocation.nameAr}» (shipped or reserved). Correct it with a transfer back.`);
        }
        continue;
      }
      const have = await locationQty(tx, l.itemKind as StockItemKind, l.entityId, at);
      if (!covers(have, l.qty)) {
        throw fail(409, "TRANSFER_STOCK_MOVED_ON",
          `لا يُلغى التحويل: «${it?.nameAr ?? it?.name ?? l.entityId}» لم يعد كله في «${t.toLocation.nameAr}» (المتوفر ${r4(have)} من ${l.qty}). صحّح بتحويل عكسي أو بالجرد.`,
          `The transfer cannot be cancelled: «${it?.name ?? l.entityId}» is no longer all at «${t.toLocation.nameEn || t.toLocation.nameAr}» (${r4(have)} of ${l.qty}). Correct it with a transfer back or a count.`,
          { locationId: at, available: have, requested: l.qty });
      }
    }
    const balanceLines = t.lines.filter((l) => l.itemKind !== "FG_LOT");
    const holders = await lockHolders(tx, balanceLines.map((l) => ({ kind: l.itemKind as CostKind, entityId: l.entityId })));
    const note = `إلغاء تحويل ${transferRef(t.number)} · ${reason}`;
    const day = riyadhDay();
    const reversed: Record<string, unknown>[] = [];
    for (const l of t.lines) {
      if (l.itemKind === "FG_LOT") {
        const m = await moveFgLot(tx, { transferId: t.id, lotId: l.fgLotId ?? l.entityId, from: at, to: t.fromLocationId, actor: actor.id, note, lineNo: l.lineNo });
        reversed.push({ lineNo: l.lineNo, itemKind: l.itemKind, fgLotId: l.fgLotId, units: m.units, kg: m.kg });
        continue;
      }
      const m = await moveLine(tx, { transfer: t, lineNo: l.lineNo, kind: l.itemKind as StockItemKind, entityId: l.entityId, qty: l.qty, from: at, to: t.fromLocationId, holder: holders.get(`${l.itemKind}:${l.entityId}`)!, day, actor: actor.id, events: ["CANCEL_OUT", "CANCEL_IN"], note });
      reversed.push({ lineNo: l.lineNo, itemKind: l.itemKind, entityId: l.entityId, qty: l.qty, value: m.value });
    }
    await tx.stockTransfer.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: actor.id, cancelledByName: actor.name ?? null, cancelReason: reason } });
    await logTransfer(tx, { ...ctx, reason }, "STOCK_TRANSFER_CANCELLED", t, { inTransit, from: { id: t.fromLocationId, name: t.fromLocation.nameAr }, to: { id: t.toLocationId, name: t.toLocation.nameAr }, lines: reversed });
    await flushPostings(tx);
    return { id, cancelled: true };
  }, { ...TX_OPTS, timeout: 60_000 });
}

const STATUSES = ["POSTED", "IN_TRANSIT", "RECEIVED", "CANCELLED"];

export async function listTransfers(q: { location?: string | null; from?: string | null; to?: string | null; status?: string | null; dateFrom?: string | null; dateTo?: string | null; by?: string | null; take?: number }) {
  const where: Prisma.StockTransferWhereInput = {};
  // By creator (council EA3): the owner reviews each person's transfers for the month.
  if (q.by) where.createdBy = q.by;
  if (q.location) where.OR = [{ fromLocationId: q.location }, { toLocationId: q.location }];
  if (q.from) where.fromLocationId = q.from;
  if (q.to) where.toLocationId = q.to;
  if (q.status && STATUSES.includes(q.status)) where.status = q.status;
  const range: { gte?: Date; lte?: Date } = {};
  try { if (q.dateFrom) range.gte = parseBusinessDay(q.dateFrom); if (q.dateTo) range.lte = parseBusinessDay(q.dateTo); } catch { /* an invalid filter is ignored */ }
  if (range.gte || range.lte) where.transferDate = range;
  const rows = await prisma.stockTransfer.findMany({
    where, orderBy: [{ transferDate: "desc" }, { number: "desc" }], take: Math.min(q.take ?? 100, 500),
    include: { fromLocation: { select: { id: true, code: true, nameAr: true, nameEn: true } }, toLocation: { select: { id: true, code: true, nameAr: true, nameEn: true } }, lines: { select: { itemKind: true, entityId: true, qty: true, fgLotId: true } } },
  });
  const info = await itemInfo(prisma, rows.flatMap((r) => r.lines));
  return rows.map(({ lines, ...r }) => ({
    ...r, ref: transferRef(r.number), transferDate: dayText(r.transferDate), lineCount: lines.length,
    items: lines.slice(0, 3).map((l) => { const it = info.get(`${l.itemKind}:${l.entityId}`); return { code: it?.code ?? "—", name: it?.nameAr ?? it?.name ?? "—", nameEn: it?.name ?? "—", qty: l.qty, unit: it?.unit ?? "" }; }),
  }));
}

/** What is on the way now (status IN_TRANSIT), for the inventory page's «في الطريق». */
export async function inTransitSummary() {
  const rows = await prisma.stockTransfer.findMany({
    where: { status: "IN_TRANSIT" }, orderBy: { number: "asc" }, take: 200,
    include: { fromLocation: { select: { id: true, nameAr: true, nameEn: true } }, toLocation: { select: { id: true, nameAr: true, nameEn: true } }, lines: { select: { itemKind: true, entityId: true, qty: true, fgLotId: true } } },
  });
  const info = await itemInfo(prisma, rows.flatMap((r) => r.lines));
  return rows.map((r) => ({
    id: r.id, ref: transferRef(r.number), sentAt: r.sentAt, from: r.fromLocation, to: r.toLocation,
    lines: r.lines.map((l) => { const it = info.get(`${l.itemKind}:${l.entityId}`); return { itemKind: l.itemKind, entityId: l.entityId, fgLotId: l.fgLotId, code: it?.code ?? "—", name: it?.nameAr ?? it?.name ?? "—", nameEn: it?.name ?? "—", qty: l.qty, unit: it?.unit ?? "" }; }),
  }));
}

export async function getTransfer(id: string) {
  const t = await prisma.stockTransfer.findUnique({
    where: { id },
    include: { fromLocation: true, toLocation: true, lines: { orderBy: { lineNo: "asc" } }, movements: { orderBy: [{ timestamp: "asc" }, { type: "desc" }], select: { id: true, type: true, locationId: true, referenceEntityId: true, quantityChanged: true, previousQuantity: true, newQuantity: true, timestamp: true, notes: true } } },
  });
  if (!t) return null;
  const info = await itemInfo(prisma, t.lines);
  const moves = await prisma.costMove.findMany({ where: { sourceType: "STOCK_TRANSFER", sourceId: id }, select: { kind: true, qty: true, value: true, glState: true, lineKey: true, sourceEvent: true } });
  // A line's value at cost: what left the source (a balance's SENT, a split lot's SPLIT_OUT); a finished lot moved whole
  // carries its holder's value (no cost move: the holder does not change).
  const wholeLots = t.lines.filter((l) => l.itemKind === "FG_LOT" && !moves.some((m) => m.lineKey === String(l.lineNo) && m.sourceEvent === "SPLIT_OUT")).map((l) => l.fgLotId ?? l.entityId);
  const lotValue = new Map((wholeLots.length ? await prisma.costItem.findMany({ where: { kind: "FG_LOT", entityId: { in: wholeLots } }, select: { entityId: true, value: true } }) : []).map((c) => [c.entityId, Number(c.value)]));
  const value = t.lines.map((l) => {
    const sent = moves.filter((m) => m.lineKey === String(l.lineNo) && (m.sourceEvent === "SENT" || m.sourceEvent === "SPLIT_OUT")).reduce((s, m) => s + Math.abs(Number(m.value)), 0);
    return l.itemKind === "FG_LOT" && sent === 0 ? lotValue.get(l.fgLotId ?? l.entityId) ?? 0 : sent;
  });
  const activity = await prisma.authAuditLog.findMany({ where: { action: { in: [...TRANSFER_ACTIONS] }, metadata: { path: ["transferId"], equals: id } }, orderBy: { occurredAt: "asc" }, select: { id: true, action: true, userId: true, occurredAt: true, metadata: true } });
  const people = [...new Set(activity.map((a) => a.userId).filter((x): x is string => !!x))];
  const names = new Map((people.length ? await prisma.employee.findMany({ where: { id: { in: people } }, select: { id: true, name: true } }) : []).map((e) => [e.id, e.name]));
  return {
    ...t, ref: transferRef(t.number), transferDate: dayText(t.transferDate),
    lines: t.lines.map((l, i) => ({ ...l, item: info.get(`${l.itemKind}:${l.entityId}`) ?? null, fgLot: l.fgLotId && l.fgLotId !== l.entityId ? info.get(`FG_LOT:${l.fgLotId}`) ?? null : null, value: value[i].toFixed(2) })),
    costMoves: moves.map((m) => ({ ...m, qty: String(m.qty), value: String(m.value) })),
    glStates: [...new Set(moves.map((m) => m.glState))],
    activity: activity.map((a) => ({ id: a.id, action: a.action, at: a.occurredAt, by: a.userId ? names.get(a.userId) ?? null : null, metadata: a.metadata })),
  };
}

/** Finished lots that can be transferred from a location (unit-tracked, AVAILABLE, free units > 0). */
export async function transferableLots(locationId: string) {
  const rows = await prisma.finishedGoodsLot.findMany({
    where: { locationId, isUnitTracked: true, status: "AVAILABLE", unitsAvailable: { gt: 0 } }, orderBy: { createdAt: "asc" }, take: 300,
    select: { id: true, batchNumber: true, unitsAvailable: true, unitsReserved: true, createdAt: true, splitFromLotId: true, productSku: { select: { skuCode: true, name: true, nameAr: true, weightGrams: true } }, product: { select: { productNameEn: true, productNameAr: true } } },
  });
  return rows.filter((r) => r.unitsAvailable - r.unitsReserved > 0).map((r) => ({
    id: r.id, batchNumber: r.batchNumber, free: r.unitsAvailable - r.unitsReserved, unitsAvailable: r.unitsAvailable, createdAt: r.createdAt, splitFromLotId: r.splitFromLotId,
    skuCode: r.productSku?.skuCode ?? null, name: r.productSku?.name ?? r.product.productNameEn, nameAr: r.productSku?.nameAr ?? r.product.productNameAr, weightGrams: r.productSku?.weightGrams ?? 0,
  }));
}

export { locationName };
