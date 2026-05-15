import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

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
    include: {
      orderItem: { include: { order: { include: { customer: { include: { roastPreferences: true } } } } } },
      greenBean: true,
      qcRecords: { include: { employee: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" as const } },
      childBatches: { select: { id: true, batchNumber: true } },
      parentBatch: { select: { id: true, batchNumber: true } },
    },
  });
  return NextResponse.json(batches);
}

export async function POST(request: Request) {
  const { error } = await requireSub("production", "start_batch");
  if (error) return error;

  const data = await request.json();
  const { orderItemId, greenBeanId, greenBeanQuantity, roastedBeanQuantity, wasteQuantity, roastProfile } = data;

  if (greenBeanId) {
    const bean = await prisma.greenBean.findUnique({ where: { id: greenBeanId } });
    if (!bean || bean.quantityKg < greenBeanQuantity) {
      return NextResponse.json(
        { error: `Insufficient stock. Available: ${bean?.quantityKg || 0}kg, Requested: ${greenBeanQuantity}kg` },
        { status: 400 }
      );
    }
  }

  const batchNumber = await generateBatchNumber(greenBeanId);

  // Only QC-passed stages count toward order completion — Pending QC is NOT complete
  const COMPLETION_STATUSES = ["Passed", "Partially Packaged", "Packaged", "Blended"];

  try {
  const batch = await prisma.$transaction(async (tx) => {
    if (greenBeanId) {
      await tx.greenBean.update({
        where: { id: greenBeanId },
        data: { quantityKg: { decrement: greenBeanQuantity } },
      });
    }

    const qcDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const newBatch = await tx.roastingBatch.create({
      data: {
        orderItemId,
        greenBeanId: greenBeanId ?? null,
        greenBeanQuantity,
        roastedBeanQuantity: roastedBeanQuantity || 0,
        wasteQuantity: wasteQuantity || 0,
        roastProfile: roastProfile || null,
        batchNumber,
        status: "Pending QC",
        qcDeadline,
      },
      include: { orderItem: true, greenBean: true },
    });

    const orderItem = await tx.orderItem.findUnique({
      where: { id: orderItemId },
      select: { quantityKg: true },
    });

    if (orderItem) {
      // Re-query all batches so the new "Pending QC" batch is visible
      const allBatches = await tx.roastingBatch.findMany({
        where: { orderItemId },
        select: { status: true, roastedBeanQuantity: true, greenBeanQuantity: true },
      });
      const completionTotal = allBatches
        .filter(b => COMPLETION_STATUSES.includes(b.status))
        .reduce((sum, b) => sum + (b.roastedBeanQuantity > 0 ? b.roastedBeanQuantity : b.greenBeanQuantity), 0);
      // Always "In Production" when a new batch is created (it starts as Pending QC)
      const newStatus = completionTotal >= orderItem.quantityKg ? "Completed" : "In Production";
      await tx.orderItem.update({
        where: { id: orderItemId },
        data: { productionStatus: newStatus },
      });
    }

    return newBatch;
  });

  return NextResponse.json(batch, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
