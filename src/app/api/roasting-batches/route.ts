import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";

async function generateBatchNumber(): Promise<string> {
  const now = new Date();
  const prefix = now.toISOString().slice(0, 10).replace(/-/g, "");

  const latest = await prisma.roastingBatch.findMany({
    where: { batchNumber: { startsWith: prefix } },
    select: { batchNumber: true },
  });

  let maxSeq = 0;
  for (const b of latest) {
    const suffix = b.batchNumber.slice(prefix.length, prefix.length + 2);
    const num = parseInt(suffix, 10);
    if (!isNaN(num) && num > maxSeq) maxSeq = num;
  }

  const seq = String(maxSeq + 1).padStart(2, "0");
  return `${prefix}${seq}`;
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

  const batchNumber = await generateBatchNumber();

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
