import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";

const COMPLETION_STATUSES = ["Passed", "Partially Packaged", "Packaged", "Blended"];
const ACTIVE_STATUSES = ["Pending QC", "Passed", "Partially Packaged", "Packaged", "Blended"];

export async function GET() {
  const { error } = await requireModule("qc");
  if (error) return error;

  const records = await prisma.qcRecord.findMany({
    orderBy: { date: "desc" },
    include: {
      employee: { select: { id: true, name: true } },
      batch: {
        include: {
          orderItem: { include: { order: { include: { customer: true } } } },
        },
      },
    },
  });
  return NextResponse.json(records);
}

export async function POST(request: Request) {
  const { error } = await requireSub("qc", "create_record");
  if (error) return error;

  const data = await request.json();
  const record = await prisma.qcRecord.create({
    data,
    include: { batch: true, employee: { select: { id: true, name: true } } },
  });

  if (data.onProfile) {
    await prisma.$transaction(async (tx) => {
      await tx.roastingBatch.update({
        where: { id: data.batchId },
        data: { status: "Passed" },
      });

      const batch = await tx.roastingBatch.findUnique({
        where: { id: data.batchId },
        select: { orderItemId: true },
      });
      if (!batch) return;

      const orderItem = await tx.orderItem.findUnique({
        where: { id: batch.orderItemId },
        select: { quantityKg: true },
      });
      if (!orderItem) return;

      const allBatches = await tx.roastingBatch.findMany({
        where: { orderItemId: batch.orderItemId },
        select: { status: true, roastedBeanQuantity: true, greenBeanQuantity: true },
      });
      const hasActive = allBatches.some(b => ACTIVE_STATUSES.includes(b.status));
      const completionTotal = allBatches
        .filter(b => COMPLETION_STATUSES.includes(b.status))
        .reduce((sum, b) => sum + (b.roastedBeanQuantity > 0 ? b.roastedBeanQuantity : b.greenBeanQuantity), 0);
      const itemStatus = !hasActive
        ? "Pending"
        : completionTotal >= orderItem.quantityKg
        ? "Completed"
        : "In Production";

      await tx.orderItem.update({
        where: { id: batch.orderItemId },
        data: { productionStatus: itemStatus },
      });
    });
  }

  return NextResponse.json(record, { status: 201 });
}
