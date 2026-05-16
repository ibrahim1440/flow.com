import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";

export async function POST(request: Request) {
  const { error } = await requireSub("production", "blend");
  if (error) return error;

  const { batchIds, orderItemId } = await request.json();

  if (!batchIds || batchIds.length < 2) {
    return NextResponse.json({ error: "Select at least 2 batches to blend" }, { status: 400 });
  }

  const batches = await prisma.roastingBatch.findMany({
    where: { id: { in: batchIds } },
  });

  if (batches.length !== batchIds.length) {
    return NextResponse.json({ error: "One or more batches not found" }, { status: 404 });
  }

  if (batches.some((b) => b.isBlend)) {
    return NextResponse.json({ error: "Cannot blend a batch that is already a blend output" }, { status: 400 });
  }

  const statuses = new Set(batches.map((b) => b.status));

  if (statuses.size > 1) {
    return NextResponse.json(
      { error: "Cannot mix batches with different statuses. All selected batches must be either \"Pending QC\" or \"Passed\"." },
      { status: 400 }
    );
  }

  const commonStatus = batches[0].status;

  if (!isValidTransition(commonStatus, "Blended")) {
    return NextResponse.json(
      { error: `Cannot blend batches with status "${commonStatus}". Only "Pending QC" or "Passed" batches can be blended.` },
      { status: 400 }
    );
  }

  const blendTiming = commonStatus === "Pending QC" ? "Before QC" : "After QC";

  const roastedTotal = batches.reduce((sum, b) => sum + b.roastedBeanQuantity, 0);
  const greenTotal = batches.reduce((sum, b) => sum + b.greenBeanQuantity, 0);
  const wasteTotal = batches.reduce((sum, b) => sum + b.wasteQuantity, 0);

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const seqParts = batches
    .map((b) => b.batchNumber.slice(-2))
    .sort()
    .join("");
  const blendedBatchNumber = `${today}${seqParts}`;

  const targetOrderItemId = orderItemId || batches[0].orderItemId;

  try {
  const result = await prisma.$transaction(async (tx) => {
    const blendedBatch = await tx.roastingBatch.create({
      data: {
        orderItemId: targetOrderItemId,
        batchNumber: blendedBatchNumber,
        greenBeanQuantity: greenTotal,
        roastedBeanQuantity: roastedTotal,
        wasteQuantity: wasteTotal,
        status: commonStatus,
        isBlend: true,
        blendTiming,
        roastProfile: batches.map((b) => b.roastProfile).filter(Boolean).join(" + ") || null,
      },
    });

    await tx.roastingBatch.updateMany({
      where: { id: { in: batchIds } },
      data: { status: "Blended", parentBatchId: blendedBatch.id },
    });

    await tx.blendIngredient.createMany({
      data: batchIds.map((sourceBatchId: string) => ({
        sourceBatchId,
        targetBlendBatchId: blendedBatch.id,
        quantityUsed: batches.find((b) => b.id === sourceBatchId)!.roastedBeanQuantity,
      })),
    });

    return tx.roastingBatch.findUnique({
      where: { id: blendedBatch.id },
      include: {
        childBatches: { select: { id: true, batchNumber: true, roastedBeanQuantity: true } },
        blendInputs: { select: { id: true, sourceBatchId: true, quantityUsed: true } },
        orderItem: { include: { order: { include: { customer: true } } } },
      },
    });
  });

  return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
