import { Prisma } from "@/generated/prisma/client";

type PrismaTx = Prisma.TransactionClient;

/**
 * Advances a ProductionOrder to IN_PRODUCTION once real roasting exists behind it.
 *
 * Rules:
 *   - CANCELLED / COMPLETED orders are never re-evaluated (terminal states).
 *   - Rejected batches and blends are excluded from the output sum.
 *   - totalRoasted > 0 and still PENDING → IN_PRODUCTION.
 *
 * Closure is deliberately NOT automatic. This used to complete an order the moment
 * roasted weight reached the target, and that turned out to be wrong in three ways once
 * production orders became operational records rather than one-way planning rows:
 *
 *   1. Roasted weight is not finished goods. An order could close with its full target
 *      roasted and zero units packed — reporting completed work that nobody could ship.
 *   2. Because COMPLETED is terminal, auto-closing locked the order the instant the
 *      threshold was crossed, so the second and third roaster loads of a three-load
 *      requirement could no longer be linked to it.
 *   3. It removed the operator's closing decision entirely, which is the step the
 *      workflow calls "Production Order Closure" and the point at which a human confirms
 *      the plan and the reality agree.
 *
 * An order therefore stays IN_PRODUCTION until somebody closes it through
 * POST /api/production-orders/[id]/status. Closing short is allowed and safe: whatever
 * the order did not produce reappears as outstanding demand on the line it came from.
 *
 * Call this inside a transaction from any route that creates, links or finalises a
 * RoastingBatch.
 */
export async function recalcProductionOrderStatus(
  productionOrderId: string,
  tx: PrismaTx,
): Promise<void> {
  const order = await tx.productionOrder.findUnique({
    where: { id: productionOrderId },
    select: { targetWeightKg: true, status: true },
  });

  // Both CANCELLED and COMPLETED are terminal and must never be auto-reopened.
  //
  // CANCELLED has always been: it is an intentional administrative act. COMPLETED joins
  // it now that production orders are operational records rather than one-way planning
  // rows. A closed order that silently reopened — because a batch was later QC-rejected,
  // say — would contradict the state machine the API enforces (COMPLETED is refused as a
  // source for every action), and would let a record an operator had signed off drift
  // back into the open work list without anybody acting on it. Where production really
  // does fall short after closure, the outstanding-demand calculation notices the gap and
  // offers a fresh production order for the remainder, which is the auditable route.
  if (!order || order.status === "CANCELLED" || order.status === "COMPLETED") return;

  const agg = await tx.roastingBatch.aggregate({
    where: {
      productionOrderId,
      isBlend: false,
      status: { not: "Rejected" },
    },
    _sum: { roastedBeanQuantity: true },
  });

  const totalRoasted = agg._sum.roastedBeanQuantity ?? 0;

  // Only the open pair is derived, and it moves both ways: unlinking the last batch drops
  // an order back to PENDING, which is honest — nothing is being produced for it again.
  const nextStatus: "PENDING" | "IN_PRODUCTION" = totalRoasted > 0 ? "IN_PRODUCTION" : "PENDING";

  // Skip the write when nothing changes.
  if (nextStatus === order.status) return;

  await tx.productionOrder.update({
    where: { id: productionOrderId },
    data: { status: nextStatus },
  });
}

// ─── Production order state machine ─────────────────────────────────────────
//
// The enum already carried the four states this workflow needs, but nothing enforced
// movement between them: status was only ever written by recalc, derived from roasted
// weight. These are the operator-driven transitions, and they are enforced on the server
// because the buttons that trigger them are trivially bypassable.
//
//   PENDING ──release──> IN_PRODUCTION ──complete──> COMPLETED
//      │                       │
//      └────────cancel─────────┴────────────────────> CANCELLED
//
// COMPLETED and CANCELLED are terminal: no action leaves them, which is what makes
// "COMPLETED -> IN_PRODUCTION" and "CANCELLED -> IN_PRODUCTION" impossible rather than
// merely discouraged.

export type ProductionOrderStatusValue = "PENDING" | "IN_PRODUCTION" | "COMPLETED" | "CANCELLED";

export const PRODUCTION_ORDER_ACTIONS = ["release", "complete", "cancel"] as const;
export type ProductionOrderAction = (typeof PRODUCTION_ORDER_ACTIONS)[number];

export const TERMINAL_PRODUCTION_STATUSES: ReadonlySet<ProductionOrderStatusValue> = new Set([
  "COMPLETED",
  "CANCELLED",
]);

export const PRODUCTION_TRANSITIONS: Record<
  ProductionOrderAction,
  { from: ProductionOrderStatusValue[]; to: ProductionOrderStatusValue }
