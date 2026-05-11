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

      const maxDeliverable = orderItem.quantityKg - orderItem.deliveredQty;
      if (quantityKg > maxDeliverable) {
        throw {
          _appCode: 400,
          message: `Cannot deliver ${quantityKg}kg. Maximum deliverable: ${maxDeliverable}kg`,
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
