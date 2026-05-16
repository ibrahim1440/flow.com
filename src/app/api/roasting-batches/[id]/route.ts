import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Params) {
  const { error, user } = await requireSub("production", "cancel_batch");
  if (error) return error;

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const restock = searchParams.get("restock") === "true";

  const batch = await prisma.roastingBatch.findUnique({
    where: { id },
    include: { orderItem: { include: { roastingBatches: { select: { id: true, status: true, roastedBeanQuantity: true, greenBeanQuantity: true, isBlend: true } } } } },
  });

  if (!batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  // Restocking after roasting requires the inventory.override permission
  if (restock && batch.greenBeanId) {
    if (!hasSubPrivilege(user!.permissions, "inventory", "override")) {
      return NextResponse.json(
        { error: "You do not have permission to override inventory" },
        { status: 403 }
      );
    }
  }

  try { await prisma.$transaction(async (tx) => {
    // 1. Restock green beans if requested
    if (restock && batch.greenBeanId && batch.greenBeanQuantity > 0) {
      await tx.greenBean.update({
        where: { id: batch.greenBeanId },
        data: { quantityKg: { increment: batch.greenBeanQuantity } },
      });
    }

    // 2. Reverse order item production status
    if (batch.orderItem) {
      const COMPLETION_STATUSES = ["Passed", "Partially Packaged", "Packaged", "Blended"];
      const ACTIVE_STATUSES = ["Pending QC", "Passed", "Partially Packaged", "Packaged", "Blended"];
      const remainingActive = batch.orderItem.roastingBatches.filter(
        (b) => b.id !== id && ACTIVE_STATUSES.includes(b.status)
      );
      const completionTotal = remainingActive
        .filter(b => COMPLETION_STATUSES.includes(b.status) && !b.isBlend)
        .reduce((sum, b) => sum + (b.roastedBeanQuantity > 0 ? b.roastedBeanQuantity : b.greenBeanQuantity), 0);
      const newStatus =
        remainingActive.length === 0
          ? "Pending"
          : completionTotal >= batch.orderItem.quantityKg
          ? "Completed"
          : "In Production";

      await tx.orderItem.update({
        where: { id: batch.orderItemId },
        data: { productionStatus: newStatus },
      });
    }

    // 3. Delete batch (QcRecords cascade via schema onDelete: Cascade)
    await tx.roastingBatch.delete({ where: { id } });
  });

  return NextResponse.json({ success: true });
  } catch (err) { return handlePrismaError(err); }
}
