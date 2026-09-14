import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Params) {
  const { error, user } = await requireSub("production", "cancel_batch");
  if (error) return error;

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const restock = searchParams.get("restock") === "true";

  const batch = await prisma.roastingBatch.findUnique({
    where: { id },
    select: { orderItemId: true, greenBeanId: true, greenBeanQuantity: true, productionOrderId: true },
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
    // 0. Lock the batch, then refuse to delete one that has packaging history.
    //
    // PackagingOperation.batchId is ON DELETE RESTRICT, so the database would stop this
    // anyway — but it would stop it with a foreign-key violation, which reaches the
    // operator as a generic "a related record is still referenced". The guard exists to
    // answer in the language of the domain instead: once coffee has physically been packed
    // out of a roast, the roast is part of the audit trail and is no longer a thing that
    // can be made to have never happened. Correcting a pack is a reversal, which this wave
    // deliberately does not implement; deletion is simply refused.
    //
    // The lock is what makes the guard race-free rather than advisory. Packaging holds
    // this same row FOR UPDATE for its whole transaction, so a pack committing concurrently
    // is either already visible to the count below, or still waiting — and once it waits,
    // it finds the batch gone and answers 404 rather than packing into a deleted roast.
    // Taking RoastingBatch first also matches the canonical hierarchy, which puts it above
    // the green-bean restock that follows.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "RoastingBatch" WHERE "id" = ${id} FOR UPDATE
    `;
    if (locked.length === 0) throw { _appCode: 404, message: "Batch not found" };

    const packagedCount = await tx.packagingOperation.count({ where: { batchId: id } });
    if (packagedCount > 0) {
      throw {
        _appCode: 409,
        message: "Batch cannot be deleted because packaging operations exist.",
      };
    }

    // Blend lineage is destroyed silently, not loudly. BlendIngredient cascades from BOTH
    // ends — sourceBatchId and targetBlendBatchId — so deleting either a batch that
    // contributed coffee to a blend, or the blend it went into, takes the rows recording the
    // transformation with it. No foreign key objects, because a cascade is not a refusal:
    // the delete simply succeeds and the record of where several batches' coffee went stops
    // existing.
    //
    // Checked under the same FOR UPDATE taken above, which is what makes it race-safe rather
    // than advisory. Blend creation locks its sources FOR UPDATE before inserting any
    // ingredient row, so a blend committing concurrently is either already visible to this
    // count, or still waiting on this lock — and once it waits, it finds the batch gone and
    // answers "One or more batches not found" instead of blending a deleted roast.
    const blendLinks = await tx.blendIngredient.count({
      where: { OR: [{ sourceBatchId: id }, { targetBlendBatchId: id }] },
    });
    if (blendLinks > 0) {
      throw {
        _appCode: 409,
        message: "Batch cannot be deleted because it is part of blend history.",
      };
    }

    // 1. Restock green beans if requested
    if (restock && batch.greenBeanId && batch.greenBeanQuantity > 0) {
      const bean = await tx.greenBean.findUnique({
        where: { id: batch.greenBeanId },
        select: { quantityKg: true },
      });
      const previousQuantity = bean!.quantityKg;

      await tx.greenBean.update({
        where: { id: batch.greenBeanId },
        data: { quantityKg: { increment: batch.greenBeanQuantity } },
      });

      await tx.inventoryMovement.create({
        data: {
          type: "IN",
          category: "RAW_MATERIAL",
          referenceEntityId: batch.greenBeanId,
          quantityChanged: batch.greenBeanQuantity,
          previousQuantity,
          newQuantity: previousQuantity + batch.greenBeanQuantity,
          sourceDocType: "ROASTING_BATCH",
          sourceDocId: id,
          userId: user!.id,
          notes: "Batch Cancellation Restock",
        },
      });
    }

    // 2. Delete batch (QcRecords cascade via schema onDelete: Cascade)
    await tx.roastingBatch.delete({ where: { id } });

    // 3. Recalculate order item and production order status after deletion.
    // A stock batch has no order item whose production status could change.
    if (batch.orderItemId) await recalcOrderItemStatus(batch.orderItemId, tx);

    if (batch.productionOrderId) {
      await recalcProductionOrderStatus(batch.productionOrderId, tx);
    }
  });

  return NextResponse.json({ success: true });
  } catch (err) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
