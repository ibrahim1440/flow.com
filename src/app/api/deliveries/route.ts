import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";

export async function GET() {
  const { error } = await requireModule("dispatch");
  if (error) return error;

  const deliveries = await prisma.delivery.findMany({
    orderBy: { date: "desc" },
    take: 500,
    include: {
      orderItem: { include: { order: { include: { customer: true } } } },
    },
  });
  return NextResponse.json(deliveries);
}

export async function POST(request: Request) {
  const { error, user } = await requireSub("dispatch", "mark_delivered");
  if (error) return error;

  const data = await request.json();
  const { orderItemId, quantityKg, deliveryType, notes, finishedGoodsLotId } = data;

  if (!finishedGoodsLotId) {
    return NextResponse.json(
      { error: "A finished goods lot is required for all deliveries." },
      { status: 400 }
    );
  }

  try {
    const delivery = await prisma.$transaction(async (tx) => {
      const orderItem = await tx.orderItem.findUnique({ where: { id: orderItemId } });
      if (!orderItem) throw { _appCode: 404, message: "Order item not found" };

      // Guard: can only dispatch what is physically packaged, not just ordered
      const packagedBatches = await tx.roastingBatch.findMany({
        where: { orderItemId, status: { in: ["Packaged", "Partially Packaged"] } },
        select: { bags3kg: true, bags1kg: true, bags250g: true, bags150g: true, samplesGrams: true },
      });
      const totalPackagedKg = +(packagedBatches.reduce((sum, b) =>
        sum + b.bags3kg * 3 + b.bags1kg * 1 + b.bags250g * 0.25 + b.bags150g * 0.15 + b.samplesGrams / 1000,
        0
      ).toFixed(3));
      const availableToDeliver = +(totalPackagedKg - orderItem.deliveredQty).toFixed(3);

      if (availableToDeliver <= 0) {
        throw { _appCode: 400, message: "No packaged product is available for delivery yet. Please complete packaging first." };
      }
      if (quantityKg > availableToDeliver) {
        throw {
          _appCode: 400,
          message: `Cannot deliver ${quantityKg}kg. Only ${availableToDeliver}kg is packaged and available.`,
        };
      }

      // Validate FGL existence upfront (fail-fast, before any writes). Quantity is NOT read here;
      // it is checked atomically in the conditional update below.
      if (finishedGoodsLotId) {
        const lot = await tx.finishedGoodsLot.findUnique({
          where: { id: finishedGoodsLotId },
          select: {
            id: true,
            productId: true,
            productSkuId: true,
            roastingBatch: { select: { orderItemId: true } },
          },
        });
        if (!lot) throw { _appCode: 404, message: "Finished goods lot not found." };

        // Dual-path match: by product when the order item has one, otherwise by the
        // batch this lot was packaged from (every RoastingBatch belongs to one OrderItem).
        const productMatches = orderItem.productId
          ? lot.productId === orderItem.productId
          : lot.roastingBatch?.orderItemId === orderItem.id;

        // SKU is only enforced when both sides specify one — legacy/incomplete rows
        // with a null SKU on either side are not rejected on that basis alone.
        const skuMatches =
          !orderItem.productSkuId || !lot.productSkuId || lot.productSkuId === orderItem.productSkuId;

        if (!productMatches || !skuMatches) {
          throw { _appCode: 409, message: "Selected finished goods lot does not match this order item." };
        }
      }

      // 1. Create delivery record — needed first so its ID is available for the ledger
      const newDelivery = await tx.delivery.create({
        data: { orderItemId, quantityKg, deliveryType, notes },
      });

      // 2. Update delivery tracking on the order item
      const updatedItem = await tx.orderItem.update({
        where: { id: orderItemId },
        data: { deliveredQty: { increment: quantityKg } },
        select: { deliveredQty: true, quantityKg: true },
      });
      const newDeliveryStatus = updatedItem.quantityKg - updatedItem.deliveredQty <= 0
        ? "Delivered"
        : "Partial Delivered";
      await tx.orderItem.update({
        where: { id: orderItemId },
        data: { deliveryStatus: newDeliveryStatus },
      });

      // 3. FGL deduction + ledger movement (only when lot is linked)
      if (finishedGoodsLotId) {
        // WHERE availableQty >= quantityKg is evaluated atomically at write time by the database.
        const updated = await tx.finishedGoodsLot.updateMany({
          where: { id: finishedGoodsLotId, availableQty: { gte: quantityKg } },
          data: { availableQty: { decrement: quantityKg } },
        });
        if (updated.count === 0) {
          throw { _appCode: 409, message: "Insufficient finished goods lot quantity." };
        }

        const updatedLot = await tx.finishedGoodsLot.findUnique({
          where: { id: finishedGoodsLotId },
          select: { availableQty: true },
        });
        const newQuantity = updatedLot!.availableQty;
        const previousQuantity = newQuantity + quantityKg;
        const newLotStatus = newQuantity <= 0 ? "SHIPPED" : "AVAILABLE";

        await tx.finishedGoodsLot.update({
          where: { id: finishedGoodsLotId },
          data: { status: newLotStatus },
        });

        await tx.inventoryMovement.create({
          data: {
            type: "OUT",
            category: "FINISHED_GOODS",
            referenceEntityId: finishedGoodsLotId,
            quantityChanged: -quantityKg,
            previousQuantity,
            newQuantity,
            sourceDocType: "DELIVERY",
            sourceDocId: newDelivery.id,
            userId: user.id,
            notes: null,
          },
        });
      }

      // 4. Recalculate productionStatus + remainingQty (reads the new deliveredQty committed above)
      await recalcOrderItemStatus(orderItemId, tx);

      return newDelivery;
    });

    return NextResponse.json(delivery, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
