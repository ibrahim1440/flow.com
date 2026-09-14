import { Prisma } from "@/generated/prisma/client";
import {
  advisoryKey,
  outstandingDemandForItem,
  roastedKgForItem,
  type OutstandingDemand,
} from "./production-planning";
import {
  releaseShelfStock,
  trimReservationToDemand,
  roundKg,
  ALLOCATABLE_ITEM_SELECT,
} from "./shelf-allocation";
import { releaseFinishedUnits, trimUnitReservationToDemand } from "./finished-products";
import { TERMINAL_ORDER_STATUSES, isOrderStatus, type OrderStatus } from "./order-operations";

type PrismaTx = Prisma.TransactionClient;

/**
 * Structurally editing an order that already exists.
 *
 * "Structural" means adding a line, removing one, changing a quantity, or changing what a
 * line is for. All of it used to happen in one route that knew about kilograms and nothing
 * else, applied its changes outside any transaction, and asked no questions about the
 * order's state.
 *
 * The three things that made it dangerous:
 *
 *   - a SKU line's quantity lives in quantityUnits and its kilograms are DERIVED from it,
 *     but the route read and wrote only kilograms. Editing such a line rewrote the derived
 *     figure and left the authoritative one behind, and creating one set productSkuId
 *     without any units at all — the single shape the rest of the unit logic assumes cannot
 *     exist;
 *   - shrinking a line left its reservations untouched, so stock stayed promised to demand
 *     that no longer existed, and removing a line handed back only the kilogram half,
 *     leaving FinishedGoodsLot.unitsReserved counting units for a line that had been
 *     deleted;
 *   - and the quantity is the same demand that production scheduling and order-backed
 *     roasting serialise on. They take pg_advisory_xact_lock(7762, advisoryKey(itemId));
 *     the edit took nothing, so it could move the demand out from under either of them.
 */

/**
 * Statuses a structural edit may be made from.
 *
 * Built from the existing vocabulary — no new status is introduced. Terminal orders are
 * excluded because rewriting a Completed or Cancelled order is rewriting history, and
 * "On Hold" is excluded for the same reason preparation review excludes it: a held order is
 * resumed first, deliberately, rather than edited around.
 */
export const STRUCTURAL_EDIT_ENTRY_STATUSES: readonly OrderStatus[] = [
  "Waiting Approval",
  "Waiting Preparation Review",
  "Preparing",
  "Ready for Shipping",
];

export function assertStructuralEditAllowed(status: string): void {
  if (!isOrderStatus(status)) {
    throw { _appCode: 409, message: "This order's status is not one that can be edited." };
  }
  if (!STRUCTURAL_EDIT_ENTRY_STATUSES.includes(status)) {
    throw {
      _appCode: 409,
      message: TERMINAL_ORDER_STATUSES.has(status)
        ? `This order is ${status} and can no longer be changed.`
        : `An order that is ${status} cannot be restructured. Resume it first.`,
    };
  }
}

/** One line as the caller asked for it, before anything is known about the database. */
export type RequestedLine = {
  id?: string;
  beanTypeName: string;
  productId: string | null;
  productSkuId: string | null;
  quantityUnits: number | null;
  quantityKg: number | null;
};

/** One line after the server has decided what it actually means. */
export type ResolvedLine = {
  id?: string;
  beanTypeName: string;
  productId: string | null;
  productSkuId: string | null;
  /** Authoritative for a SKU line; null for a legacy kilogram line. */
  quantityUnits: number | null;
  /** Authoritative for a legacy line; DERIVED from units for a SKU line. */
  quantityKg: number;
};

const KG_TOLERANCE = 0.0005;

/**
 * Work out what a requested line means, with the server deciding which figure is the truth.
 *
 * For a SKU line units are authoritative and kilograms are computed from the SKU's own net
 * weight. A caller may still SEND kilograms — the edit screen does — but it is only ever an
 * assertion to be checked, never a second independent quantity. Letting both through is how
 * a line came to read 20 units and 1.75 kg at the same time.
 *
 * For a legacy line with no SKU, kilograms are the truth and units stay null. Nothing here
 * invents a unit count for a line that never had one.
 */
