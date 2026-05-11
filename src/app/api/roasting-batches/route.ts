import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";

async function generateBatchNumber(greenBeanId: string | null | undefined): Promise<string> {
  const now = new Date();
  // YYYYMMDD using UTC so it matches the stored createdAt timestamps
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");

  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(now);
  dayEnd.setUTCHours(23, 59, 59, 999);

  // Scope the sequence to this green bean (per-bean per-day isolation).
  // If no bean is linked, scope globally to the day as a fallback.
  const batches = await prisma.roastingBatch.findMany({
    where: {
      ...(greenBeanId ? { greenBeanId } : {}),
      createdAt: { gte: dayStart, lte: dayEnd },
    },
    select: { batchNumber: true },
  });

  // Find the highest sequence already used today for this bean
  let maxSeq = 0;
  for (const b of batches) {
    // batchNumber format: YYYYMMDD + 2-digit sequence (e.g. "2026051103")
    const suffix = b.batchNumber.slice(8);
    const num = parseInt(suffix, 10);
    if (!isNaN(num) && num > maxSeq) maxSeq = num;
  }

  const seq = String(maxSeq + 1).padStart(2, "0");
  return `${dateStr}${seq}`;
}

export async function GET() {
  const { error } = await requireModule("production");
  if (error) return error;

  const batches = await prisma.roastingBatch.findMany({
    orderBy: { date: "desc" },
    include: {
      orderItem: { include: { order: { include: { customer: true } } } },
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

  const batch = await prisma.$transaction(async (tx) => {
    if (greenBeanId) {
      await tx.greenBean.update({
        where: { id: greenBeanId },
        data: { quantityKg: { decrement: greenBeanQuantity } },
      });
    }

    const qcDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
    return tx.roastingBatch.create({
      data: {
        orderItemId,
        greenBeanId,
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
  });

  const orderItem = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    include: { roastingBatches: true },
  });

  if (orderItem) {
    const totalProduced = orderItem.roastingBatches.reduce(
      (sum: number, b: { greenBeanQuantity: number }) => sum + b.greenBeanQuantity, 0
    );
    const newStatus = totalProduced >= orderItem.quantityKg ? "Completed" : "In Production";
    await prisma.orderItem.update({
      where: { id: orderItemId },
      data: { productionStatus: newStatus },
    });
  }

  return NextResponse.json(batch, { status: 201 });
}
