import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireSub("orders", "edit");
  if (error) return error;

  const { id } = await params;
  const { items, ...orderData } = await request.json();

  if (items) {
    const beanIds = [...new Set(
      items.filter((i: { greenBeanId?: string }) => i.greenBeanId).map((i: { greenBeanId: string }) => i.greenBeanId)
    )] as string[];

    if (beanIds.length > 0) {
      const greenBeans = await prisma.greenBean.findMany({ where: { id: { in: beanIds } } });
      const stockMap = new Map(greenBeans.map((b) => [b.id, b.quantityKg]));
      const demandMap = new Map<string, number>();
      for (const item of items as { greenBeanId?: string; quantityKg: number }[]) {
        if (!item.greenBeanId) continue;
        demandMap.set(item.greenBeanId, (demandMap.get(item.greenBeanId) || 0) + item.quantityKg);
      }
      const insufficient: string[] = [];
      for (const [beanId, demand] of demandMap) {
        const available = stockMap.get(beanId) ?? 0;
        if (demand > available) {
          const bean = greenBeans.find((b) => b.id === beanId);
          insufficient.push(`${bean?.beanType ?? "Unknown"}: need ${demand}kg, available ${available}kg`);
        }
      }
      if (insufficient.length > 0) {
        return NextResponse.json({ error: "Insufficient stock", details: insufficient }, { status: 400 });
      }
    }

    const existing = await prisma.orderItem.findMany({ where: { orderId: id } });
    const existingIds = existing.map((e) => e.id);
    const incomingIds = items.filter((i: { id?: string }) => i.id).map((i: { id: string }) => i.id);
    const toDelete = existingIds.filter((eid) => !incomingIds.includes(eid));

    if (toDelete.length > 0) {
      await prisma.orderItem.deleteMany({ where: { id: { in: toDelete } } });
    }

    for (const item of items as { id?: string; beanTypeName: string; quantityKg: number; greenBeanId?: string }[]) {
      if (item.id) {
        await prisma.orderItem.update({
          where: { id: item.id },
          data: { beanTypeName: item.beanTypeName, quantityKg: item.quantityKg, greenBeanId: item.greenBeanId || null, remainingQty: item.quantityKg },
        });
      } else {
        await prisma.orderItem.create({
          data: { orderId: id, beanTypeName: item.beanTypeName, quantityKg: item.quantityKg, greenBeanId: item.greenBeanId || null, remainingQty: item.quantityKg },
        });
      }
    }
  }

  const order = await prisma.order.update({
    where: { id },
    data: orderData,
    include: { customer: true, items: true },
  });
  return NextResponse.json(order);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireSub("orders", "delete");
  if (error) return error;

  const { id } = await params;
  await prisma.order.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
