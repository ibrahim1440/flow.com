import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";

function isoWeekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

export async function GET() {
  const { error } = await requireModule("dashboard");
  if (error) return error;

  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart    = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd      = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  const thirtyDaysAgo     = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const eightWeeksAgo     = new Date(now.getTime() - 56 * 24 * 60 * 60 * 1000);

  const [
    currentMonthAgg,
    prevMonthAgg,
    recentBatches,
    qcGrouped,
    greenBeanAgg,
    fglAgg,
    weeklyBatches,
    pendingCount,
    inProductionCount,
    readyCount,
    inventoryAlerts,
    recentActiveOrders,
    openQcBatches,
  ] = await Promise.all([
    prisma.roastingBatch.aggregate({
      where: { createdAt: { gte: currentMonthStart }, roastedBeanQuantity: { gt: 0 }, isBlend: false },
      _sum: { roastedBeanQuantity: true, greenBeanQuantity: true },
      _count: { id: true },
    }),
    prisma.roastingBatch.aggregate({
      where: { createdAt: { gte: prevMonthStart, lte: prevMonthEnd }, roastedBeanQuantity: { gt: 0 }, isBlend: false },
      _sum: { roastedBeanQuantity: true },
    }),
    // Fetch raw batch rows for loss calculation — only 2 float fields, very small payload
    prisma.roastingBatch.findMany({
      where: { createdAt: { gte: thirtyDaysAgo }, roastedBeanQuantity: { gt: 0 }, greenBeanQuantity: { gt: 0 }, isBlend: false },
      select: { roastedBeanQuantity: true, greenBeanQuantity: true },
    }),
    prisma.qcRecord.groupBy({
      by: ["decision"],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: { id: true },
    }),
    prisma.greenBean.aggregate({
      where: { isActive: true },
      _sum: { quantityKg: true },
    }),
    prisma.finishedGoodsLot.aggregate({
      where: { status: "AVAILABLE" },
      _sum: { availableQty: true },
    }),
    // Only 3 fields per batch for chart — minimal payload
    prisma.roastingBatch.findMany({
      where: { createdAt: { gte: eightWeeksAgo }, roastedBeanQuantity: { gt: 0 }, isBlend: false },
      select: { createdAt: true, roastedBeanQuantity: true, greenBeanQuantity: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.orderItem.count({ where: { productionStatus: "Pending" } }),
    prisma.orderItem.count({ where: { productionStatus: "In Production" } }),
    prisma.orderItem.count({ where: { productionStatus: "Completed", deliveryStatus: { not: "Delivered" } } }),
    prisma.greenBean.findMany({
      where: { quantityKg: { lt: 50 }, isActive: true },
      select: { id: true, beanType: true, beanTypeAr: true, country: true, countryAr: true, quantityKg: true },
      orderBy: { quantityKg: "asc" },
    }),
    prisma.order.findMany({
      where: { items: { some: { productionStatus: { not: "Completed" } } } },
      include: {
        customer: { select: { name: true, nameAr: true } },
        items: { select: { productionStatus: true, deliveryStatus: true, quantityKg: true, beanTypeName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
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

  // ── Derived KPIs ───────────────────────────────────────────────────────────

  const currentMonthKg = +(currentMonthAgg._sum.roastedBeanQuantity ?? 0).toFixed(1);
  const prevMonthKg    = +(prevMonthAgg._sum.roastedBeanQuantity ?? 0).toFixed(1);
  const productionTrend =
    prevMonthKg > 0 ? +(((currentMonthKg - prevMonthKg) / prevMonthKg) * 100).toFixed(1) : null;

  // Weighted average loss (not per-batch average — more accurate)
  let avgLossPct: number | null = null;
  if (recentBatches.length > 0) {
    const totalGreen   = recentBatches.reduce((s, b) => s + b.greenBeanQuantity, 0);
    const totalRoasted = recentBatches.reduce((s, b) => s + b.roastedBeanQuantity, 0);
    avgLossPct = totalGreen > 0 ? +(((totalGreen - totalRoasted) / totalGreen) * 100).toFixed(1) : null;
  }

  const qcPass  = qcGrouped.find((q) => q.decision === "Accept")?._count.id ?? 0;
  const qcFail  = qcGrouped.find((q) => q.decision === "Reject")?._count.id ?? 0;
  const qcTotal = qcPass + qcFail;
  const qcPassRate = qcTotal > 0 ? +(((qcPass / qcTotal) * 100).toFixed(1)) : null;

  // ── Weekly production aggregation ─────────────────────────────────────────

  type WeekEntry = { roastedKg: number; greenKg: number; label: string };
  const weekMap = new Map<string, WeekEntry>();

  for (const batch of weeklyBatches) {
    const key = isoWeekStart(new Date(batch.createdAt));
    const prev = weekMap.get(key) ?? { roastedKg: 0, greenKg: 0, label: "" };
    const d    = new Date(key + "T00:00:00Z");
    weekMap.set(key, {
      roastedKg: +(prev.roastedKg + batch.roastedBeanQuantity).toFixed(1),
      greenKg:   +(prev.greenKg   + batch.greenBeanQuantity).toFixed(1),
      label:     `${d.getUTCDate()}/${d.getUTCMonth() + 1}`,
    });
  }

  const weeklyProduction = Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-8)
    .map(([, v]) => v);

  // ── QC alert shaping ──────────────────────────────────────────────────────

  const qcBatchAlerts = openQcBatches.map((b) => ({
    id:           b.id,
    batchNumber:  b.batchNumber,
    origin:       b.greenBean?.beanType ?? b.orderItem.beanTypeName,
    testerCount:  b.qcRecords.length,
    deadline:     b.qcDeadline,
    isOverdue:    b.qcDeadline ? b.qcDeadline < now : false,
    isUrgent:     b.qcDeadline ? b.qcDeadline < new Date(now.getTime() + 6 * 60 * 60 * 1000) : false,
  }));

  return NextResponse.json({
    kpi: {
      currentMonthKg,
      prevMonthKg,
      productionTrend,
      batchCount:       currentMonthAgg._count.id,
      avgLossPct,
      qcPassRate,
      qcPassCount:      qcPass,
      qcTotalCount:     qcTotal,
      rawMaterialKg:    +(greenBeanAgg._sum.quantityKg  ?? 0).toFixed(1),
      finishedGoodsKg:  +(fglAgg._sum.availableQty      ?? 0).toFixed(1),
    },
    weeklyProduction,
    qcBreakdown: [
      { decision: "Accept", count: qcPass },
      { decision: "Reject", count: qcFail },
    ],
    pipeline: {
      pending:         pendingCount,
      inProduction:    inProductionCount,
      readyToDispatch: readyCount,
    },
    inventoryAlerts,
    recentActiveOrders,
    qcBatchAlerts,
  });
}