> = {
  // "Release to production" is the operator saying the plan is real work now. It is
  // allowed only from PENDING; recalc also performs it automatically the moment actual
  // roasting appears, so an order can reach IN_PRODUCTION either way.
  release: { from: ["PENDING"], to: "IN_PRODUCTION" },
  // Closing an order is allowed from PENDING as well as IN_PRODUCTION, because recalc
  // only advances the status once a linked batch exists — an order whose work was
  // recorded some other way can still be closed. The caller additionally requires real
  // production to exist; see assertClosable below.
  complete: { from: ["PENDING", "IN_PRODUCTION"], to: "COMPLETED" },
  cancel: { from: ["PENDING", "IN_PRODUCTION"], to: "CANCELLED" },
};

export function isProductionOrderAction(value: unknown): value is ProductionOrderAction {
  return typeof value === "string" && (PRODUCTION_ORDER_ACTIONS as readonly string[]).includes(value);
}

export function isProductionTransitionAllowed(
  from: ProductionOrderStatusValue,
  action: ProductionOrderAction,
): boolean {
  return PRODUCTION_TRANSITIONS[action].from.includes(from);
}

/**
 * Stable 32-bit key for the two-integer form of pg_advisory_xact_lock.
 *
 * Postgres offers hashtext() for this, but it is an undocumented internal, so the hash is
 * computed here instead where its behaviour is visible and testable. Collisions are
 * harmless: two unrelated ids sharing a key serialise against each other unnecessarily,
 * which costs a little concurrency and never correctness.
 */
export function advisoryKey(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  return h;
}

// ─── Progress ───────────────────────────────────────────────────────────────

export type ProductionProgress = {
  batchCount: number;
  /** Green coffee actually drawn by the linked batches. */
  greenConsumedKg: number;
  /** Roasted coffee actually produced by the linked batches. */
  roastedOutputKg: number;
  /** Finished units actually packed out of those batches, for this order's own SKU. */
  producedUnits: number;
  remainingUnits: number;
  remainingKg: number;
};

const EMPTY_PROGRESS: Omit<ProductionProgress, "remainingUnits" | "remainingKg"> = {
  batchCount: 0,
  greenConsumedKg: 0,
  roastedOutputKg: 0,
  producedUnits: 0,
};

const round3 = (n: number) => +n.toFixed(3);

/**
 * Actual production behind a set of production orders, in one pair of queries.
 *
 * Deliberately batched rather than per-order: this feeds the production-orders list, and
 * this deployment pays roughly 167 ms per database round trip, so a per-row lookup would
 * make the screen unusable well before it held interesting numbers.
 *
 * Double counting is structurally impossible here and worth saying why. A RoastingBatch
 * carries a single productionOrderId, so a batch contributes to at most one order. A
 * FinishedGoodsLot carries a single packedFromBatchId, so a packed lot contributes to at
 * most one batch. The unit sum is additionally filtered to the production order's own
 * SKU, so packing a batch into two different SKUs credits only the one that was ordered.
 */
export async function productionProgressMany(
  tx: PrismaTx,
  orders: { id: string; targetUnits: number; targetWeightKg: number }[],
): Promise<Map<string, ProductionProgress>> {
  const result = new Map<string, ProductionProgress>();
  if (orders.length === 0) return result;

  const ids = orders.map((o) => o.id);

  // Same filter as recalcProductionOrderStatus: rejected batches never count, and blends
  // are excluded because a blend's output is already represented by its input batches.
  const batchAgg = await tx.roastingBatch.groupBy({
    by: ["productionOrderId"],
    where: { productionOrderId: { in: ids }, isBlend: false, status: { not: "Rejected" } },
    _sum: { greenBeanQuantity: true, roastedBeanQuantity: true },
    _count: { _all: true },
  });

  const unitRows = await tx.$queryRaw<{ poid: string; units: number }[]>`
    SELECT rb."productionOrderId" AS poid,
           COALESCE(SUM(f."unitsProduced"), 0)::int AS units
      FROM "FinishedGoodsLot" f
      JOIN "RoastingBatch"    rb ON rb.id = f."packedFromBatchId"
      JOIN "ProductionOrder"  po ON po.id = rb."productionOrderId"
     WHERE rb."productionOrderId" IN (${Prisma.join(ids)})
       AND rb."isBlend" = false
       AND rb.status <> 'Rejected'
       AND f."productSkuId" = po."productSkuId"
       AND f."isUnitTracked" = true
     GROUP BY rb."productionOrderId"`;

  const byBatch = new Map(batchAgg.map((r) => [r.productionOrderId as string, r]));
  const byUnits = new Map(unitRows.map((r) => [r.poid, Number(r.units)]));

  for (const o of orders) {
    const b = byBatch.get(o.id);
    const producedUnits = byUnits.get(o.id) ?? 0;
    const roastedOutputKg = round3(b?._sum.roastedBeanQuantity ?? EMPTY_PROGRESS.roastedOutputKg);
    result.set(o.id, {
      batchCount: b?._count._all ?? 0,
      greenConsumedKg: round3(b?._sum.greenBeanQuantity ?? 0),
      roastedOutputKg,
      producedUnits,
      remainingUnits: Math.max(0, o.targetUnits - producedUnits),
      remainingKg: round3(Math.max(0, o.targetWeightKg - roastedOutputKg)),
    });
  }
  return result;
}