export async function normalizeRequestedLine(
  tx: PrismaTx,
  raw: RequestedLine,
): Promise<ResolvedLine> {
  if (typeof raw.beanTypeName !== "string" || !raw.beanTypeName) {
    throw { _appCode: 400, message: "Each order line needs a beanTypeName." };
  }

  if (raw.productSkuId) {
    const sku = await tx.productSKU.findUnique({
      where: { id: raw.productSkuId },
      select: { id: true, productId: true, weightGrams: true, skuCode: true },
    });
    if (!sku) throw { _appCode: 400, message: "Product SKU not found." };
    if (raw.productId && sku.productId !== raw.productId) {
      throw { _appCode: 400, message: "SKU does not belong to the specified product." };
    }

    const units = raw.quantityUnits;
    if (units === null || units === undefined) {
      throw {
        _appCode: 400,
        message: `"${sku.skuCode}" is sold in units, so this line needs a quantityUnits.`,
      };
    }
    if (!Number.isInteger(units) || units <= 0) {
      throw {
        _appCode: 400,
        message: "quantityUnits must be a whole number greater than zero.",
      };
    }

    const derivedKg = roundKg((units * sku.weightGrams) / 1000);

    // An assertion, checked. Anything else would be a second source of truth.
    if (raw.quantityKg !== null && raw.quantityKg !== undefined) {
      if (!Number.isFinite(raw.quantityKg) || Math.abs(raw.quantityKg - derivedKg) > KG_TOLERANCE) {
        throw {
          _appCode: 400,
          message:
            `${units} × "${sku.skuCode}" is ${derivedKg}kg, not ${raw.quantityKg}kg. ` +
            "The weight of a SKU line is derived from its unit count.",
        };
      }
    }

    return {
      id: raw.id,
      beanTypeName: raw.beanTypeName,
      productId: sku.productId,
      productSkuId: sku.id,
      quantityUnits: units,
      quantityKg: derivedKg,
    };
  }

  // ── Legacy kilogram line ────────────────────────────────────────────────
  const kg = Number(raw.quantityKg);
  if (!Number.isFinite(kg) || kg <= 0) {
    throw { _appCode: 400, message: "quantityKg must be a positive number." };
  }
  if (raw.quantityUnits !== null && raw.quantityUnits !== undefined) {
    throw {
      _appCode: 400,
      message: "A line without a product SKU is measured in kilograms and cannot carry units.",
    };
  }
  if (raw.productId) {
    const product = await tx.coffeeProduct.findUnique({
      where: { id: raw.productId },
      select: { id: true },
    });
    if (!product) throw { _appCode: 400, message: "Product not found." };
  }

  return {
    id: raw.id,
    beanTypeName: raw.beanTypeName,
    productId: raw.productId ?? null,
    productSkuId: null,
    quantityUnits: null,
    quantityKg: roundKg(kg),
  };
}

/**
 * Serialise this edit against everything else that spends the same demand.
 *
 * The key is the one production scheduling and order-backed roasting already use, and that
 * is the whole point: three operations read "how much does this line still need?" and act on
 * the answer, so they have to queue behind each other rather than each behind itself. A
 * shrink committing between a roast's ceiling check and its insert is exactly the race this
 * closes.
 *
 * Acquired in ascending advisory-key order, with the id as a tie-break. Sorting by id alone
 * would not do: the lock is taken on advisoryKey(id), and that hash does not preserve string
 * order, so two requests editing the same pair of lines could still take them in opposite
 * orders. Sorting by the value actually locked is what makes the order total.
 *
 * Only EXISTING lines have a demand key to lock. A line being created has no demand yet and
 * nothing can be racing on it, so it needs none.
 */
