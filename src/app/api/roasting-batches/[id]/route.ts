import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Params) {
  const { error, user } = await requireSub("production", "cancel_batch");
  if (error) return error;

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const restock = searchParams.get("restock") === "true";

  const batch = await prisma.roastingBatch.findUnique({
    where: { id },
    select: { orderItemId: true, greenBeanId: true, greenBeanQuantity: true },
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

    // 2. Delete batch (QcRecords cascade via schema onDelete: Cascade)
    await tx.roastingBatch.delete({ where: { id } });

    // 3. Recalculate order item status after deletion (service re-queries the DB)
    await recalcOrderItemStatus(batch.orderItemId, tx);
  });

  return NextResponse.json({ success: true });
  } catch (err) { return handlePrismaError(err); }
}
