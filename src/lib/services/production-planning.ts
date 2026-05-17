import { Prisma } from "@/generated/prisma/client";

type PrismaTx = Prisma.TransactionClient;

// Standard roasting loss assumption: 15% weight lost during roasting.
// Net roasted weight = green weight × 0.85
const ROASTING_LOSS_FACTOR = 0.85;

/**
 * Creates a ProductionOrder from a sales OrderItem that has a linked ProductSKU.
 *
 * Call this inside a $transaction to ensure atomicity with the triggering action.
 *
 * expectedGreenBeanKg is computed as: targetWeightKg / ROASTING_LOSS_FACTOR
 * so the factory floor knows the gross green bean draw before roasting begins.
 */
export async function createProductionOrderFromSales(
  orderItemId: string,
  tx: PrismaTx,
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

  const sku = await tx.productSKU.findUniqueOrThrow({
    where: { id: orderItem.productSkuId },
    select: { weightGrams: true },
  });

  const targetWeightKg = orderItem.quantityKg;
  const targetUnits = Math.ceil((targetWeightKg * 1000) / sku.weightGrams);
  const expectedGreenBeanKg = +(targetWeightKg / ROASTING_LOSS_FACTOR).toFixed(3);

  // Sequential production number within the same transaction — padded to 4 digits.
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
    },
  });
}
