import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";

type Params = { params: Promise<{ batchId: string }> };

export async function POST(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("qc", "manage");
  if (error) return error;

  const { batchId } = await params;

  try {
    const batch = await prisma.roastingBatch.findUnique({
      where: { id: batchId },
      include: { qcRecords: true },
    });
    if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

    const total = batch.qcRecords.length;
    if (total === 0) return NextResponse.json({ error: "No QC records submitted yet" }, { status: 400 });

    const acceptCount = batch.qcRecords.filter((r) => r.decision === "Accept").length;
    const newBatchStatus = acceptCount > total / 2 ? "Passed" : "Rejected";

    if (!isValidTransition(batch.status, newBatchStatus)) {
      return NextResponse.json(
        { error: `Cannot transition batch from "${batch.status}" to "${newBatchStatus}".` },
        { status: 409 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.roastingBatch.update({
        where: { id: batchId },
        data: { status: newBatchStatus, qcClosedById: user.id },
      });

      await recalcOrderItemStatus(batch.orderItemId, tx);
    });

    return NextResponse.json({ status: newBatchStatus, total, acceptCount, rejectCount: total - acceptCount });
  } catch (err) {
    return handlePrismaError(err);
  }
}
