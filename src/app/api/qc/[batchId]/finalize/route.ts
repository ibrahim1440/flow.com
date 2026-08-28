import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";

type Params = { params: Promise<{ batchId: string }> };

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("qc", "manage");
  if (error) return error;

  const { batchId } = await params;
  const { outcome, finalDecisionReason } = await request.json() as {
    outcome: "Passed" | "Rejected";
    finalDecisionReason?: string;
  };

  if (outcome !== "Passed" && outcome !== "Rejected") {
    return NextResponse.json({ error: "outcome must be 'Passed' or 'Rejected'" }, { status: 400 });
  }

  try {
    const batch = await prisma.roastingBatch.findUnique({
      where: { id: batchId },
      include: { qcRecords: { select: { decision: true } } },
    });
    if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

    if (batch.qcRecords.length === 0) {
      return NextResponse.json({ error: "No QC records submitted yet" }, { status: 400 });
    }

    if (outcome === "Passed") {
      const hasAccept = batch.qcRecords.some((r) => r.decision === "Accept");
      if (!hasAccept) {
        return NextResponse.json(
          { error: "Cannot pass a batch without at least one accepted QC record." },
          { status: 409 }
        );
      }
      const hasReject = batch.qcRecords.some((r) => r.decision === "Reject");
      if (hasReject) {
        if (!finalDecisionReason?.trim()) {
          return NextResponse.json(
            { error: "Final decision reason is required when passing a batch with rejected QC records." },
            { status: 400 }
          );
        }
      }
    }

    if (!isValidTransition(batch.status, outcome)) {
      return NextResponse.json(
        { error: `Cannot transition batch from "${batch.status}" to "${outcome}".` },
        { status: 409 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.roastingBatch.update({
        where: { id: batchId },
        data: {
          status: outcome,
          qcClosedById: user.id,
          qcToken: null,
          qcFinalDecisionReason: finalDecisionReason?.trim() || null,
        },
      });

      // A stock batch has no order item whose production status could change.
      if (batch.orderItemId) await recalcOrderItemStatus(batch.orderItemId, tx);

      if (batch.productionOrderId) {
        await recalcProductionOrderStatus(batch.productionOrderId, tx);
      }
    });

    const acceptCount = batch.qcRecords.filter((r) => r.decision === "Accept").length;
    const rejectCount = batch.qcRecords.length - acceptCount;
    return NextResponse.json({ status: outcome, total: batch.qcRecords.length, acceptCount, rejectCount });
  } catch (err) {
    return handlePrismaError(err);
  }
}
