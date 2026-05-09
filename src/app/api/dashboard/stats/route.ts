import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";

export async function GET() {
  const { error } = await requireModule("dashboard");
  if (error) return error;

  const [
    totalOrders,
    pendingOrders,
    completedOrders,
    totalCustomers,
    totalBeans,
    totalBatches,
    totalQcRecords,
    totalDeliveries,
    orders,
    beans,
    openQcBatches,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.orderItem.count({ where: { productionStatus: "Pending" } }),
    prisma.orderItem.count({ where: { productionStatus: "Completed" } }),
    prisma.customer.count(),
    prisma.greenBean.count(),
    prisma.roastingBatch.count(),
    prisma.qcRecord.count(),
    prisma.delivery.count(),
    prisma.order.findMany({
      include: { items: true, customer: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.greenBean.findMany({ orderBy: { quantityKg: "desc" }, take: 10 }),
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

  const now = new Date();
  const totalStockKg = beans.reduce((s, b) => s + b.quantityKg, 0);
  const lowStockBeans = beans.filter((b) => b.quantityKg < 20);
  const qcBatchAlerts = openQcBatches.map((b) => ({
    id: b.id,
    batchNumber: b.batchNumber,
    origin: b.greenBean?.beanType || b.orderItem.beanTypeName,
    testerCount: b.qcRecords.length,
    deadline: b.qcDeadline,
    isOverdue: b.qcDeadline ? b.qcDeadline < now : false,
    isUrgent: b.qcDeadline ? b.qcDeadline < new Date(now.getTime() + 6 * 60 * 60 * 1000) : false,
  }));

  return NextResponse.json({
    totalOrders,
    pendingOrders,
    completedOrders,
    totalCustomers,
    totalBeans,
    totalBatches,
    totalQcRecords,
    totalDeliveries,
    totalStockKg,
    lowStockBeans,
    recentOrders: orders,
    topBeans: beans,
    qcBatchAlerts,
  });
}
