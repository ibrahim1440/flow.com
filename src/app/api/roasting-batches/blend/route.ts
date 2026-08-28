import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";

export async function POST(request: Request) {
  const { error } = await requireSub("production", "blend");
  if (error) return error;

  const { batchIds, orderItemId } = await request.json();

  if (!batchIds || batchIds.length < 2) {
    return NextResponse.json({ error: "Select at least 2 batches to blend" }, { status: 400 });
  }

  const batches = await prisma.roastingBatch.findMany({
    where: { id: { in: batchIds } },
    // findMany without orderBy returns rows in unspecified order, and batches[0] below
    // decides who owns the blend. Oldest-first makes that choice deterministic.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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

  // Blending stock batches produces a stock blend: null here means the blended output
  // belongs to no order, so packaging leaves it free-to-promise on the shelf exactly as
  // it does for its inputs. An explicit orderItemId still wins, which is how a stock
  // blend can be steered onto an order.
  //
  // Where the inputs disagree — some owned by an order, some not — the order wins, and it
  // must be named explicitly. Picking silently would either orphan an order's production
  // (its coffee vanishing into free stock) or quietly claim stock for an order that never
  // asked for it, and which of the two happened would depend on row order.
  const ownedInputs = batches.filter((b) => b.orderItemId !== null);
  if (!orderItemId && ownedInputs.length > 0 && ownedInputs.length !== batches.length) {
    return NextResponse.json(
      { error: "These batches belong to different owners — some to an order, some to stock. Specify orderItemId to say which order the blend is for." },
      { status: 400 }
    );
  }
  const distinctOwners = [...new Set(ownedInputs.map((b) => b.orderItemId as string))];
  if (!orderItemId && distinctOwners.length > 1) {
    return NextResponse.json(
      { error: "These batches belong to different order items. Specify orderItemId to say which order the blend is for." },
      { status: 400 }
    );
  }

  const targetOrderItemId: string | null = orderItemId || distinctOwners[0] || null;

  // A stock blend must still name the coffee it is, for exactly the reason a stock batch
  // must: packaging has no order item to inherit a product from, and a lot nothing can
  // identify is a lot no order can ever be matched to. Inherit it from the inputs when
  // they agree; the packaging route's body.productId fallback covers the rest.
  const distinctProducts = [...new Set(batches.map((b) => b.productId).filter((id): id is string => id !== null))];
  const blendProductId = targetOrderItemId === null && distinctProducts.length === 1 ? distinctProducts[0] : null;
  if (targetOrderItemId === null && blendProductId === null) {
    return NextResponse.json(
      { error: "A stock blend must resolve to a single product. Blend batches of the same product, or blend onto an order item." },
      { status: 400 }
    );
  }

  const productionOrderIds = [
    ...new Set(
      batches
        .map((b) => b.productionOrderId)
        .filter((id): id is string => id !== null)
    ),
  ];

  try {
  const result = await prisma.$transaction(async (tx) => {
    const blendedBatch = await tx.roastingBatch.create({
      data: {
        orderItemId: targetOrderItemId,
        productId: blendProductId,
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

    for (const productionOrderId of productionOrderIds) {
      await recalcProductionOrderStatus(productionOrderId, tx);
    }

    // Every input that belonged to an order has just been flipped to "Blended", which
    // changes that item's production picture — not only the item the blend now belongs to.
    // Recalculating the target alone left the others reading a stale status.
    const affectedItemIds = [...new Set([...distinctOwners, ...(targetOrderItemId ? [targetOrderItemId] : [])])];
    for (const itemId of affectedItemIds) {
      await recalcOrderItemStatus(itemId, tx);
    }

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
