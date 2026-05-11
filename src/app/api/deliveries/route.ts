import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

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
  const { orderItemId, quantityKg, deliveryType, notes } = data;

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

      const newDelivered = orderItem.deliveredQty + quantityKg;
      const newRemaining = orderItem.quantityKg - newDelivered;
      const newStatus = newRemaining <= 0 ? "Delivered" : "Partial Delivered";

      const [newDelivery] = await Promise.all([
        tx.delivery.create({ data: { orderItemId, quantityKg, deliveryType, notes } }),
        tx.orderItem.update({
          where: { id: orderItemId },
          data: { deliveredQty: newDelivered, remainingQty: newRemaining, deliveryStatus: newStatus },
        }),
      ]);

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
