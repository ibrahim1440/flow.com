import { Prisma } from "@/generated/prisma/client";

type PrismaTx = Prisma.TransactionClient;

// ─── Units and pack sizes ────────────────────────────────────────────────────
//
// Units are the source of truth for finished goods. Kilograms are always DERIVED from
// units via the SKU's net weight — never stored as an independent total, never read back
// as an authority. `quantityKg` still exists on OrderItem, StockAllocation and Delivery
// because delivery, production and the inventory ledger all read it; it is a projection
// of `quantityUnits`, which is why every kg value here comes out of `kgForUnits`.

/** Repo-wide kg precision: gram-level, 3 decimals (see order-operations.ts). */
export const roundKg = (v: number): number => Number(v.toFixed(3));

/** Net weight of one sellable unit, in kilograms. */
export function skuKg(sku: { weightGrams: number }): number {
  return roundKg(sku.weightGrams / 1000);
}

/** Kilogram equivalent of a whole number of units. The only way kg is produced. */
export function kgForUnits(sku: { weightGrams: number }, units: number): number {
  return roundKg(skuKg(sku) * units);
}

/**
 * Units needed to cover a kilogram shortfall, rounded UP.
 *
 * Production makes whole bags: 2.3 kg of demand against a 1 KG SKU is three bags, not
 * two and a fraction. Rounding down would schedule a production run that still leaves the
 * order short.
 */
export function unitsForKg(sku: { weightGrams: number }, kg: number): number {
  const per = skuKg(sku);
  if (per <= 0) return 0;
  // Subtract half a gram before ceiling so float noise on an exact multiple
  // (3 x 0.25 summing to 0.7500000000000001) does not add a phantom extra unit.
  return Math.max(0, Math.ceil((kg - 0.0005) / per));
}

/** "1 KG", "250 g" — how a pack size is written throughout the UI. */
export function packSizeLabel(weightGrams: number): string {
  return weightGrams >= 1000
    ? `${Number((weightGrams / 1000).toFixed(3))} KG`
    : `${Number(weightGrams.toFixed(0))} g`;
}

export type SkuNameSource = {
  name: string | null;
  weightGrams: number;
  product: { productNameEn: string; productNameAr?: string | null };
};

/**
 * Display name for a SKU. `name` is explicit catalog data; the fallback exists because
 * the six SKUs that predate the Finished Products catalog have none, and inventing a
 * migration to backfill guessed names would have been worse than deriving them.
 */
export function skuDisplayName(sku: SkuNameSource): string {
  if (sku.name && sku.name.trim()) return sku.name.trim();
  return `${sku.product.productNameEn} – ${packSizeLabel(sku.weightGrams)}`;
}

// ─── Finished goods availability, by SKU ─────────────────────────────────────

export type SkuAvailability = {
  unitsAvailable: number;
  unitsReserved: number;
  unitsFree: number;
};

const EMPTY_AVAILABILITY: SkuAvailability = { unitsAvailable: 0, unitsReserved: 0, unitsFree: 0 };

/**
 * Free-to-promise finished stock per SKU, in whole units.
 *
 * Only unit-tracked lots are counted. The legacy kilogram lots are deliberately excluded:
 * their balances are not whole units of any SKU (8.45 kg against a 1 KG SKU), they back
 * the legacy bean-based order lines, and mixing the two pools would let a units order and
 * a kilogram order each spend the same coffee.
 */
export async function availableUnitsBySku(
  tx: PrismaTx,
  skuIds: string[]
): Promise<Map<string, SkuAvailability>> {
  const out = new Map<string, SkuAvailability>();
  if (skuIds.length === 0) return out;

  const grouped = await tx.finishedGoodsLot.groupBy({
    by: ["productSkuId"],
    where: {
      productSkuId: { in: skuIds },
      isUnitTracked: true,
      status: "AVAILABLE",
    },
    _sum: { unitsAvailable: true, unitsReserved: true },
  });

  for (const row of grouped) {
    if (!row.productSkuId) continue;
    const available = row._sum.unitsAvailable ?? 0;
    const reserved = row._sum.unitsReserved ?? 0;
    out.set(row.productSkuId, {
      unitsAvailable: available,
      unitsReserved: reserved,
      unitsFree: Math.max(0, available - reserved),
    });
  }

  for (const id of skuIds) if (!out.has(id)) out.set(id, { ...EMPTY_AVAILABILITY });
  return out;
}

// ─── Reserving finished goods, in units ──────────────────────────────────────

export type UnitReservationResult = {
  reservedUnits: number;
  lots: { lotId: string; batchNumber: string; units: number }[];
};

