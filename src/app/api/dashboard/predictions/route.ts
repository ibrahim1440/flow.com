import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";

export async function GET() {
  const { error } = await requireModule("analytics");
  if (error) return error;

  const customers = await prisma.customer.findMany({
    include: {
      orders: {
        orderBy: { createdAt: "asc" },
        include: { items: true },
      },
    },
  });

  const predictions = customers
    .filter((c) => c.orders.length >= 2)
    .map((customer) => {
      const orders = customer.orders;
      const intervals: number[] = [];
      for (let i = 1; i < orders.length; i++) {
        const diff =
          new Date(orders[i].createdAt).getTime() -
          new Date(orders[i - 1].createdAt).getTime();
        intervals.push(diff / (1000 * 60 * 60 * 24));
      }

      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const lastOrder = orders[orders.length - 1];
      const lastDate = new Date(lastOrder.createdAt);
      const nextPredicted = new Date(lastDate.getTime() + avgInterval * 24 * 60 * 60 * 1000);

      const totalQty = orders.reduce(
        (sum, o) => sum + o.items.reduce((s, i) => s + i.quantityKg, 0),
        0
      );
      const avgQty = totalQty / orders.length;

      const beanFreq: Record<string, number> = {};
      for (const o of orders) {
        for (const item of o.items) {
          beanFreq[item.beanTypeName] = (beanFreq[item.beanTypeName] || 0) + 1;
        }
      }
      const topBeans = Object.entries(beanFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]) => name);

      const now = new Date();
      const daysUntilNext = Math.ceil(
        (nextPredicted.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );

      return {
        customerId: customer.id,
        customerName: customer.name,
        totalOrders: orders.length,
        avgIntervalDays: Math.round(avgInterval),
        avgQuantityKg: Math.round(avgQty),
        lastOrderDate: lastDate.toISOString(),
        nextPredictedDate: nextPredicted.toISOString(),
        daysUntilNext,
        topBeans,
        confidence: Math.min(orders.length * 15, 95),
      };
    })
    .sort((a, b) => a.daysUntilNext - b.daysUntilNext);

  return NextResponse.json(predictions);
}