export async function productionProgress(
  tx: PrismaTx,
  order: { id: string; targetUnits: number; targetWeightKg: number },
): Promise<ProductionProgress> {
  const m = await productionProgressMany(tx, [order]);
  return m.get(order.id)!;
}

/**
 * Guard for attaching a batch to a production order at creation time.
 *
 * The link route performs the same checks against an existing batch. This exists because
 * POST /api/roasting-batches accepts a productionOrderId directly, and without it a roast
 * of the wrong coffee — or a roast against an order somebody closed an hour ago — would
 * be credited to that order's progress with nothing to stop it.
 *
 * Throws the route-level `{ _appCode, message }` shape both callers already understand.
 */
export async function assertProductionOrderAcceptsRoast(
  tx: PrismaTx,
  productionOrderId: string,
  batchProductId: string | null,
): Promise<void> {
  const order = await tx.productionOrder.findUnique({
    where: { id: productionOrderId },
    select: {
      productionNumber: true,
      status: true,
      productSku: { select: { skuCode: true, productId: true } },
    },
  });
  if (!order) throw { _appCode: 404, message: "Production order not found." };

  if (TERMINAL_PRODUCTION_STATUSES.has(order.status as ProductionOrderStatusValue)) {
    throw {
      _appCode: 409,
      message: `Production order ${order.productionNumber} is ${order.status} and cannot take further roasting.`,
    };
  }
  if (batchProductId === null) {
    throw {
      _appCode: 409,
      message: `This batch does not identify which coffee it is, so it cannot be attached to ${order.productionNumber}.`,
    };
  }
  if (batchProductId !== order.productSku.productId) {
    throw {
      _appCode: 409,
      message: `This batch is a different coffee from ${order.productSku.skuCode} on ${order.productionNumber}.`,
    };
  }
}

// ─── Outstanding demand ─────────────────────────────────────────────────────

export type OutstandingDemand = {
  orderedUnits: number;
  deliveredUnits: number;
  reservedUnits: number;
  /** Units already committed to open production that have not yet been packed. */
  scheduledUnits: number;
  /** What may still legitimately be scheduled. */
  outstandingUnits: number;
};

/**
 * How many units of an order line still need to be produced.
 *
 * The old rule was "does an open production order exist for this line?" and answered 409
 * forever once one did — so a line whose quantity later grew could never have the
 * increase scheduled, and the only remedy was editing the database.
 *
 * This is the demand equation instead:
 *
 *   outstanding = ordered − delivered − reserved − scheduled
 *
 * `scheduled` is the part of existing production orders that has not yet turned into
 * finished goods: for every non-cancelled order, target minus what was actually packed
 * from it. Subtracting the whole target instead would double-count, because packed units
 * are already counted by `reserved` once the preparation review claims them — and the
 * order line would be under-scheduled by exactly the amount already produced.
 *
 * Cancelled production orders contribute nothing, which is what allows a cancellation to
 * free the demand for rescheduling. Completed ones still contribute their unpacked
 * remainder, so coffee that is roasted but not yet packed is never ordered twice.
 */
export async function outstandingDemandForItem(
  tx: PrismaTx,
  item: { id: string; quantityUnits: number; deliveredUnits: number },
): Promise<OutstandingDemand> {
  const reserved = await tx.stockAllocation.aggregate({
    where: { orderItemId: item.id, status: "RESERVED", quantityUnits: { not: null } },
    _sum: { quantityUnits: true },
  });
  const reservedUnits = reserved._sum.quantityUnits ?? 0;

  const openOrders = await tx.productionOrder.findMany({
    where: { sourceOrderItemId: item.id, status: { not: "CANCELLED" } },
    select: { id: true, targetUnits: true, targetWeightKg: true },
  });

  const progress = await productionProgressMany(tx, openOrders);
  const scheduledUnits = openOrders.reduce(
    (sum, po) => sum + Math.max(0, po.targetUnits - (progress.get(po.id)?.producedUnits ?? 0)),
    0,
  );

  const outstandingUnits = Math.max(
    0,
    item.quantityUnits - item.deliveredUnits - reservedUnits - scheduledUnits,
  );

  return {
    orderedUnits: item.quantityUnits,
    deliveredUnits: item.deliveredUnits,
    reservedUnits,
    scheduledUnits,
    outstandingUnits,
  };
}

