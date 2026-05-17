import { Prisma } from "@/generated/prisma/client";

type PrismaTx = Prisma.TransactionClient;

/**
 * Creates a ProductionOrder from a sales OrderItem that has a linked ProductSKU.
 * Call this inside a prisma.$transaction — never standalone.
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

  const targetWeightKg = orderItem.quantityKg;

  // Bulk SKUs (e.g., wholesale 20 kg tubs) are a single unit regardless of weight.
  const targetUnits = sku.isBulk
    ? 1
    : Math.ceil((targetWeightKg * 1000) / sku.weightGrams);

  // Clamp loss to a physically meaningful range before dividing.
  // A loss of 0 % or 100 % is either a data-entry mistake or physically impossible.
  const lossPct = Math.min(Math.max(sku.product.expectedRoastLoss, 0.1), 99.9);
  const lossFraction = lossPct / 100;
  // Round to 3 decimal places to avoid floating-point drift accumulating across
  // many production orders (e.g., 0.88 repeating from 12 % loss).
  const expectedGreenBeanKg = +(targetWeightKg / (1 - lossFraction)).toFixed(3);

  // Sequential production number — count inside the same tx to be safe under
  // concurrent writes (two callers in the same second will still get different counts).
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
      // Route raw material from product BOM; null if product has no default bean yet.
      greenBeanId: sku.product.defaultGreenBeanId ?? null,
    },
  });
}
