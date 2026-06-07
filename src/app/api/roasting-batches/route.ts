import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";

class AppError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function generateBatchNumber(greenBeanId: string | null | undefined): Promise<string> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");

  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(now);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const existing = await prisma.roastingBatch.findMany({
    where: {
      greenBeanId: greenBeanId ?? null,
      createdAt: { gte: dayStart, lte: dayEnd },
    },
    select: { id: true },
  });

  return `${dateStr}${String(existing.length + 1).padStart(2, "0")}`;
}

export async function GET(request: Request) {
  // QC and Packaging workers need to read batches for their own workflow stages
  const { error } = await requireAnyModule("production", "qc", "packaging");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("statuses");
  const where = statusParam ? { status: { in: statusParam.split(",") } } : undefined;

  const batches = await prisma.roastingBatch.findMany({
    where,
    orderBy: { date: "desc" },
    take: 500,
    include: {
      orderItem: { include: { order: { include: { customer: { include: { roastPreferences: true } } } } } },
      greenBean: true,
      qcRecords: {
        include: {
          employee: { select: { id: true, name: true } },
          _count: { select: { correctionHistory: true } },
        },
        orderBy: { createdAt: "asc" as const },
      },
      childBatches: { select: { id: true, batchNumber: true } },
      parentBatch: { select: { id: true, batchNumber: true } },
      blendInputs: { select: { id: true, sourceBatchId: true, quantityUsed: true, sourceBatch: { select: { batchNumber: true } } } },
      blendOutputs: { select: { id: true, targetBlendBatchId: true, quantityUsed: true, targetBlendBatch: { select: { batchNumber: true } } } },
    },
  });
  return NextResponse.json(batches);
}

export async function POST(request: Request) {
  const { error, user } = await requireSub("production", "start_batch");
  if (error) return error;

  const data = await request.json();
  const { orderItemId, greenBeanId, greenBeanQuantity, roastedBeanQuantity, wasteQuantity, roastProfile, productionOrderId } = data;

  const qty = Number(greenBeanQuantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ error: "greenBeanQuantity must be a positive number." }, { status: 400 });
  }

  const roastedQty = Number(roastedBeanQuantity ?? 0);
  const wasteQty   = Number(wasteQuantity ?? 0);
  if (!Number.isFinite(roastedQty) || roastedQty <= 0) {
    return NextResponse.json({ error: "Roasted quantity must be greater than 0." }, { status: 400 });
  }
  if (!Number.isFinite(wasteQty) || wasteQty < 0) {
    return NextResponse.json({ error: "wasteQuantity must be a non-negative number." }, { status: 400 });
  }
  if (roastedQty + wasteQty > qty) {
    return NextResponse.json({ error: "roastedBeanQuantity + wasteQuantity cannot exceed greenBeanQuantity." }, { status: 400 });
  }

  // ── Surplus gate ─────────────────────────────────────────────────────────
  // Backend enforcement: non-admin users cannot create batches that exceed the
  // order item's required quantity. UI warning alone is bypassable via direct API.
  const surplusOrderItem = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: { quantityKg: true },
  });
  if (!surplusOrderItem) {
    return NextResponse.json({ error: "Order item not found." }, { status: 404 });
  }

  const existingAgg = await prisma.roastingBatch.aggregate({
    where: {
      orderItemId,
      isBlend: false,
      status: { not: "Rejected" },
    },
    _sum: { greenBeanQuantity: true },
  });

  const alreadyKg = existingAgg._sum.greenBeanQuantity ?? 0;
  const excess = +(alreadyKg + qty - surplusOrderItem.quantityKg).toFixed(3);

  if (excess > 0 && user.role !== "admin") {
    return NextResponse.json(
      {
        error: `Batch would exceed the order quantity by ${excess}kg. Only an admin can authorize surplus production.`,
      },
      { status: 422 }
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  const batchNumber = await generateBatchNumber(greenBeanId);

  try {
  const batch = await prisma.$transaction(async (tx) => {
    let previousQuantity: number | null = null;
    let newQuantity:      number | null = null;

    if (greenBeanId) {
      // Step 1: confirm existence and active status
      const bean = await tx.greenBean.findUnique({
        where:  { id: greenBeanId },
        select: { isActive: true },
      });
      if (!bean)          throw new AppError(404, "Green bean not found.");
      if (!bean.isActive) throw new AppError(400, "Cannot use an inactive green bean.");

      // Step 2: conditional update — WHERE quantityKg >= qty is evaluated atomically at write time
      const updated = await tx.greenBean.updateMany({
        where: { id: greenBeanId, quantityKg: { gte: qty } },
        data:  { quantityKg: { decrement: qty } },
      });
      if (updated.count === 0) throw new AppError(409, "Insufficient stock.");

      // Step 3: re-read post-decrement quantity inside the same transaction
      const updatedBean = await tx.greenBean.findUnique({
        where:  { id: greenBeanId },
        select: { quantityKg: true },
      });
      newQuantity      = updatedBean!.quantityKg;
      previousQuantity = newQuantity + qty;
    }

    const qcDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const newBatch = await tx.roastingBatch.create({
      data: {
        orderItemId,
        greenBeanId:         greenBeanId ?? null,
        greenBeanQuantity:   qty,
        roastedBeanQuantity: roastedQty,
        wasteQuantity:       wasteQty,
        roastProfile:        roastProfile || null,
        batchNumber,
        status:              "Pending QC",
        qcDeadline,
        productionOrderId:   productionOrderId ?? null,
      },
      include: { orderItem: true, greenBean: true },
    });

    if (greenBeanId && previousQuantity !== null && newQuantity !== null) {
      await tx.inventoryMovement.create({
        data: {
          type:              "OUT",
          category:          "RAW_MATERIAL",
          referenceEntityId: greenBeanId,
          quantityChanged:   -qty,
          previousQuantity,
          newQuantity,
          sourceDocType:     "ROASTING_BATCH",
          sourceDocId:       newBatch.id,
          userId:            user.id,
          notes:             null,
        },
      });
    }

    await recalcOrderItemStatus(orderItemId, tx);

    if (newBatch.productionOrderId) {
      await recalcProductionOrderStatus(newBatch.productionOrderId, tx);
    }

    return newBatch;
  });

  return NextResponse.json(batch, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return handlePrismaError(err);
  }
}
