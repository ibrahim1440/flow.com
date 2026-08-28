import { Prisma } from "@/generated/prisma/client";

type PrismaTx = Prisma.TransactionClient;

// Repo-wide kg precision convention (see order-operations.ts): gram-level, 3 decimals.
export const roundKg = (v: number): number => Number(v.toFixed(3));

/** Treat differences below one gram as equal — the storage precision is 3 decimals. */
export const kgEqual = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

export type AllocatableItem = {
  id: string;
  productId: string | null;
  productSkuId: string | null;
  greenBeanId: string | null;
  quantityKg: number;
  deliveredQty: number;
};

export const ALLOCATABLE_ITEM_SELECT = {
  id: true,
  productId: true,
  productSkuId: true,
  greenBeanId: true,
  quantityKg: true,
  deliveredQty: true,
} as const;

/**
 * Which finished-goods lots may cover this order item, in descending order of how
 * confidently the coffee can be identified. This is the same three-tier idea the
 * dispatch screen already uses when it ranks lots for an operator.
 *
 *   1. Product — the real pooling key. Any lot of the same product fulfils the item,
 *      which is what makes a shelf a shelf rather than a per-order cupboard.
 *   2. Green bean — for items that name a bean but no product (the shape most orders in
 *      this database actually have). A lot packaged from a batch of the same green lot
 *      is the same coffee, so it pools too. Without this tier shelf-first would be
 *      unreachable for every order that skips the optional product picker.
 *   3. Neither — the item is identified only by a free-text bean name, so nothing can be
 *      matched to it except lots packaged from its own batches.
 *
 * SKU is only enforced when both sides declare one — same tolerance the delivery route
 * already applies to legacy rows with a null SKU on either side.
 */
export function lotMatchFilter(item: AllocatableItem): Prisma.FinishedGoodsLotWhereInput {
  const base: Prisma.FinishedGoodsLotWhereInput = item.productId
    ? { productId: item.productId }
    : item.greenBeanId
    ? { roastingBatch: { greenBeanId: item.greenBeanId } }
    : { roastingBatch: { orderItemId: item.id } };

  const sku: Prisma.FinishedGoodsLotWhereInput = item.productSkuId
    ? { OR: [{ productSkuId: null }, { productSkuId: item.productSkuId }] }
    : {};

  return { ...base, ...sku, status: "AVAILABLE" };
}

/** Kilograms currently promised to this order item and not yet shipped. */
export async function reservedForItem(tx: PrismaTx, orderItemId: string): Promise<number> {
  const agg = await tx.stockAllocation.aggregate({
    where: { orderItemId, status: "RESERVED" },
    _sum: { quantityKg: true },
  });
  return roundKg(agg._sum.quantityKg ?? 0);
}

/**
 * Outstanding demand: the part of the order that is neither already shipped nor already
 * promised from the shelf. This is the number that must be sourced — and, once the shelf
 * has been drawn down, the number that must be roasted.
 *
 * Deliberately NOT derived from OrderItem.remainingQty: that field is written by
 * recalcOrderItemStatus and means "produced but not yet delivered", a different quantity
 * that happens to be seeded with the ordered amount at creation time.
 */
export async function outstandingForItem(tx: PrismaTx, item: AllocatableItem): Promise<number> {
  const reserved = await reservedForItem(tx, item.id);
  return Math.max(0, roundKg(item.quantityKg - item.deliveredQty - reserved));
}

export type CandidateLot = {
  id: string;
  batchNumber: string;
  availableQty: number;
  reservedQty: number;
  freeQty: number;
  productId: string;
  productSkuId: string | null;
  product: { productNameEn: string; productNameAr: string | null };
};

/**
 * Lots that could cover this item, oldest first.
 *
 * FIFO is not arbitrary: roasted coffee degrades, so the oldest free lot is always the one
 * that should leave the shelf next.
 */
