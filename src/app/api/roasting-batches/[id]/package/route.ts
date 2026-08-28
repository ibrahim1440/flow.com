import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";
import {
  ALLOCATABLE_ITEM_SELECT,
  outstandingForItem,
  reserveShelfStock,
} from "@/lib/services/shelf-allocation";

const MARGIN = 0.1;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireEdit("packaging");
  if (error) return error;

  const { id } = await params;
  const batch = await prisma.roastingBatch.findUnique({
    where: { id },
    include: {
      orderItem: {
        select: {
          productId:    true,
          productSkuId: true,
        },
      },
    },
  });

  if (!batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  // Read body before effectiveProductId resolution so body.productId can serve as fallback
  // for bulk/custom orders where neither the batch nor the order item carries a product.
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { body = {}; }

  const effectiveProductId =
    batch.productId ??
    batch.orderItem?.productId ??
    (typeof body.productId === "string" && body.productId ? body.productId : null);

  const effectiveProductSkuId =
    batch.orderItem?.productSkuId ??
    (typeof body.productSkuId === "string" && body.productSkuId ? body.productSkuId : null);

  if (!effectiveProductId) {
    return NextResponse.json(
      { error: "Cannot package batch: select a product for this order." },
      { status: 400 }
    );
  }

  // Validate body.productId against DB only when it is the fallback source
  if (!batch.productId && !batch.orderItem?.productId && body.productId) {
    const product = await prisma.coffeeProduct.findUnique({ where: { id: effectiveProductId } });
    if (!product) return NextResponse.json({ error: "Product not found." }, { status: 400 });
  }

  if (batch.status !== "Passed" && batch.status !== "Partially Packaged") {
    return NextResponse.json(
      { error: `Cannot package batch with status "${batch.status}". Only QC-passed or partially packaged batches can be packaged.` },
      { status: 400 }
    );
  }

  try {
    const b3   = Number(body.bags3kg      ?? 0);
    const b1   = Number(body.bags1kg      ?? 0);
    const b250 = Number(body.bags250g     ?? 0);
    const b150 = Number(body.bags150g     ?? 0);
    const samp = Number(body.samplesGrams ?? 0);

    const inputChecks: [string, number][] = [
      ["bags3kg", b3], ["bags1kg", b1], ["bags250g", b250], ["bags150g", b150], ["samplesGrams", samp],
    ];
    for (const [name, val] of inputChecks) {
      if (!Number.isFinite(val) || val < 0) {
        return NextResponse.json({ error: `${name} must be a non-negative number.` }, { status: 400 });
      }
    }

    const newBags3kg      = (batch.bags3kg      || 0) + b3;
    const newBags1kg      = (batch.bags1kg      || 0) + b1;
    const newBags250g     = (batch.bags250g     || 0) + b250;
    const newBags150g     = (batch.bags150g     || 0) + b150;
    const newSamplesGrams = (batch.samplesGrams || 0) + samp;

    const totalPackagedKg = +(
      newBags3kg * 3 +
      newBags1kg * 1 +
      newBags250g * 0.25 +
      newBags150g * 0.15 +
      newSamplesGrams / 1000
    ).toFixed(3);

    // Weight of only the bags submitted in THIS request — used for the ledger delta
    const deltaKg = +(b3 * 3 + b1 * 1 + b250 * 0.25 + b150 * 0.15 + samp / 1000).toFixed(3);

    if (deltaKg <= 0) {
      return NextResponse.json({ error: "At least one package quantity must be greater than zero." }, { status: 400 });
    }

    if (totalPackagedKg > batch.roastedBeanQuantity + MARGIN) {
      return NextResponse.json(
        { error: `Total packaged weight (${totalPackagedKg}kg) would exceed roasted quantity (${batch.roastedBeanQuantity}kg).` },
        { status: 400 }
      );
    }

    const fullyPackaged = totalPackagedKg >= batch.roastedBeanQuantity - MARGIN;
    const newStatus = fullyPackaged ? "Packaged" : "Partially Packaged";

    if (!isValidTransition(batch.status, newStatus)) {
      return NextResponse.json(
        { error: `Cannot transition batch from "${batch.status}" to "${newStatus}".` },
        { status: 409 }
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedBatch = await tx.roastingBatch.update({
        where: { id },
        data: {
          bags3kg: newBags3kg, bags1kg: newBags1kg, bags250g: newBags250g,
          bags150g: newBags150g, samplesGrams: newSamplesGrams, status: newStatus,
        },
      });

      const lot = await tx.finishedGoodsLot.upsert({
        where: { roastingBatchId: batch.id },
        create: {
          productId:       effectiveProductId,
          productSkuId:    effectiveProductSkuId,
          batchNumber:     batch.batchNumber,
          roastingBatchId: batch.id,
          quantityKg:      batch.roastedBeanQuantity,
          availableQty:    totalPackagedKg,
          status:          "AVAILABLE",
        },
        update: {
          availableQty: totalPackagedKg,
        },
      });

      await tx.inventoryMovement.create({
        data: {
          type:              "IN",
          category:          "FINISHED_GOODS",
          referenceEntityId: lot.id,
          quantityChanged:   deltaKg,
          // previousQuantity is totalPackagedKg - deltaKg:
          //   first run  → totalPackaged == delta → previous = 0
          //   subsequent → previous = accumulated total before this run
          previousQuantity:  +(totalPackagedKg - deltaKg).toFixed(3),
          newQuantity:       totalPackagedKg,
          sourceDocType:     "PACKING",
          sourceDocId:       batch.id,
          userId:            user.id,
          notes:             null,
        },
      });

      // ── Claim the packaged coffee for the order it was roasted for ──────────
      // Reserving here is what keeps the shelf honest: only the genuine surplus — coffee
      // beyond what this order still needs — stays free for other orders to draw on,
      // which is exactly what the orders screen already calls "surplus to inventory".
      //
      // A stock batch has no order item at all. Nothing is reserved, so its whole output
      // lands on the shelf free-to-promise — which is the entire point of roasting to
      // stock, and the only way the shelf gets filled on purpose rather than by accident.
      const owner = batch.orderItemId
        ? await tx.orderItem.findUnique({
            where: { id: batch.orderItemId },
            select: { ...ALLOCATABLE_ITEM_SELECT, preparationDecision: true, order: { select: { status: true } } },
          })
        : null;
      // A cancelled or blocked order must not silently take stock back. Cancelling
      // releases its reservations; re-claiming them here for a batch that was already in
      // the roaster would strand the coffee on a dead order.
      const ownerIsLive =
        owner !== null &&
        owner.order.status !== "Cancelled" &&
        owner.order.status !== "Rejected" &&
        owner.preparationDecision !== "Blocked";
      if (owner && ownerIsLive) {
        const outstanding = await outstandingForItem(tx, owner);
        if (outstanding > 0) {
          await reserveShelfStock(tx, owner, outstanding, user.id);
        }
      }

      if (batch.productionOrderId) {
        await recalcProductionOrderStatus(batch.productionOrderId, tx);
      }

      return updatedBatch;
    });

    return NextResponse.json(updated);
  } catch (err) {
    return handlePrismaError(err);
  }
}
