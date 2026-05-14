import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";

const COMPLETION_STATUSES = ["Passed", "Partially Packaged", "Packaged", "Blended"];
const ACTIVE_STATUSES = ["Pending QC", "Passed", "Partially Packaged", "Packaged", "Blended"];

export async function POST(request: Request) {
  const { user, error } = await requireSub("qc", "manage");
  if (error) return error;

  const { batchIds, outcome } = await request.json() as { batchIds: string[]; outcome: "Passed" | "Rejected" };

  if (!Array.isArray(batchIds) || batchIds.length === 0)
    return NextResponse.json({ error: "batchIds must be a non-empty array" }, { status: 400 });
  if (outcome !== "Passed" && outcome !== "Rejected")
    return NextResponse.json({ error: "outcome must be Passed or Rejected" }, { status: 400 });

  try {
    // Load all batches upfront to validate transitions before opening the transaction
    const batches = await prisma.roastingBatch.findMany({
      where: { id: { in: batchIds } },
      select: { id: true, status: true, orderItemId: true },
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

    // Collect unique orderItemIds so we recalculate each only once
    const orderItemIds = [...new Set(batches.map((b) => b.orderItemId))];

    await prisma.$transaction(async (tx) => {
      // 1. Update all batch statuses
      await tx.roastingBatch.updateMany({
        where: { id: { in: batchIds } },
        data: { status: outcome, qcClosedById: user.id },
      });

      // 2. Recalculate productionStatus for each affected order item
      for (const orderItemId of orderItemIds) {
        const orderItem = await tx.orderItem.findUnique({
          where: { id: orderItemId },
          select: { quantityKg: true },
        });
        if (!orderItem) continue;

        const allBatches = await tx.roastingBatch.findMany({
          where: { orderItemId },
          select: { status: true, roastedBeanQuantity: true, greenBeanQuantity: true },
        });

        const hasActive = allBatches.some((b) => ACTIVE_STATUSES.includes(b.status));
        const completionTotal = allBatches
          .filter((b) => COMPLETION_STATUSES.includes(b.status))
          .reduce((sum, b) => sum + (b.roastedBeanQuantity > 0 ? b.roastedBeanQuantity : b.greenBeanQuantity), 0);

        const itemStatus = !hasActive
          ? "Pending"
          : completionTotal >= orderItem.quantityKg
          ? "Completed"
          : "In Production";

        await tx.orderItem.update({
          where: { id: orderItemId },
          data: { productionStatus: itemStatus },
        });
      }
    });

    return NextResponse.json({ finalized: batchIds.length, outcome });
  } catch (err) {
    return handlePrismaError(err);
  }
}
