import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";

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
      await tx.roastingBatch.updateMany({
        where: { id: { in: batchIds } },
        data: { status: outcome, qcClosedById: user.id },
      });

      for (const orderItemId of orderItemIds) {
        await recalcOrderItemStatus(orderItemId, tx);
      }
    });

    return NextResponse.json({ finalized: batchIds.length, outcome });
  } catch (err) {
    return handlePrismaError(err);
  }
}