/**
 * Creates a ProductionOrder from a sales OrderItem that has a linked ProductSKU.
 * Call this inside a prisma.$transaction — never standalone.
 *
 * @param overrideTargetWeightKg  When provided, uses this quantity instead of
 *   the full OrderItem.quantityKg. Enables splitting a large order across
 *   multiple production runs (e.g., four 25 kg orders from a 100 kg line).
 *
 * Green bean draw formula:
 *   expectedGreenBeanKg = targetWeightKg / (1 - lossFraction)
 *   where lossFraction = CoffeeProduct.expectedRoastLoss / 100
 *
 * Loss is clamped to (0.1 %, 99.9 %) to guard against division-by-zero and
 * nonsensical 0 % entries from data-entry mistakes.
 */
export async function createProductionOrderFromSales(
  orderItemId: string,
  tx: PrismaTx,
  overrideTargetWeightKg?: number,
): Promise<Prisma.ProductionOrderGetPayload<object>> {
  const orderItem = await tx.orderItem.findUniqueOrThrow({
    where: { id: orderItemId },
    select: { productSkuId: true, quantityKg: true },
  });

  if (!orderItem.productSkuId) {
    throw new Error(
      `OrderItem ${orderItemId} has no ProductSKU linked. ` +
        `Assign a SKU before creating a production order.`,
    );
  }

  // Single query: SKU + parent product's BOM fields.
  const sku = await tx.productSKU.findUniqueOrThrow({
    where: { id: orderItem.productSkuId },
    select: {
      weightGrams: true,
      isBulk: true,
      product: {
        select: {
          expectedRoastLoss: true,
          defaultGreenBeanId: true,
        },
      },
    },
  });

  // Override allows splitting: caller passes a slice of the total order qty.
  const targetWeightKg = overrideTargetWeightKg ?? orderItem.quantityKg;

  if (overrideTargetWeightKg !== undefined && overrideTargetWeightKg <= 0) {
    throw new Error(`overrideTargetWeightKg must be positive, got ${overrideTargetWeightKg}.`);
  }

  // Bulk SKUs (e.g., wholesale 20 kg tubs) are a single unit regardless of weight.
  const targetUnits = sku.isBulk
    ? 1
    : Math.ceil((targetWeightKg * 1000) / sku.weightGrams);

  // Clamp loss to a physically meaningful range before dividing.
  const lossPct = Math.min(Math.max(sku.product.expectedRoastLoss, 0.1), 99.9);
  const lossFraction = lossPct / 100;
  // Round to 3 dp to avoid floating-point drift across many production orders.
  const expectedGreenBeanKg = +(targetWeightKg / (1 - lossFraction)).toFixed(3);

  // Sequential production number, derived from the highest number already issued this
  // year rather than from a row count.
  //
  // count() + 1 reissues a number the moment the table has a gap, and productionNumber is
  // UNIQUE. Worse, the count never moves past the collision: with rows 0002-0006 present,
  // count() + 1 proposes 0006 on every single call, so the FIRST deleted production order
  // stops production scheduling permanently — every later attempt fails with "a record
  // with these details already exists" and no amount of retrying helps. Observed exactly
  // that way on a database holding PRD-2026-0002 through PRD-2026-0006.
  //
  // The advisory lock serializes the read-then-insert against concurrent callers; it is
  // held to the end of this transaction and needs no explicit unlock. Without it two
  // simultaneous requests read the same maximum and one dies on the unique constraint —
  // safe, but it surfaces to the operator as a duplicate error on a perfectly valid order.
  const year = new Date().getFullYear();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7761, ${year}::int)`;

  // The regex guard means a malformed row can never reach the cast, and MAX ignores gaps.
  const [{ max: lastSeq }] = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("productionNumber" FROM 10) AS INTEGER)) AS max
      FROM "ProductionOrder"
     WHERE "productionNumber" ~ ${`^PRD-${year}-[0-9]+$`}`;

  const productionNumber = `PRD-${year}-${String((lastSeq ?? 0) + 1).padStart(4, "0")}`;

  return tx.productionOrder.create({
    data: {
      productionNumber,
      productSkuId: orderItem.productSkuId,
      targetUnits,
      targetWeightKg,
      expectedGreenBeanKg,
      status: "PENDING",
      sourceOrderItemId: orderItemId,
      greenBeanId: sku.product.defaultGreenBeanId ?? null,
    },
  });
}
