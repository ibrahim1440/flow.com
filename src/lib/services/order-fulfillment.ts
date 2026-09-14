import { Prisma } from "@/generated/prisma/client";

type PrismaTx = Prisma.TransactionClient;

const COMPLETION_STATUSES = new Set([
  "Passed",
  "Partially Packaged",
  "Packaged",
  "Blended",
]);

const ACTIVE_STATUSES = new Set([
  "Pending QC",
  "Passed",
  "Partially Packaged",
  "Packaged",
  "Blended",
]);

export async function recalcOrderItemStatus(
  orderItemId: string,
  tx: PrismaTx
): Promise<void> {
  const item = await tx.orderItem.findUniqueOrThrow({
    where: { id: orderItemId },
    select: {
      quantityKg: true,
      deliveredQty: true,
      quantityUnits: true,
      deliveredUnits: true,
      productSkuId: true,
    },
  });

  type BatchRow = { status: string; isBlend: boolean; roastedBeanQuantity: number; greenBeanQuantity: number };

  const batches: BatchRow[] = await tx.roastingBatch.findMany({
    where: { orderItemId },
    select: {
      status: true,
      isBlend: true,
      roastedBeanQuantity: true,
      greenBeanQuantity: true,
    },
  });

  const hasActiveNonBlend = batches.some(
    (b) => ACTIVE_STATUSES.has(b.status) && !b.isBlend
  );

  // Roasted output only. The fallback this replaces used greenBeanQuantity whenever the
  // roasted figure was zero, which put the weight that went INTO the roaster into a total
  // then compared against the finished kilograms the customer ordered. Roasting always
  // loses weight, so that fallback reported more completion than existed — and a batch with
  // no roasted quantity recorded has, by definition, completed nothing.
  const completionTotal = batches
    .filter((b) => COMPLETION_STATUSES.has(b.status) && !b.isBlend)
    .reduce((sum, b) => sum + b.roastedBeanQuantity, 0);

  // ── A SKU line is measured in units, but in PRODUCED units ──────────────────
  // productionStatus means physical production, not fulfilment — the system says so itself.
  // Both the analytics endpoint and the dashboard stats count
  //
  //     { productionStatus: "Completed", deliveryStatus: { not: "Delivered" } }
  //
  // which is a ready-to-ship figure and can only ever return rows if production is allowed
  // to complete BEFORE delivery. The production worklist likewise drops a line once it reads
  // Completed. Judging a unit line by deliveredUnits would empty those dashboards and keep
  // finished lines on the roasting list until they shipped.
  //
  // So the measure is what has been packed for this line, in its own denomination: units on
  // lots produced by this line's own batches. Same filters the production-progress
  // calculation already uses — blends excluded because their output is represented by their
  // inputs, rejected batches excluded because they produced nothing sellable.
  const isUnitLine = item.quantityUnits !== null && item.productSkuId !== null;

  let producedUnits = 0;
  if (isUnitLine) {
    const rows = await tx.$queryRaw<{ units: number }[]>`
      SELECT COALESCE(SUM(f."unitsProduced"), 0)::int AS units
        FROM "FinishedGoodsLot" f
        JOIN "RoastingBatch"    rb ON rb.id = f."packedFromBatchId"
       WHERE rb."orderItemId" = ${orderItemId}
         AND rb."isBlend" = false
         AND rb.status <> 'Rejected'
         AND f."productSkuId" = ${item.productSkuId}
         AND f."isUnitTracked" = true`;
    producedUnits = Number(rows[0]?.units ?? 0);
  }

  const productionStatus = !hasActiveNonBlend
    ? "Pending"
    : isUnitLine
    ? producedUnits >= (item.quantityUnits as number)
      ? "Completed"
      : "In Production"
    : completionTotal >= item.quantityKg
    ? "Completed"
    : "In Production";

  const remainingQty = Math.max(0, completionTotal - item.deliveredQty);

  await tx.orderItem.update({
    where: { id: orderItemId },
    data: { productionStatus, remainingQty },
  });
}
