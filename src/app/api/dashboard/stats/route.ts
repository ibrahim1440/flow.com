import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";

function getDateFilter(timeframe: string): { gte: Date } | undefined {
  const now = new Date();
  switch (timeframe) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { gte: start };
    }
    case "week": {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return { gte: start };
    }
    case "month": {
      const start = new Date(now);
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      return { gte: start };
    }
    default:
      return undefined;
  }
}

export async function GET(request: Request) {
  const { error } = await requireModule("dashboard");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const timeframe = searchParams.get("timeframe") ?? "all";
  const dateFilter = getDateFilter(timeframe);
  const createdAtWhere = dateFilter ? { createdAt: dateFilter } : {};

  const [
    batchAgg,
    pendingCount,
    inProductionCount,
    readyToDispatchCount,
    activeCustomersResult,
    inventoryAlerts,
    recentActiveOrders,
    openQcBatches,
  ] = await Promise.all([
    prisma.roastingBatch.aggregate({
      where: {
        ...(dateFilter ? { createdAt: dateFilter } : {}),
        roastedBeanQuantity: { gt: 0 },
      },
      _sum: {
        roastedBeanQuantity: true,
        greenBeanQuantity: true,
      },
    }),
    // Live pipeline counts — not time-filtered
    prisma.orderItem.count({ where: { productionStatus: "Pending" } }),
    prisma.orderItem.count({ where: { productionStatus: "In Production" } }),
    prisma.orderItem.count({
      where: { productionStatus: "Completed", deliveryStatus: { not: "Delivered" } },
    }),
    // Distinct customers who placed orders in the timeframe
    prisma.order.findMany({
      where: createdAtWhere,
      select: { customerId: true },
      distinct: ["customerId"],
    }),
    // Beans below 50 kg threshold
    prisma.greenBean.findMany({
      where: { quantityKg: { lt: 50 }, isActive: true },
      select: {
        id: true,
        beanType: true,
        beanTypeAr: true,
        country: true,
        countryAr: true,
        quantityKg: true,
      },
      orderBy: { quantityKg: "asc" },
    }),
    // Latest 7 orders that are not fully completed
    prisma.order.findMany({
      where: {
        items: { some: { productionStatus: { not: "Completed" } } },
      },
      include: {
        customer: { select: { name: true, nameAr: true } },
        items: {
          select: {
            productionStatus: true,
            deliveryStatus: true,
            quantityKg: true,
            beanTypeName: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 7,
    }),
    prisma.roastingBatch.findMany({
      where: { status: "Pending QC" },
      include: {
        greenBean: true,
        orderItem: { include: { order: { include: { customer: true } } } },
        qcRecords: { select: { id: true, decision: true } },
      },
      orderBy: { qcDeadline: "asc" },
    }),
  ]);

  const totalRoastedKg = batchAgg._sum.roastedBeanQuantity ?? 0;
  const totalGreenKg = batchAgg._sum.greenBeanQuantity ?? 0;
  const shrinkagePct =
    totalGreenKg > 0
      ? Number((((totalGreenKg - totalRoastedKg) / totalGreenKg) * 100).toFixed(1))
      : null;

  const now = new Date();
  const qcBatchAlerts = openQcBatches.map((b) => ({
    id: b.id,
    batchNumber: b.batchNumber,
    origin: b.greenBean?.beanType ?? b.orderItem.beanTypeName,
    testerCount: b.qcRecords.length,
    deadline: b.qcDeadline,
    isOverdue: b.qcDeadline ? b.qcDeadline < now : false,
    isUrgent: b.qcDeadline
      ? b.qcDeadline < new Date(now.getTime() + 6 * 60 * 60 * 1000)
      : false,
  }));

  return NextResponse.json({
    totalRoastedKg,
    totalGreenKg,
    shrinkagePct,
    ordersPipeline: {
      pending: pendingCount,
      inProduction: inProductionCount,
      readyToDispatch: readyToDispatchCount,
    },
    activeCustomers: activeCustomersResult.length,
    inventoryAlerts,
    recentActiveOrders,
    qcBatchAlerts,
  });
}
