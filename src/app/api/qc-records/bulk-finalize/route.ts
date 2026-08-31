import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";

export async function POST(request: Request) {
  const { user, error } = await requireSub("qc", "manage");
  if (error) return error;

  const { batchIds, outcome, finalDecisionReason } = await request.json() as {
    batchIds: string[];
    outcome: "Passed" | "Rejected";
    finalDecisionReason?: string;
  };

  if (!Array.isArray(batchIds) || batchIds.length === 0)
    return NextResponse.json({ error: "batchIds must be a non-empty array" }, { status: 400 });
  if (outcome !== "Passed" && outcome !== "Rejected")
    return NextResponse.json({ error: "outcome must be Passed or Rejected" }, { status: 400 });

  try {
    // Load all batches upfront to validate transitions before opening the transaction
    const batches = await prisma.roastingBatch.findMany({
      where: { id: { in: batchIds } },
      select: {
        id: true,
        status: true,
        orderItemId: true,
        productionOrderId: true,
        qcRecords: { select: { decision: true } },
      },
    });

    if (batches.length !== batchIds.length) {
      const found = new Set(batches.map((b) => b.id));
      const missing = batchIds.filter((id) => !found.has(id));
      return NextResponse.json({ error: "Some batches not found", missing }, { status: 404 });
    }

    const invalid = batches.filter((b) => !isValidTransition(b.status, outcome));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: "Some batches cannot transition to the chosen outcome", invalid: invalid.map((b) => b.id) },
        { status: 409 }
      );
    }

    if (outcome === "Passed") {
      const noAccept = batches.filter((b) => !b.qcRecords.some((r) => r.decision === "Accept"));
      if (noAccept.length > 0) {
        return NextResponse.json(
          { error: "Cannot pass a batch without at least one accepted QC record.", batchIds: noAccept.map((b) => b.id) },
          { status: 409 }
        );
      }

      const hasAnyReject = batches.some((b) => b.qcRecords.some((r) => r.decision === "Reject"));
      if (hasAnyReject) {
        if (!finalDecisionReason?.trim()) {
          return NextResponse.json(
            { error: "Final decision reason is required when passing a batch with rejected QC records." },
            { status: 400 }
          );
        }
      }
    }

    // Collect unique IDs to recalculate each affected entity only once.
    // Stock batches contribute no order item — there is nothing to recalculate for them.
    const orderItemIds = [...new Set(
      batches.map((b) => b.orderItemId).filter((id): id is string => id !== null)
    )];
    const productionOrderIds = [
      ...new Set(batches.map((b) => b.productionOrderId).filter((id): id is string => id !== null)),
    ];

    // The status each batch was validated against, so the write can be made conditional
    // on nothing having moved underneath it.
    const expectedStatuses = [...new Set(batches.map((b) => b.status))];

    const finalized = await prisma.$transaction(async (tx) => {
      // Conditional on those statuses. The batches were read and their transitions
      // checked before the transaction opened, so without this a batch finalised by
      // somebody else in between would be silently overwritten — and the caller told
      // every batch had been finalised when one had been decided the other way.
      const updated = await tx.roastingBatch.updateMany({
        where: { id: { in: batchIds }, status: { in: expectedStatuses } },
        data: {
          status: outcome,
          qcClosedById: user.id,
          qcToken: null,
          qcFinalDecisionReason: finalDecisionReason?.trim() || null,
        },
      });

      for (const orderItemId of orderItemIds) {
        await recalcOrderItemStatus(orderItemId, tx);
      }

      for (const productionOrderId of productionOrderIds) {
        await recalcProductionOrderStatus(productionOrderId, tx);
      }

      return updated.count;
    }, TX_OPTS);

    // The real number, not the number asked for. Reporting the requested count would tell
    // the operator that a batch somebody else had already decided was finalised by them.
    return NextResponse.json({ finalized, requested: batchIds.length, outcome });
  } catch (err) {
    return handlePrismaError(err);
  }
}
