import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";

export async function GET(request: Request) {
  const { error } = await requireModule("orders");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const customerId = searchParams.get("customerId");

  const where: Record<string, unknown> = {};
  if (customerId) where.customerId = customerId;
  if (status) where.items = { some: { productionStatus: status } };

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      customer: true,
      items: {
        include: {
          roastingBatches: { include: { qcRecords: true } },
          deliveries: true,
          greenBean: true,
        },
      },
    },
  });
  return NextResponse.json(orders);
}

export async function POST(request: Request) {
  const { error } = await requireSub("orders", "create");
  if (error) return error;

  const { items, ...orderData } = await request.json();

  const beanIds = [...new Set(
    items
      .filter((i: { greenBeanId?: string }) => i.greenBeanId)
      .map((i: { greenBeanId: string }) => i.greenBeanId)
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
      return NextResponse.json(
        { error: "Insufficient stock", details: insufficient },
        { status: 400 }
      );
    }
  }

  const lastOrder = await prisma.order.findFirst({ orderBy: { orderNumber: "desc" } });
  const nextNumber = (lastOrder?.orderNumber || 0) + 1;

  const order = await prisma.order.create({
    data: {
      ...orderData,
      orderNumber: nextNumber,
      items: {
        create: items.map((item: { beanTypeName: string; quantityKg: number; greenBeanId?: string }) => ({
          beanTypeName: item.beanTypeName,
          quantityKg: item.quantityKg,
          greenBeanId: item.greenBeanId || null,
          remainingQty: item.quantityKg,
        })),
      },
    },
    include: { customer: true, items: true },
  });

  return NextResponse.json(order, { status: 201 });
}
