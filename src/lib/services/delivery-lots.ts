import { Prisma } from "@/generated/prisma/client";
import { lotMatchFilter, roundKg, type AllocatableItem } from "./shelf-allocation";
import type { PlanCandidate } from "./delivery-plan";

export { planDispatch, splitKg, type PlanCandidate, type PlannedLot, type DispatchPlan } from "./delivery-plan";

type Db = Prisma.TransactionClient;

/**
 * Dispatch without lots (production simplification, Phase D item 7).
 *
 * The dispatcher states a quantity per order line; the server decides which finished-goods lots
 * it leaves from. The rule is the one the prototype states and the shelf already follows:
 *
 *   1. what this line already holds — its RESERVED allocations — oldest lot first;
 *   2. then units (or kilograms) free to anyone, oldest lot first;
 *
 * spanning as many lots as needed. Roasted coffee degrades, so FIFO is the business rule, and a
 * line's own reservation comes first because those units were promised to this customer and
 * shipping them leaves everybody else's free-to-promise untouched.
 *
 * The planner is deliberately pure: the route reads the candidate rows after it holds their
 * locks, hands them here, and then consumes lot by lot through the existing
 * consumeFinishedUnits / consumeShelfStock, which re-check every quantity atomically. A plan is
 * therefore a proposal the consumption either honours exactly or refuses (409, full rollback).
 */

// ─── Candidates, read from the database ──────────────────────────────────────

/**
 * Every lot a unit line could ship from: unit-tracked AVAILABLE lots of its SKU that still hold
 * units, plus the lots it holds a reservation on. Ids only — the route locks these (in id order)
 * before it reads a single balance.
 */
export async function unitCandidateLotIds(tx: Db, orderItemId: string, productSkuId: string): Promise<string[]> {
  const [shelf, held] = await Promise.all([
    tx.finishedGoodsLot.findMany({
      where: { productSkuId, isUnitTracked: true, status: "AVAILABLE", unitsAvailable: { gt: 0 } },
      select: { id: true },
    }),
    tx.stockAllocation.findMany({
      where: { orderItemId, status: "RESERVED", quantityUnits: { not: null } },
      select: { finishedGoodsLotId: true },
    }),
  ]);
  return [...new Set([...shelf.map((l) => l.id), ...held.map((a) => a.finishedGoodsLotId)])];
}

/** The kilogram twin: lots lotMatchFilter accepts for this line, plus the lots it holds kg on. */
export async function kgCandidateLotIds(tx: Db, item: AllocatableItem): Promise<string[]> {
  const [shelf, held] = await Promise.all([
    tx.finishedGoodsLot.findMany({ where: { ...lotMatchFilter(item), availableQty: { gt: 0 } }, select: { id: true } }),
    tx.stockAllocation.findMany({
      where: { orderItemId: item.id, status: "RESERVED", quantityUnits: null },
      select: { finishedGoodsLotId: true },
    }),
  ]);
  return [...new Set([...shelf.map((l) => l.id), ...held.map((a) => a.finishedGoodsLotId)])];
}

/**
 * Plan candidates for a unit line, read AFTER the locks are held and restricted to the locked
 * set: a lot packed after the lock statement ran is not touched by this dispatch, so the
 * transaction never reaches for a lot lock while it already holds the OrderItem.
 */
export async function unitPlanCandidates(
  tx: Db, orderItemId: string, productSkuId: string, lockedLotIds: readonly string[], locationId?: string | null,
): Promise<PlanCandidate[]> {
  if (lockedLotIds.length === 0) return [];
  const [lots, held] = await Promise.all([
    // 20261117090000: only the lots at the ship-from location (a lot in transit is not AVAILABLE).
    tx.finishedGoodsLot.findMany({
      where: { id: { in: [...lockedLotIds] }, productSkuId, isUnitTracked: true, status: "AVAILABLE", ...(locationId ? { locationId } : {}) },
      select: { id: true, createdAt: true, unitsAvailable: true, unitsReserved: true },
    }),
    tx.stockAllocation.groupBy({
      by: ["finishedGoodsLotId"],
      where: { orderItemId, status: "RESERVED", quantityUnits: { not: null }, finishedGoodsLotId: { in: [...lockedLotIds] } },
      _sum: { quantityUnits: true },
    }),
  ]);
  const heldBy = new Map(held.map((h) => [h.finishedGoodsLotId, h._sum.quantityUnits ?? 0]));
  return lots.map((l) => {
    const h = Math.min(heldBy.get(l.id) ?? 0, l.unitsAvailable);
    return { lotId: l.id, createdAt: l.createdAt, held: h, free: Math.max(0, l.unitsAvailable - l.unitsReserved) };
  });
}

