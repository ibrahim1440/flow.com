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
    select: { quantityKg: true, deliveredQty: true },
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

  const completionTotal = batches
    .filter((b) => COMPLETION_STATUSES.has(b.status) && !b.isBlend)
    .reduce(
      (sum, b) =>
        sum + (b.roastedBeanQuantity > 0 ? b.roastedBeanQuantity : b.greenBeanQuantity),
      0
    );

  const productionStatus = !hasActiveNonBlend
    ? "Pending"
    : completionTotal >= item.quantityKg
    ? "Completed"
    : "In Production";

  const remainingQty = Math.max(0, completionTotal - item.deliveredQty);

  await tx.orderItem.update({
    where: { id: orderItemId },
    data: { productionStatus, remainingQty },
  });
}
