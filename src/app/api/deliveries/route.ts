import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";

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

  const orderItem = await prisma.orderItem.findUnique({ where: { id: orderItemId } });
  if (!orderItem) {
    return NextResponse.json({ error: "Order item not found" }, { status: 404 });
  }

  const maxDeliverable = orderItem.quantityKg - orderItem.deliveredQty;
  if (quantityKg > maxDeliverable) {
    return NextResponse.json(
      { error: `Cannot deliver ${quantityKg}kg. Maximum deliverable: ${maxDeliverable}kg` },
      { status: 400 }
    );
  }

  const delivery = await prisma.delivery.create({
    data: { orderItemId, quantityKg, deliveryType, notes },
  });

  const newDelivered = orderItem.deliveredQty + quantityKg;
  const newRemaining = orderItem.quantityKg - newDelivered;
  const newStatus = newRemaining <= 0 ? "Delivered" : "Partial Delivered";

  await prisma.orderItem.update({
    where: { id: orderItemId },
    data: {
      deliveredQty: newDelivered,
      remainingQty: newRemaining,
      deliveryStatus: newStatus,
    },
  });

  return NextResponse.json(delivery, { status: 201 });
}