export async function candidateLots(tx: PrismaTx, item: AllocatableItem): Promise<CandidateLot[]> {
  const lots = await tx.finishedGoodsLot.findMany({
    where: { ...lotMatchFilter(item), availableQty: { gt: 0 } },
    select: {
      id: true,
      batchNumber: true,
      availableQty: true,
      reservedQty: true,
      productId: true,
      productSkuId: true,
      product: { select: { productNameEn: true, productNameAr: true } },
    },
    // FIFO, with id as a tiebreak. The tiebreak is not cosmetic: two lots packaged in the
    // same millisecond would otherwise come back in an arbitrary order, and concurrent
    // transactions could then take row locks on them in opposite orders and deadlock.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  return lots
    .map((l) => ({ ...l, freeQty: roundKg(l.availableQty - l.reservedQty) }))
    .filter((l) => l.freeQty > 0);
}

/** Total kilograms of this item's product that are on the shelf and promised to nobody. */
export async function freeToPromiseForItem(tx: PrismaTx, item: AllocatableItem): Promise<number> {
  const lots = await candidateLots(tx, item);
  return roundKg(lots.reduce((sum, l) => sum + l.freeQty, 0));
}

/**
 * The free-to-promise shelf, indexed by every key an order line might match on.
 *
 * Returns a per-LOT free balance plus the lot ids reachable by each product and each
 * green bean. Callers draw down the per-lot balances, never the per-key totals — a lot
 * is reachable under two different keys at once (its product and its green bean), and
 * bucketing by key would let two order lines each spend the same kilograms.
 */
async function shelfPool(
  tx: PrismaTx,
  productIds: string[],
  greenBeanIds: string[]
): Promise<{ free: Map<string, number>; byProduct: Map<string, string[]>; byGreenBean: Map<string, string[]> }> {
  const free = new Map<string, number>();
  const byProduct = new Map<string, string[]>();
  const byGreenBean = new Map<string, string[]>();
  if (productIds.length === 0 && greenBeanIds.length === 0) return { free, byProduct, byGreenBean };

  const or: Prisma.FinishedGoodsLotWhereInput[] = [];
  if (productIds.length) or.push({ productId: { in: productIds } });
  if (greenBeanIds.length) or.push({ roastingBatch: { greenBeanId: { in: greenBeanIds } } });

  const lots = await tx.finishedGoodsLot.findMany({
    where: { status: "AVAILABLE", availableQty: { gt: 0 }, OR: or },
    select: {
      id: true,
      productId: true,
      availableQty: true,
      reservedQty: true,
      roastingBatch: { select: { greenBeanId: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  for (const lot of lots) {
    const f = roundKg(lot.availableQty - lot.reservedQty);
    if (f <= 0) continue;
    free.set(lot.id, f);
    byProduct.set(lot.productId, [...(byProduct.get(lot.productId) ?? []), lot.id]);
    const gb = lot.roastingBatch?.greenBeanId;
    if (gb) byGreenBean.set(gb, [...(byGreenBean.get(gb) ?? []), lot.id]);
  }
  return { free, byProduct, byGreenBean };
}

/**
 * Free-to-promise per product id. Kept for callers that only reason about products.
 */
export async function freeToPromiseByProduct(
  tx: PrismaTx,
  productIds: string[]
): Promise<Map<string, number>> {
  const { free, byProduct } = await shelfPool(tx, productIds, []);
  const out = new Map<string, number>();
  for (const [productId, lotIds] of byProduct) {
    out.set(productId, roundKg(lotIds.reduce((sum, id) => sum + (free.get(id) ?? 0), 0)));
  }
  return out;
}

export type OrderLineDemand = {
  beanTypeName: string;
  quantityKg: number;
  greenBeanId: string | null;
  productId: string | null;
};

/**
 * Can this order be accepted at all?
 *
 * Shelf first: whatever is already roasted and free is counted against the line before
 * any green beans are asked for. Only the remainder has to exist as raw stock. The old
 * rule looked at green beans alone, so an order was refused for want of raw coffee even
 * when the finished article was sitting on the shelf.
 *
 * The free-to-promise pool is drawn down across lines, so two lines of the same product
 * cannot both be covered by the same kilograms.
 *
 * Returns a list of human-readable shortfalls; empty means the order is servable.
 */
export async function checkOrderAvailability(
  tx: PrismaTx,
  lines: OrderLineDemand[]
): Promise<string[]> {
  const productIds = [...new Set(lines.map((l) => l.productId).filter((p): p is string => !!p))];
  const greenBeanIds = [...new Set(lines.map((l) => l.greenBeanId).filter((g): g is string => !!g))];
  const { free, byProduct, byGreenBean } = await shelfPool(tx, productIds, greenBeanIds);

  // Green demand left over after the shelf has absorbed what it can.
  const greenDemand = new Map<string, number>();

  for (const line of lines) {
    let remaining = roundKg(line.quantityKg);

    // Same precedence as lotMatchFilter: product identifies the coffee best, green bean
    // is the fallback. Draw down per lot so one lot cannot cover two lines twice.
    const reachable = line.productId
      ? byProduct.get(line.productId) ?? []
      : line.greenBeanId
      ? byGreenBean.get(line.greenBeanId) ?? []
      : [];

    for (const lotId of reachable) {
      if (remaining <= 0) break;
      const avail = free.get(lotId) ?? 0;
      if (avail <= 0) continue;
      const take = roundKg(Math.min(remaining, avail));
      free.set(lotId, roundKg(avail - take));
      remaining = roundKg(remaining - take);
    }

    if (remaining > 0 && line.greenBeanId) {
      greenDemand.set(line.greenBeanId, roundKg((greenDemand.get(line.greenBeanId) ?? 0) + remaining));
    }
  }

  if (greenDemand.size === 0) return [];

  const beans = await tx.greenBean.findMany({
    where: { id: { in: [...greenDemand.keys()] } },
    select: { id: true, beanType: true, quantityKg: true },
  });
  const stock = new Map(beans.map((b) => [b.id, b.quantityKg]));

  const shortfalls: string[] = [];
  for (const [beanId, demand] of greenDemand) {
    const available = stock.get(beanId) ?? 0;
    if (demand > available) {
      const bean = beans.find((b) => b.id === beanId);
      shortfalls.push(
        `${bean?.beanType ?? "Unknown"}: need ${demand}kg of green beans after the shelf is counted, available ${available}kg`
      );
    }
  }
  return shortfalls;
}

export type ReservationResult = {
  reservedKg: number;
  lots: { lotId: string; batchNumber: string; quantityKg: number }[];
};

/**
 * Reserve up to `wantedKg` for this order item, drawing FIFO across matching lots.
 *
 * Atomicity: the reservation is taken by a single conditional UPDATE per lot whose WHERE
 * clause re-checks free stock. Under PostgreSQL's READ COMMITTED, a concurrent writer on
 * the same row blocks and then re-evaluates that WHERE against the committed row, so two
 * simultaneous reservations can never both succeed on the same kilograms. Prisma's
 * updateMany cannot express the column-to-column comparison, hence $executeRaw.
 *
 * Reserves as much as it can and reports the shortfall through the return value — a
 * partially covered item is a normal, expected outcome, not an error.
 */
export async function reserveShelfStock(
  tx: PrismaTx,
  item: AllocatableItem,
  wantedKg: number,
  userId: string | null
): Promise<ReservationResult> {
  const want = roundKg(Math.max(0, wantedKg));
  if (want <= 0) return { reservedKg: 0, lots: [] };

  const lots = await candidateLots(tx, item);
  const taken: ReservationResult["lots"] = [];
  let remaining = want;

  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = roundKg(Math.min(remaining, lot.freeQty));
    if (take <= 0) continue;

    // The +0.0005 in the guard below is half a gram of slack: `take` came from a
    // roundKg'd read while the columns carry raw IEEE754 sums, and without it accumulated
    // float error can make the guard reject a quantity the caller was just told was free,
    // skipping the whole lot. Half a gram is below the 3-decimal precision every kg figure
    // here is stored at, so it can never let through a quantity that is actually short.
    // Note: keep it out of the SQL. An ${"$"}{...} inside a `--` comment in a tagged template
    // still becomes a bind parameter, and Postgres cannot type one it never sees used.
    const affected = await tx.$executeRaw`
      UPDATE "FinishedGoodsLot"
         SET "reservedQty" = "reservedQty" + ${take}
       WHERE "id" = ${lot.id}
         AND "status" = 'AVAILABLE'
         AND ("availableQty" - "reservedQty" + 0.0005) >= ${take}
    `;
    // 0 rows means another transaction took this stock between the read and the write.
    // Skip the lot rather than failing: the loop simply moves on to the next one.
    if (affected !== 1) continue;

    await tx.stockAllocation.create({
      data: {
        orderItemId: item.id,
        finishedGoodsLotId: lot.id,
        quantityKg: take,
        status: "RESERVED",
        createdById: userId,
      },
    });

    taken.push({ lotId: lot.id, batchNumber: lot.batchNumber, quantityKg: take });
    remaining = roundKg(remaining - take);
  }

  return { reservedKg: roundKg(want - remaining), lots: taken };
}

/**
 * Give back every kilogram this order item is holding. Used when a review downgrades an
 * item to Blocked, when the order is cancelled, and before a re-review recomputes cover.
 */
export async function releaseShelfStock(tx: PrismaTx, orderItemId: string): Promise<number> {
  return releaseAllocations(tx, { orderItemId, status: "RESERVED" });
}

/**
 * Release exactly the allocation rows this call manages to claim.
 *
 * The status flip comes FIRST and is itself the lock: `updateMany` on rows still marked
 * RESERVED returns how many it actually changed, so a concurrent releaser that got there
 * first walks away with zero rows and decrements nothing. Reading the rows and then
 * subtracting their quantities — the obvious implementation — lets two callers both read
 * the same 5kg row and both take 5kg off the lot, and `GREATEST(0, …)` would quietly
 * absorb the second subtraction instead of surfacing it.
 */
async function releaseAllocations(
  tx: PrismaTx,
  where: { orderItemId: string; status: "RESERVED"; finishedGoodsLotId?: { not: string } },
  limitKg?: number
): Promise<number> {
  const candidates = await tx.stockAllocation.findMany({
    where,
    select: { id: true, finishedGoodsLotId: true, quantityKg: true },
    // Newest first when trimming: the most recent promise is the one to give back.
    // Deterministic order also keeps concurrent releasers taking lot locks in step.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (candidates.length === 0) return 0;

  let released = 0;
  let budget = limitKg === undefined ? Infinity : roundKg(limitKg);

  for (const a of candidates) {
    if (budget <= 0) break;
    if (a.quantityKg > budget + 0.0005) {
      // Partial give-back: shrink the row rather than dropping it whole.
      const giveBack = roundKg(budget);
      const shrunk = await tx.stockAllocation.updateMany({
        where: { id: a.id, status: "RESERVED", quantityKg: a.quantityKg },
        data: { quantityKg: roundKg(a.quantityKg - giveBack) },
      });
      if (shrunk.count === 0) continue; // someone else changed it — leave it alone
      await tx.$executeRaw`
        UPDATE "FinishedGoodsLot"
           SET "reservedQty" = GREATEST(0, "reservedQty" - ${giveBack})
         WHERE "id" = ${a.finishedGoodsLotId}
      `;
      released = roundKg(released + giveBack);
      budget = 0;
      continue;
    }

    // Claim the row by flipping its status; count === 0 means another caller had it.
    const claimed = await tx.stockAllocation.updateMany({
      where: { id: a.id, status: "RESERVED" },
      data: { status: "RELEASED" },
    });
    if (claimed.count === 0) continue;

    await tx.$executeRaw`
      UPDATE "FinishedGoodsLot"
         SET "reservedQty" = GREATEST(0, "reservedQty" - ${a.quantityKg})
       WHERE "id" = ${a.finishedGoodsLotId}
    `;
    released = roundKg(released + a.quantityKg);
    budget = budget === Infinity ? Infinity : roundKg(budget - a.quantityKg);
  }

  return released;
}

/**
 * Give back any promise this item no longer needs — it has been delivered, or shrunk.
 *
 * Called after every delivery. Without it an item that reserved 6kg on lot A and 4kg on
 * lot B, then took all 10kg off lot B, would leave the 6kg on A promised to an order that
 * is already complete: stock that is physically present, permanently invisible to
 * everyone else.
 */
export async function trimReservationToDemand(
  tx: PrismaTx,
  item: AllocatableItem
): Promise<number> {
  const stillWanted = Math.max(0, roundKg(item.quantityKg - item.deliveredQty));
  const reserved = await reservedForItem(tx, item.id);
  const excess = roundKg(reserved - stillWanted);
  if (excess <= 0) return 0;
  return releaseAllocations(tx, { orderItemId: item.id, status: "RESERVED" }, excess);
}

/** Kilograms this order item holds on one specific lot. */
export async function reservedForItemOnLot(
  tx: PrismaTx,
  orderItemId: string,
  finishedGoodsLotId: string
): Promise<number> {
  const agg = await tx.stockAllocation.aggregate({
    where: { orderItemId, finishedGoodsLotId, status: "RESERVED" },
    _sum: { quantityKg: true },
  });
  return roundKg(agg._sum.quantityKg ?? 0);
}

/**
 * Turn a promise into a shipment: drop `quantityKg` off both balances of one lot and mark
 * the matching allocation rows consumed.
 *
 * The allocation rows are CLAIMED FIRST, by flipping them out of RESERVED with a guarded
 * `updateMany`. Only kilograms this call actually won that way are shipped against the
 * item's own promise; anything left over has to come out of the lot's free stock under
 * the same conditional UPDATE the reservation path uses. Checking the lot's aggregate
 * `reservedQty` instead would pass while a concurrent release moved this item's rows out
 * from under it — and would then ship somebody else's reserved coffee.
 *
 * If the item holds no reservation on this lot — the common case for a straight
 * pick-from-shelf with no preparation review in between — the whole quantity comes from
 * free stock. That is what lets a fresh order draw on the shelf without first roasting a
 * batch of its own, while still refusing to ship kilograms promised elsewhere.
 *
 * Returns null when the lot cannot cover the request, so the caller can 409.
 */
export async function consumeShelfStock(
  tx: PrismaTx,
  item: AllocatableItem,
  lotId: string,
  quantityKg: number,
  userId: string | null
): Promise<{ previousQuantity: number; newQuantity: number } | null> {
  const qty = roundKg(quantityKg);
  if (qty <= 0) return null;

  const held = await tx.stockAllocation.findMany({
    where: { orderItemId: item.id, finishedGoodsLotId: lotId, status: "RESERVED" },
    select: { id: true, quantityKg: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // Claim rows one at a time until the shipment is covered. `claimedKg` counts only rows
  // this transaction actually won.
  let claimedKg = 0;
  const consumedIds: string[] = [];
  for (const a of held) {
    if (claimedKg >= qty - 0.0005) break;

    const stillNeeded = roundKg(qty - claimedKg);
    if (a.quantityKg > stillNeeded + 0.0005) {
      // This row straddles the shipment: shrink it and record the shipped part separately.
      const shrunk = await tx.stockAllocation.updateMany({
        where: { id: a.id, status: "RESERVED", quantityKg: a.quantityKg },
        data: { quantityKg: roundKg(a.quantityKg - stillNeeded) },
      });
      if (shrunk.count === 0) continue;
      await tx.stockAllocation.create({
        data: {
          orderItemId: item.id,
          finishedGoodsLotId: lotId,
          quantityKg: stillNeeded,
          status: "CONSUMED",
          createdById: userId,
        },
      });
      claimedKg = roundKg(claimedKg + stillNeeded);
      break;
    }

    const claimed = await tx.stockAllocation.updateMany({
      where: { id: a.id, status: "RESERVED" },
      data: { status: "CONSUMED" },
    });
    if (claimed.count === 0) continue;
    consumedIds.push(a.id);
    claimedKg = roundKg(claimedKg + a.quantityKg);
  }

  // Whatever the promise did not cover has to be taken from free stock right now.
  const fromFree = roundKg(qty - claimedKg);
  if (fromFree > 0.0005) {
    const topUp = await tx.$executeRaw`
      UPDATE "FinishedGoodsLot"
         SET "reservedQty" = "reservedQty" + ${fromFree}
       WHERE "id" = ${lotId}
         AND "status" = 'AVAILABLE'
         AND ("availableQty" - "reservedQty" + 0.0005) >= ${fromFree}
    `;
    if (topUp !== 1) return null; // not enough free stock — caller returns 409
    await tx.stockAllocation.create({
      data: {
        orderItemId: item.id,
        finishedGoodsLotId: lotId,
        quantityKg: fromFree,
        status: "CONSUMED",
        createdById: userId,
      },
    });
  }

  // Ship it. Both balances fall together, so a delivery of already-reserved stock leaves
  // free-to-promise untouched.
  const shipped = await tx.$executeRaw`
    UPDATE "FinishedGoodsLot"
       SET "availableQty" = "availableQty" - ${qty},
           "reservedQty"  = "reservedQty"  - ${qty}
     WHERE "id" = ${lotId}
       AND "availableQty" >= ${qty}
       AND "reservedQty"  >= ${qty}
  `;
  if (shipped !== 1) return null;

  const after = await tx.finishedGoodsLot.findUnique({
    where: { id: lotId },
    select: { availableQty: true },
  });
  const newQuantity = after!.availableQty;

  return { previousQuantity: roundKg(newQuantity + qty), newQuantity };
}

/**
 * The decision that the numbers actually support. Preparation review no longer takes this
 * from the client — it is a function of outstanding demand and what was reserved.
 */
export function decisionFor(outstandingKg: number, reservedKg: number): string {
  if (outstandingKg <= 0 && reservedKg <= 0) return "Available on Shelf";
  if (reservedKg <= 0) return "Needs Production";
  if (outstandingKg <= 0) return "Available on Shelf";
  return "Partially Available";
}
