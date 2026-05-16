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
    include: {
      orderItem: { include: { order: { include: { customer: true } } } },
    },
  });
  return NextResponse.json(deliveries);
}

export async function POST(request: Request) {
  const { error } = await requireSub("dispatch", "mark_delivered");
  if (error) return error;

  const data = await request.json();
  const { orderItemId, quantityKg, deliveryType, notes, finishedGoodsLotId } = data;

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

      // Validate FGL upfront (fail-fast, before any writes) if lot is provided
      let lotAvailableQty: number | null = null;
      if (finishedGoodsLotId) {
        const lot = await tx.finishedGoodsLot.findUnique({
          where: { id: finishedGoodsLotId },
          select: { availableQty: true },
        });
        if (!lot) throw { _appCode: 404, message: "Finished goods lot not found." };
        if (lot.availableQty < quantityKg) {
          throw {
            _appCode: 400,
            message: `Insufficient finished goods. Lot has ${lot.availableQty}kg available, requested ${quantityKg}kg.`,
          };
        }
        lotAvailableQty = lot.availableQty;
      }

      // 1. Create delivery record — needed first so its ID is available for the ledger
      const newDelivery = await tx.delivery.create({
        data: { orderItemId, quantityKg, deliveryType, notes },
      });

      // 2. Update delivery tracking on the order item
      const newDelivered = orderItem.deliveredQty + quantityKg;
      const newDeliveryStatus = orderItem.quantityKg - newDelivered <= 0 ? "Delivered" : "Partial Delivered";
      await tx.orderItem.update({
        where: { id: orderItemId },
        data: { deliveredQty: newDelivered, deliveryStatus: newDeliveryStatus },
      });

      // 3. FGL deduction + ledger movement (only when lot is linked)
      if (finishedGoodsLotId && lotAvailableQty !== null) {
        const newAvailableQty = +(lotAvailableQty - quantityKg).toFixed(3);
        const newLotStatus = newAvailableQty <= 0 ? "SHIPPED" : "AVAILABLE";

        await tx.finishedGoodsLot.update({
          where: { id: finishedGoodsLotId },
          data: { availableQty: newAvailableQty, status: newLotStatus },
        });

        await tx.inventoryMovement.create({
          data: {
            type: "OUT",
            category: "FINISHED_GOODS",
            referenceEntityId: finishedGoodsLotId,
            quantityChanged: -quantityKg,
            previousQuantity: lotAvailableQty,
            newQuantity: newAvailableQty,
            sourceDocType: "DELIVERY",
            sourceDocId: newDelivery.id,
            userId: null,
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