export async function kgPlanCandidates(
  tx: Db, item: AllocatableItem, lockedLotIds: readonly string[], locationId?: string | null,
): Promise<PlanCandidate[]> {
  if (lockedLotIds.length === 0) return [];
  const [lots, held] = await Promise.all([
    tx.finishedGoodsLot.findMany({
      where: { AND: [{ id: { in: [...lockedLotIds] } }, lotMatchFilter(item), ...(locationId ? [{ locationId }] : [])] },
      select: { id: true, createdAt: true, availableQty: true, reservedQty: true },
    }),
    tx.stockAllocation.groupBy({
      by: ["finishedGoodsLotId"],
      where: { orderItemId: item.id, status: "RESERVED", quantityUnits: null, finishedGoodsLotId: { in: [...lockedLotIds] } },
      _sum: { quantityKg: true },
    }),
  ]);
  const heldBy = new Map(held.map((h) => [h.finishedGoodsLotId, roundKg(h._sum.quantityKg ?? 0)]));
  return lots.map((l) => ({
    lotId: l.id,
    createdAt: l.createdAt,
    held: roundKg(Math.min(heldBy.get(l.id) ?? 0, l.availableQty)),
    free: Math.max(0, roundKg(l.availableQty - l.reservedQty)),
  }));
}

// ─── Readers: which lots a delivery used ─────────────────────────────────────

export type DeliveryLotRef = {
  finishedGoodsLotId: string;
  batchNumber: string | null;
  quantityUnits: number | null;
  quantityKg: number;
  /** "line" = a DeliveryLine row; "ledger" = a delivery recorded before DeliveryLine existed. */
  source: "line" | "ledger";
};

/**
 * The lots behind each delivery, for every reader (dispatch history, export, order detail, the
 * customer timeline, automation). Two shapes exist and both are answered:
 *   · deliveries recorded since 20261023100000_delivery_lines have DeliveryLine rows;
 *   · older ones have none, and their single lot is on the ledger — the InventoryMovement OUT
 *     with sourceDocType DELIVERY and sourceDocId = the delivery (its referenceEntityId is the lot).
 * Two queries at most, whatever the number of deliveries.
 */
export async function deliveryLotsFor(db: Db, deliveryIds: readonly string[]): Promise<Map<string, DeliveryLotRef[]>> {
  const out = new Map<string, DeliveryLotRef[]>();
  const ids = [...new Set(deliveryIds)];
  if (ids.length === 0) return out;

  const lines = await db.deliveryLine.findMany({
    where: { deliveryId: { in: ids } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { deliveryId: true, finishedGoodsLotId: true, quantityUnits: true, quantityKg: true, finishedGoodsLot: { select: { batchNumber: true } } },
  });
  for (const l of lines) {
    const arr = out.get(l.deliveryId) ?? [];
    arr.push({ finishedGoodsLotId: l.finishedGoodsLotId, batchNumber: l.finishedGoodsLot.batchNumber, quantityUnits: l.quantityUnits, quantityKg: l.quantityKg, source: "line" });
    out.set(l.deliveryId, arr);
  }

  const legacy = ids.filter((id) => !out.has(id));
  if (legacy.length) {
    const moves = await db.inventoryMovement.findMany({
      where: { sourceDocType: "DELIVERY", sourceDocId: { in: legacy }, category: "FINISHED_GOODS", type: "OUT" },
      orderBy: { timestamp: "asc" },
      select: { sourceDocId: true, referenceEntityId: true, quantityChanged: true },
    });
    const lotIds = [...new Set(moves.map((m) => m.referenceEntityId).filter((x): x is string => !!x))];
    const lots = lotIds.length
      ? await db.finishedGoodsLot.findMany({ where: { id: { in: lotIds } }, select: { id: true, batchNumber: true } })
      : [];
    const batchOf = new Map(lots.map((l) => [l.id, l.batchNumber]));
    for (const m of moves) {
      if (!m.sourceDocId || !m.referenceEntityId) continue;
      const arr = out.get(m.sourceDocId) ?? [];
      arr.push({ finishedGoodsLotId: m.referenceEntityId, batchNumber: batchOf.get(m.referenceEntityId) ?? null, quantityUnits: null, quantityKg: roundKg(-m.quantityChanged), source: "ledger" });
      out.set(m.sourceDocId, arr);
    }
  }
  return out;
}

/** Attach `lots` to each delivery-shaped row, preserving every existing field. */
export async function withDeliveryLots<T extends { id: string }>(db: Db, rows: T[]): Promise<(T & { lots: DeliveryLotRef[] })[]> {
  const map = await deliveryLotsFor(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lots: map.get(r.id) ?? [] }));
}
