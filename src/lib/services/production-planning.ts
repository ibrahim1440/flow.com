import { Prisma } from "@/generated/prisma/client";

type PrismaTx = Prisma.TransactionClient;

/**
 * Recalculates and persists the status of a ProductionOrder based on the
 * aggregate roasted output of its child RoastingBatches.
 *
 * Rules:
 *   - CANCELLED / COMPLETED orders are never re-evaluated (terminal states).
 *   - Rejected batches are excluded from the output sum.
 *   - totalRoasted >= targetWeightKg  → COMPLETED
 *   - totalRoasted > 0 and still PENDING → IN_PRODUCTION
 *
 * Call this inside a transaction from any route that creates or finalises a
 * RoastingBatch (POST /api/roasting-batches, QC finalize, package).
 */
export async function recalcProductionOrderStatus(
  productionOrderId: string,
  tx: PrismaTx,
): Promise<void> {
  const order = await tx.productionOrder.findUnique({
    where: { id: productionOrderId },
    select: { targetWeightKg: true, status: true },
  });

  // CANCELLED is the only truly terminal state — a cancelled order is an
  // intentional administrative act and must never be auto-reopened by recalc.
  if (!order || order.status === "CANCELLED") return;

  const agg = await tx.roastingBatch.aggregate({
    where: {
      productionOrderId,
      isBlend: false,
      status: { not: "Rejected" },
    },
    _sum: { roastedBeanQuantity: true },
  });

  const totalRoasted = agg._sum.roastedBeanQuantity ?? 0;

  // Derive target status purely from current roasted weight — no current-status
  // bias so backward transitions (e.g., COMPLETED → IN_PRODUCTION after a late
  // QC rejection or batch deletion) happen automatically.
  let nextStatus: "PENDING" | "IN_PRODUCTION" | "COMPLETED";

  if (totalRoasted >= order.targetWeightKg) {
    nextStatus = "COMPLETED";
  } else if (totalRoasted > 0) {
    nextStatus = "IN_PRODUCTION";
  } else {
    nextStatus = "PENDING";
  }

  // Skip the write when nothing changes.
  if (nextStatus === order.status) return;

  await tx.productionOrder.update({
    where: { id: productionOrderId },
    data: { status: nextStatus },
  });
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

  // Sequential production number — count inside the same tx.
  const existingCount = await tx.productionOrder.count();
  const year = new Date().getFullYear();
  const productionNumber = `PRD-${year}-${String(existingCount + 1).padStart(4, "0")}`;

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