export async function lockOrderEditDemandKeys(
  tx: PrismaTx,
  orderItemIds: readonly string[],
): Promise<void> {
  const keyed = [...new Set(orderItemIds)]
    .map((id) => ({ id, key: advisoryKey(id) }))
    .sort((a, b) => (a.key - b.key) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const { key } of keyed) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7762, ${key}::int)`;
  }
}

/** What the line looks like in the database right now, for edit decisions. */
export type LiveLine = {
  id: string;
  quantityKg: number;
  quantityUnits: number | null;
  deliveredQty: number;
  deliveredUnits: number;
  productSkuId: string | null;
  productId: string | null;
};

/**
 * Refuse to shrink a line past what has already left the building.
 *
 * Checked on the axis the line is actually measured in: a SKU line against delivered units,
 * a legacy line against delivered kilograms. The previous check compared the incoming
 * kilogram figure against deliveredQty for every line, which on a unit line is a comparison
 * between a derived number and a column that unit deliveries do not even write.
 */
export function assertNotBelowDelivered(live: LiveLine, next: ResolvedLine): void {
  if (live.quantityUnits !== null && next.quantityUnits !== null) {
    if (next.quantityUnits < live.deliveredUnits) {
      throw {
        _appCode: 409,
        message:
          `${live.deliveredUnits} unit(s) of this line have already been delivered, so it ` +
          `cannot be reduced to ${next.quantityUnits}.`,
      };
    }
    return;
  }
  if (next.quantityKg + KG_TOLERANCE < live.deliveredQty) {
    throw {
      _appCode: 409,
      message:
        `${live.deliveredQty}kg of this line has already been delivered, so it cannot be ` +
        `reduced to ${next.quantityKg}kg.`,
    };
  }
}

/**
 * Canonical demand for a SKU line, or null for a line that is not measured in units.
 *
 * There is one demand truth in this system and it is outstandingDemandForItem. The edit
 * reads it rather than counting production orders itself, and the difference is not
 * cosmetic. Raw `targetUnits` is not coverage: once a production order has been partly
 * packed those units are finished goods, counted again as reserved, and the part still owed
 * is `max(0, target − produced)`. Summing raw targets both double-counts what was produced
 * and refuses edits that are perfectly safe.
 */
async function demandFor(tx: PrismaTx, live: LiveLine): Promise<OutstandingDemand | null> {
  if (live.quantityUnits === null) return null;
  return outstandingDemandForItem(tx, {
    id: live.id,
    quantityUnits: live.quantityUnits,
    deliveredUnits: live.deliveredUnits,
  });
}

/**
 * Refuse to shrink a line below the coverage that cannot be handed back.
 *
 * A line's demand is covered by three things, and only one of them is reversible here:
 *
 *   delivered — gone. Never reducible.
 *   scheduled — the unpacked remainder of its open production orders. Reducing a target, or
 *               deciding which roast was surplus, is a reversal workflow; inventing one as a
 *               side effect of an order edit is exactly the kind of silent correction this
 *               remediation keeps removing. The operator cancels the production order, or
 *               cancels the order.
 *   reserved  — a promise, and promises are given back. reconcileLineReservations does it.
 *
 * So the floor a shrink has to clear is delivered + scheduled, and everything above that
 * floor is reconciled by releasing reservations. What must hold after a successful shrink is
 * the canonical demand equation itself, kept non-negative:
 *
 *   delivered + reserved + scheduled <= ordered
 *
 * The previous version of this function compared raw `targetUnits` against the new quantity
 * and looked at nothing else. It let coverage exceed the order — 8 units reserved plus 2
 * scheduled against a line shrunk to 8 — because it never considered reservations at all,
 * and it refused safe edits on a production order that had already been mostly packed.
 *
 * ── Roast that nothing accounts for ────────────────────────────────────────
 * Coffee roasted straight against the line with no production order behind it is invisible
 * to that equation: neither delivered, nor reserved, nor scheduled. Shrinking below it would
 * strand it, so it is checked on its own, on the kilogram axis it is measured in. Roast that
 * a production order IS holding is deliberately not checked here — it is already represented,
 * as produced units or as the remainder still scheduled, and counting it twice would refuse
 * the safe edits all over again.
 */
export async function assertShrinkNotBelowProduction(
  tx: PrismaTx,
  live: LiveLine,
  next: ResolvedLine,
): Promise<void> {
  const shrinking =
    live.quantityUnits !== null && next.quantityUnits !== null
      ? next.quantityUnits < live.quantityUnits
      : next.quantityKg + KG_TOLERANCE < live.quantityKg;
  if (!shrinking) return;

  const roasted = await roastedKgForItem(tx, live.id);
  const demand = await demandFor(tx, live);

  if (demand !== null && next.quantityUnits !== null) {
    const floor = demand.deliveredUnits + demand.scheduledUnits;
    if (next.quantityUnits < floor) {
      throw {
        _appCode: 409,
        message:
          `This line is already committed to ${demand.deliveredUnits} delivered unit(s) and ` +
          `${demand.scheduledUnits} unit(s) of open production, so it cannot be reduced to ` +
          `${next.quantityUnits}. Cancel that production first, or cancel the order.`,
      };
    }
    if (roasted.unaccountedKg > next.quantityKg + KG_TOLERANCE) {
      throw {
        _appCode: 409,
        message:
          `${roasted.unaccountedKg}kg has already been roasted for this line, so it cannot be ` +
          `reduced to ${next.quantityKg}kg. Cancel the order instead, or reduce it to at ` +
          "least what has been produced.",
      };
    }
    return;
  }

  // Legacy kilogram line. A production order cannot exist for one — ProductionOrder.productSkuId
  // is required, and createProductionOrderFromSales refuses a line with no SKU — so every
  // kilogram roasted for it is unaccounted by definition and the whole roast is the floor.
  if (roasted.totalKg > next.quantityKg + KG_TOLERANCE) {
    throw {
      _appCode: 409,
      message:
        `${roasted.totalKg}kg has already been roasted for this line, so it cannot be reduced ` +
        `to ${next.quantityKg}kg. Cancel the order instead, or reduce it to at least what has ` +
        "been produced.",
    };
  }
}

/**
 * Refuse to change what a line IS once anything has happened to it.
 *
 * A SKU is not a label; it decides which lots may cover the line, what a production order
 * makes, and what packaging may be matched to it. Swapping it on a line that already holds
 * reservations or production would silently re-point all of that at a different product.
 * A line nothing has happened to yet is still just an intention, and may be corrected.
 */
export async function assertIdentityChangeAllowed(
  tx: PrismaTx,
  live: LiveLine,
  next: ResolvedLine,
): Promise<void> {
  const sameSku = (live.productSkuId ?? null) === (next.productSkuId ?? null);
  const sameProduct = (live.productId ?? null) === (next.productId ?? null);
  if (sameSku && sameProduct) return;

  const history = await lineHistory(tx, live.id);
  if (history.total > 0) {
    throw {
      _appCode: 409,
      message:
        "This line already has stock reserved, production or deliveries against it, so the " +
        "product it is for cannot be changed. Remove the line and add the right one, or " +
        "raise a new order.",
    };
  }
}

/** Everything that makes a line more than an intention. */
export async function lineHistory(
  tx: PrismaTx,
  orderItemId: string,
): Promise<{ allocations: number; deliveries: number; batches: number; productionOrders: number; total: number }> {
  const [allocations, deliveries, batches, productionOrders] = await Promise.all([
    tx.stockAllocation.count({ where: { orderItemId, status: "RESERVED" } }),
    tx.delivery.count({ where: { orderItemId } }),
    tx.roastingBatch.count({ where: { orderItemId } }),
    tx.productionOrder.count({ where: { sourceOrderItemId: orderItemId, status: { not: "CANCELLED" } } }),
  ]);
  return {
    allocations,
    deliveries,
    batches,
    productionOrders,
    total: allocations + deliveries + batches + productionOrders,
  };
}

/**
 * May this line be physically removed?
 *
 * Reservations do not block removal — they are given back. Everything else does, because it
 * is history rather than intention, and because the database would not stop any of it:
 * RoastingBatch and Delivery CASCADE from OrderItem, and ProductionOrder.sourceOrderItemId
 * is ON DELETE SET NULL, so removing a line would quietly detach a live production order and
 * leave it attributed to nobody. Refusing is the honest answer; cancelling somebody's
 * production as a side effect of an order edit is not a decision this route should make.
 */
export async function validateLineRemoval(tx: PrismaTx, live: LiveLine): Promise<void> {
  if (live.deliveredUnits > 0 || live.deliveredQty > 0) {
    throw {
      _appCode: 409,
      message: "This line has already been delivered against, so it cannot be removed. Cancel the order instead.",
    };
  }

  const history = await lineHistory(tx, live.id);
  if (history.batches > 0 || history.deliveries > 0) {
    throw {
      _appCode: 409,
      message:
        "Cannot remove order items that have active production batches or delivery records. Deactivate the order instead.",
    };
  }
  if (history.productionOrders > 0) {
    throw {
      _appCode: 409,
      message:
        "This line has production scheduled against it. Cancel that production order first, " +
        "then remove the line.",
    };
  }
}

/**
 * Hand back everything a line is holding, in both denominations.
 *
 * Both halves, always. The removal path used to call only the kilogram release; unit
 * allocations then vanished with the row through the CASCADE, but FinishedGoodsLot's
 * unitsReserved counter is maintained only by the unit release helper, so those units stayed
 * marked as promised to a line that no longer existed — invisible stock, permanently.
 */
export async function releaseAllReservations(tx: PrismaTx, orderItemId: string): Promise<void> {
  await releaseFinishedUnits(tx, orderItemId);
  await releaseShelfStock(tx, orderItemId);
}

/**
 * Give back whatever the line no longer needs after a quantity change.
 *
 * Runs AFTER the new quantity is written, because both trim helpers derive their ceiling
 * from the line's current figures. Neither is reimplemented here: which reservation is
 * released first is their decision, and they are the versions already certified by the
 * delivery and preparation paths — the unit trim takes newest allocations first and
 * acquires its locks in id order, the kilogram trim releases through the same path a
 * delivery does.
 *
 * An increase needs nothing: a bigger order does not conjure stock, it just leaves more
 * outstanding for the normal planning path to cover.
 *
 * ── Why scheduled production is passed in ──────────────────────────────────
 * The trim on its own releases down to ordered − delivered, which is the whole story after a
 * delivery and only part of it after a shrink. A line ordering 10 with 8 reserved and 2 units
 * still owed by an open production order, shrunk to 8, releases nothing under that rule and
 * ends up covered for 10 against an order of 8. The scheduled remainder is coverage too, so
 * it is subtracted from the ceiling the reservations are allowed to fill — which makes the
 * ceiling the canonical demand equation, and assertShrinkNotBelowProduction has already
 * refused every edit that would leave it negative.
 */
export async function reconcileLineReservations(tx: PrismaTx, orderItemId: string): Promise<number> {
  const item = await tx.orderItem.findUnique({
    where: { id: orderItemId },
    select: { ...ALLOCATABLE_ITEM_SELECT, quantityUnits: true, deliveredUnits: true },
  });
  if (!item) return 0;

  if (item.quantityUnits !== null) {
    const line = {
      id: item.id,
      quantityUnits: item.quantityUnits,
      deliveredUnits: item.deliveredUnits,
    };
    const demand = await outstandingDemandForItem(tx, line);
    return trimUnitReservationToDemand(tx, line, demand.scheduledUnits);
  }
  return trimReservationToDemand(tx, item);
}
