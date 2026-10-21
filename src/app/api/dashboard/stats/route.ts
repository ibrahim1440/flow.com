import { NextResponse } from "@/lib/api-response";
import { readQcSettings } from "@/lib/services/settings/sections";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { anonymousOrder, canSeeCustomerDetail } from "@/lib/auth/customer-detail";

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
  const { user, error } = await requireModule("dashboard");
  if (error) return error;
  // Owner decision F4: identifiable customer data only with the customer-detail permission.
  const customerDetail = canSeeCustomerDetail(user.permissions);

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
        isBlend: false,
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
      take: 50,
    }),
  ]);

  const totalRoastedKg = batchAgg._sum.roastedBeanQuantity ?? 0;
  const totalGreenKg = batchAgg._sum.greenBeanQuantity ?? 0;
  const shrinkagePct =
    totalGreenKg > 0
      ? Number((((totalGreenKg - totalRoastedKg) / totalGreenKg) * 100).toFixed(1))
      : null;

  const now = new Date();
  const { effectiveMinEvaluators: qcMin } = await readQcSettings(prisma);
  const qcBatchAlerts = openQcBatches.map((b) => ({
    id: b.id,
    batchNumber: b.batchNumber,
    origin: b.greenBean?.beanType ?? b.orderItem?.beanTypeName ?? "",
    testerCount: b.qcRecords.length,
    // D1 (production simplification): the minimum in force, and whether the panel has reached it.
    minEvaluators: qcMin,
    belowMinimum: b.qcRecords.length < qcMin,
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
    // F4: without the customer-detail permission an open order is its line count, kg and line
    // states only — no customer, no order number, no id.
    recentActiveOrders: customerDetail ? recentActiveOrders : recentActiveOrders.map(anonymousOrder),
    customerDetail,
    qcBatchAlerts,
  });
}