export type UnitAllocatableItem = {
  id: string;
  productSkuId: string;
  productSku: { weightGrams: number };
};

/**
 * Reserve up to `wantedUnits` of this item's SKU, drawing FIFO across unit-tracked lots.
 *
 * Same atomicity contract as the kilogram path in shelf-allocation.ts: one conditional
 * UPDATE per lot whose WHERE clause re-checks free stock, so under READ COMMITTED a
 * concurrent reserver blocks, re-evaluates against the committed row, and cannot take the
 * same units twice. Prisma's updateMany cannot express a column-to-column comparison,
 * hence $executeRaw.
 *
 * Unlike the kilogram path this needs no floating-point slack: unit balances are integers,
 * so `(unitsAvailable - unitsReserved) >= take` is exact.
 *
 * Reserves what it can and reports the rest through the return value — partial cover is a
 * normal outcome, and the uncovered remainder is what becomes a production requirement.
 */
export async function reserveFinishedUnits(
  tx: PrismaTx,
  item: UnitAllocatableItem,
  wantedUnits: number,
  userId: string | null
): Promise<UnitReservationResult> {
  const want = Math.max(0, Math.trunc(wantedUnits));
  if (want <= 0) return { reservedUnits: 0, lots: [] };

  const lots = await tx.finishedGoodsLot.findMany({
    where: {
      productSkuId: item.productSkuId,
      isUnitTracked: true,
      status: "AVAILABLE",
    },
    select: { id: true, batchNumber: true, unitsAvailable: true, unitsReserved: true },
    // FIFO — roasted coffee degrades, so the oldest free lot leaves the shelf next.
    // The id tiebreak keeps concurrent transactions locking lots in the same order,
    // which is what stops them deadlocking against each other.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const taken: UnitReservationResult["lots"] = [];
  const rows: Prisma.StockAllocationCreateManyInput[] = [];
  let remaining = want;

  for (const lot of lots) {
    if (remaining <= 0) break;
    const free = Math.max(0, lot.unitsAvailable - lot.unitsReserved);
    const take = Math.min(remaining, free);
    if (take <= 0) continue;

    const affected = await tx.$executeRaw`
      UPDATE "FinishedGoodsLot"
         SET "unitsReserved" = "unitsReserved" + ${take}
       WHERE "id" = ${lot.id}
         AND "status" = 'AVAILABLE'
         AND "isUnitTracked" = true
         AND ("unitsAvailable" - "unitsReserved") >= ${take}
    `;
    // 0 rows means another transaction took these units between the read and the write.
    // Move on to the next lot rather than failing the whole reservation.
    if (affected !== 1) continue;

    // The conditional UPDATE above is the atomic claim and must stay per-lot. The
    // allocation row is only the detail behind it, so the inserts are collected and
    // written once after the loop: on a remote database each round-trip costs ~167 ms,
    // and a reservation spanning ten lots was spending ten of them on inserts alone.
    // Correctness is unaffected — this all runs inside one transaction, so unitsReserved
    // and the RESERVED rows still become visible together, or not at all.
    rows.push({
      orderItemId: item.id,
      finishedGoodsLotId: lot.id,
      quantityUnits: take,
      // Derived, never independent — see the note at the top of this file.
      quantityKg: kgForUnits(item.productSku, take),
      status: "RESERVED",
      createdById: userId,
    });

    taken.push({ lotId: lot.id, batchNumber: lot.batchNumber, units: take });
    remaining -= take;
  }

  if (rows.length > 0) await tx.stockAllocation.createMany({ data: rows });

  return { reservedUnits: want - remaining, lots: taken };
}

/**
 * Hand back every unit this order item is holding.
 *
 * The status flip comes FIRST and is itself the lock, exactly as in the kilogram path:
 * `updateMany` on rows still marked RESERVED reports how many it actually changed, so a
 * concurrent releaser that got there first changes nothing and decrements nothing.
 * Reading the rows and then subtracting would let two callers both give back the same
 * units, and a GREATEST(0, …) floor would silently swallow the second subtraction.
 */
export async function releaseFinishedUnits(tx: PrismaTx, orderItemId: string): Promise<number> {
  // One statement, and the claim is unchanged.
  //
  // This used to read the allocations and then walk them, costing two round trips per row
  // — a re-review of an order spread over ten lots spent twenty-one round trips here
  // alone, and against a database on the public internet that is most of a second and a
  // half before any work is done.
  //
  // The guarantee is identical because it comes from the same place. `UPDATE … WHERE
  // status = 'RESERVED' … RETURNING` locks and flips exactly the rows that were still
  // reserved when it ran, and returns only those; a concurrent releaser that got there
  // first finds nothing left to flip and so decrements nothing. Grouping those returned
  // rows by lot and subtracting once per lot gives each lot precisely the units this
  // caller actually claimed — the same arithmetic the loop performed, in one trip.
  //
  // Both data-modifying CTEs run to completion whether or not the outer query reads them,
  // which is what makes the lot decrement safe to express this way.
  const rows = await tx.$queryRaw<{ released: number }[]>`
    WITH claimed AS (
      UPDATE "StockAllocation"
         SET "status" = 'RELEASED'
       WHERE "orderItemId" = ${orderItemId}
         AND "status" = 'RESERVED'
         AND "quantityUnits" IS NOT NULL
       RETURNING "finishedGoodsLotId" AS lot, COALESCE("quantityUnits", 0) AS units
    ),
    per_lot AS (
      SELECT lot, SUM(units)::int AS units FROM claimed GROUP BY lot
    ),
    touched AS (
      UPDATE "FinishedGoodsLot" f
         SET "unitsReserved" = GREATEST(0, f."unitsReserved" - p.units)
        FROM per_lot p
       WHERE f."id" = p.lot
      RETURNING 1
    )
    SELECT COALESCE((SELECT SUM(units) FROM claimed), 0)::int AS released
  `;
  return Number(rows[0]?.released ?? 0);
}

/**
 * Ship whole units off a unit-tracked lot for this order item.
 *
 * Mirrors consumeShelfStock in shelf-allocation.ts, which does the same job in kilograms,
 * and keeps its contract: returns null when the lot cannot cover the shipment so the
 * caller can answer 409, and reports before/after so the ledger row can be written.
 *
 * The item's OWN reservation is spent first and only the remainder is taken from free
 * stock — a delivery must never ship units promised to a different order. Because both
 * unitsAvailable and unitsReserved fall together for the reserved part, shipping stock
 * this item already held leaves free-to-promise untouched.
 *
 * Integers throughout, so unlike the kilogram path there is no floating-point slack.
 */
export async function consumeFinishedUnits(
  tx: PrismaTx,
  item: { id: string },
  lotId: string,
  units: number,
  userId: string | null
): Promise<{ previousUnits: number; newUnits: number } | null> {
  const want = Math.trunc(units);
  if (want <= 0) return null;

  const held = await tx.stockAllocation.findMany({
    where: { orderItemId: item.id, finishedGoodsLotId: lotId, status: "RESERVED", quantityUnits: { not: null } },
    select: { id: true, quantityUnits: true, quantityKg: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // Claim reservation rows one at a time; `claimed` counts only what this transaction won.
  let claimed = 0;
  for (const a of held) {
    if (claimed >= want) break;
    const rowUnits = a.quantityUnits ?? 0;
    if (rowUnits <= 0) continue;

    const stillNeeded = want - claimed;

    if (rowUnits > stillNeeded) {
      // This row straddles the shipment: shrink it and book the shipped part separately,
      // so the untouched remainder stays reserved to this item.
      const perUnitKg = rowUnits > 0 ? a.quantityKg / rowUnits : 0;
      const shrunk = await tx.stockAllocation.updateMany({
        where: { id: a.id, status: "RESERVED", quantityUnits: rowUnits },
        data: {
          quantityUnits: rowUnits - stillNeeded,
          quantityKg: roundKg(perUnitKg * (rowUnits - stillNeeded)),
        },
      });
      if (shrunk.count === 0) continue;
      await tx.stockAllocation.create({
        data: {
          orderItemId: item.id,
          finishedGoodsLotId: lotId,
          quantityUnits: stillNeeded,
          quantityKg: roundKg(perUnitKg * stillNeeded),
          status: "CONSUMED",
          createdById: userId,
        },
      });
      claimed += stillNeeded;
      break;
    }

    const won = await tx.stockAllocation.updateMany({
      where: { id: a.id, status: "RESERVED" },
      data: { status: "CONSUMED" },
    });
    if (won.count === 0) continue;
    claimed += rowUnits;
  }

  // Anything the promise did not cover must come out of free stock now.
  const fromFree = want - claimed;
  if (fromFree > 0) {
    const lot = await tx.finishedGoodsLot.findUnique({
      where: { id: lotId },
      select: { productSku: { select: { weightGrams: true } } },
    });
    const topUp = await tx.$executeRaw`
      UPDATE "FinishedGoodsLot"
         SET "unitsReserved" = "unitsReserved" + ${fromFree}
       WHERE "id" = ${lotId}
         AND "status" = 'AVAILABLE'
         AND "isUnitTracked" = true
         AND ("unitsAvailable" - "unitsReserved") >= ${fromFree}
    `;
    if (topUp !== 1) return null; // not enough free stock — caller answers 409
    await tx.stockAllocation.create({
      data: {
        orderItemId: item.id,
        finishedGoodsLotId: lotId,
        quantityUnits: fromFree,
        quantityKg: lot?.productSku ? kgForUnits(lot.productSku, fromFree) : 0.001,
        status: "CONSUMED",
        createdById: userId,
      },
    });
  }

  const shipped = await tx.$executeRaw`
    UPDATE "FinishedGoodsLot"
       SET "unitsAvailable" = "unitsAvailable" - ${want},
           "unitsReserved"  = "unitsReserved"  - ${want}
     WHERE "id" = ${lotId}
       AND "unitsAvailable" >= ${want}
       AND "unitsReserved"  >= ${want}
  `;
  if (shipped !== 1) return null;

  const after = await tx.finishedGoodsLot.findUniqueOrThrow({
    where: { id: lotId },
    select: { unitsAvailable: true },
  });
  return { previousUnits: after.unitsAvailable + want, newUnits: after.unitsAvailable };
}

/**
 * Give back any unit promise this item no longer needs — it has been delivered, or shrunk.
 *
 * The kilogram path calls trimReservationToDemand after every delivery for the same
 * reason: an item that reserved units across two lots but shipped from one would
 * otherwise leave the other lot's units promised to an order that is already complete,
 * hiding stock that is physically present from every other order.
 */
export async function trimUnitReservationToDemand(
  tx: PrismaTx,
  item: { id: string; quantityUnits: number; deliveredUnits: number }
): Promise<number> {
  const stillWanted = Math.max(0, item.quantityUnits - item.deliveredUnits);

  const rows = await tx.stockAllocation.findMany({
    where: { orderItemId: item.id, status: "RESERVED", quantityUnits: { not: null } },
    select: { id: true, finishedGoodsLotId: true, quantityUnits: true, quantityKg: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const reserved = rows.reduce((s, r) => s + (r.quantityUnits ?? 0), 0);
  let excess = reserved - stillWanted;
  if (excess <= 0) return 0;

  let released = 0;
  for (const r of rows) {
    if (excess <= 0) break;
    const rowUnits = r.quantityUnits ?? 0;
    if (rowUnits <= 0) continue;

    if (rowUnits > excess) {
      const perUnitKg = r.quantityKg / rowUnits;
      const shrunk = await tx.stockAllocation.updateMany({
        where: { id: r.id, status: "RESERVED", quantityUnits: rowUnits },
        data: { quantityUnits: rowUnits - excess, quantityKg: roundKg(perUnitKg * (rowUnits - excess)) },
      });
      if (shrunk.count === 0) continue;
      await tx.$executeRaw`
        UPDATE "FinishedGoodsLot"
           SET "unitsReserved" = GREATEST(0, "unitsReserved" - ${excess})
         WHERE "id" = ${r.finishedGoodsLotId}
      `;
      released += excess;
      excess = 0;
      break;
    }

    const won = await tx.stockAllocation.updateMany({
      where: { id: r.id, status: "RESERVED" },
      data: { status: "RELEASED" },
    });
    if (won.count === 0) continue;
    await tx.$executeRaw`
      UPDATE "FinishedGoodsLot"
         SET "unitsReserved" = GREATEST(0, "unitsReserved" - ${rowUnits})
       WHERE "id" = ${r.finishedGoodsLotId}
    `;
    released += rowUnits;
    excess -= rowUnits;
  }
  return released;
}

// ─── Bill of materials ───────────────────────────────────────────────────────

export type BomRequirement = {
  type: "ROASTED_COFFEE" | "MATERIAL";
  label: string;
  coffeeProductId: string | null;
  materialItemId: string | null;
  unitOfMeasure: string;
  quantityPerUnit: number;
  quantityRequired: number;
  quantityAvailable: number;
  shortfall: number;
};

/**
 * What producing `units` of a SKU consumes, and whether the stock is there.
 *
 * ROASTED_COFFEE lines draw on roasted/intermediate stock — the sum of
 * RoastingBatch.roastedAvailableKg for that coffee — never on green beans. Green coffee
 * is consumed by roasting alone; if roasted stock is short, the answer is to roast, and
 * that is a separate step with its own green-bean check.
 *
 * MATERIAL lines draw on MaterialItem.quantityOnHand.
 */
export async function explodeBom(
  tx: PrismaTx,
  productSkuId: string,
  units: number
): Promise<BomRequirement[]> {
  const wanted = Math.max(0, Math.trunc(units));

  const components = await tx.bomComponent.findMany({
    where: { productSkuId },
    include: {
      coffeeProduct: { select: { id: true, productNameEn: true } },
      materialItem: { select: { id: true, code: true, name: true, quantityOnHand: true } },
    },
    orderBy: [{ type: "asc" }, { createdAt: "asc" }],
  });
  if (components.length === 0) return [];

  // Roasted stock per coffee product, summed across every batch still holding some.
  const coffeeIds = [
    ...new Set(
      components
        .filter((c) => c.type === "ROASTED_COFFEE" && c.coffeeProductId)
        .map((c) => c.coffeeProductId as string)
    ),
  ];
  const roastedByProduct = new Map<string, number>();
  if (coffeeIds.length > 0) {
    const grouped = await tx.roastingBatch.groupBy({
      by: ["productId"],
      where: { productId: { in: coffeeIds }, roastedAvailableKg: { gt: 0 } },
      _sum: { roastedAvailableKg: true },
    });
    for (const g of grouped) {
      if (g.productId) roastedByProduct.set(g.productId, roundKg(g._sum.roastedAvailableKg ?? 0));
    }
  }

  return components.map((c) => {
    const required =
      c.type === "ROASTED_COFFEE"
        ? roundKg(c.quantityPerUnit * wanted)
        : Number((c.quantityPerUnit * wanted).toFixed(3));

    const available =
      c.type === "ROASTED_COFFEE"
        ? roastedByProduct.get(c.coffeeProductId ?? "") ?? 0
        : c.materialItem?.quantityOnHand ?? 0;

    const label =
      c.type === "ROASTED_COFFEE"
        ? `Roasted ${c.coffeeProduct?.productNameEn ?? "coffee"}`
        : `${c.materialItem?.name ?? "Material"} (${c.materialItem?.code ?? "?"})`;

    return {
      type: c.type,
      label,
      coffeeProductId: c.coffeeProductId,
      materialItemId: c.materialItemId,
      unitOfMeasure: c.unitOfMeasure,
      quantityPerUnit: c.quantityPerUnit,
      quantityRequired: required,
      quantityAvailable: available,
      shortfall: Math.max(0, Number((required - available).toFixed(3))),
    };
  });
}

// ─── Fulfilment planning ─────────────────────────────────────────────────────

export type FulfilmentLine = {
  productSkuId: string;
  quantityUnits: number;
};

export type FulfilmentPlanRow = {
  productSkuId: string;
  skuCode: string;
  name: string;
  orderedUnits: number;
  availableUnits: number;
  allocatedUnits: number;
  productionRequiredUnits: number;
};

/**
 * The read-only fulfilment picture for a set of order lines: what was ordered, what the
 * shelf can cover, and what must therefore be produced.
 *
 * Reserves nothing — this is what the order screen shows while the user is still typing.
 * The actual reservation happens later, in a transaction, through reserveFinishedUnits.
 *
 * The free pool is drawn down ACROSS lines, so two lines of the same SKU cannot both be
 * promised the same units. Without that, an order for 5 + 5 of a SKU with 6 free would
 * report both lines fully covered.
 */
export async function planFulfilment(
  tx: PrismaTx,
  lines: FulfilmentLine[]
): Promise<FulfilmentPlanRow[]> {
  if (lines.length === 0) return [];

  const skuIds = [...new Set(lines.map((l) => l.productSkuId))];
  const [skus, availability] = await Promise.all([
    tx.productSKU.findMany({
      where: { id: { in: skuIds } },
      select: {
        id: true,
        skuCode: true,
        name: true,
        weightGrams: true,
        product: { select: { productNameEn: true } },
      },
    }),
    availableUnitsBySku(tx, skuIds),
  ]);
  const skuById = new Map(skus.map((s) => [s.id, s]));

  const freePool = new Map<string, number>();
  for (const id of skuIds) freePool.set(id, availability.get(id)?.unitsFree ?? 0);

  return lines.map((line) => {
    const sku = skuById.get(line.productSkuId);
    const ordered = Math.max(0, Math.trunc(line.quantityUnits));
    const free = freePool.get(line.productSkuId) ?? 0;
    const allocated = Math.min(ordered, free);
    freePool.set(line.productSkuId, free - allocated);

    return {
      productSkuId: line.productSkuId,
      skuCode: sku?.skuCode ?? "",
      name: sku ? skuDisplayName(sku) : "",
      orderedUnits: ordered,
      // What the shelf held for this line before it drew its own allocation, so the row
      // reads as "5 ordered, 3 available, 3 allocated, 2 to produce".
      availableUnits: free,
      allocatedUnits: allocated,
      productionRequiredUnits: ordered - allocated,
    };
  });
}
