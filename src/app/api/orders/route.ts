import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function GET(request: Request) {
  // Production and Dispatch workers need to read orders to see what to roast / deliver
  const { error } = await requireAnyModule("orders", "production", "dispatch");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const customerId = searchParams.get("customerId");

  const where: Record<string, unknown> = {};
  if (customerId) where.customerId = customerId;
  if (status) {
    const statusList = status.split(",");
    where.items = { some: { productionStatus: statusList.length === 1 ? status : { in: statusList } } };
  }

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

  try {
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

    let order;
    for (let attempt = 0; attempt < 5; attempt++) {
      const lastOrder = await prisma.order.findFirst({ orderBy: { orderNumber: "desc" } });
      const nextNumber = (lastOrder?.orderNumber || 0) + 1;
      try {
        order = await prisma.order.create({
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
        break;
      } catch (e: unknown) {
        const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : null;
        if (code === "P2002" && attempt < 4) continue;
        throw e;
      }
    }

    if (!order) throw new Error("Order creation failed after retries.");
    return NextResponse.json(order, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
