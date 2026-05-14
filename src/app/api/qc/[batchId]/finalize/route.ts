import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";

// Passed/Packaged/Blended count toward completion; Pending QC and Rejected do not
const COMPLETION_STATUSES = ["Passed", "Partially Packaged", "Packaged", "Blended"];
const ACTIVE_STATUSES = ["Pending QC", "Passed", "Partially Packaged", "Packaged", "Blended"];

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
      // 1. Update batch status
      await tx.roastingBatch.update({
        where: { id: batchId },
        data: { status: newBatchStatus, qcClosedById: user.id },
      });

      // 2. Recalculate orderItem productionStatus — a Rejected batch must revert "Completed" back
      const orderItem = await tx.orderItem.findUnique({
        where: { id: batch.orderItemId },
        select: { quantityKg: true },
      });
      if (orderItem) {
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
      }
    });

    return NextResponse.json({ status: newBatchStatus, total, acceptCount, rejectCount: total - acceptCount });
  } catch (err) {
    return handlePrismaError(err);
  }
}
