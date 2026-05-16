import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";

const MARGIN = 0.1;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireModule("packaging");
  if (error) return error;

  const { id } = await params;
  const batch = await prisma.roastingBatch.findUnique({ where: { id } });

  if (!batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  if (batch.status !== "Passed" && batch.status !== "Partially Packaged") {
    return NextResponse.json(
      { error: `Cannot package batch with status "${batch.status}". Only QC-passed or partially packaged batches can be packaged.` },
      { status: 400 }
    );
  }

  try {
    const data = await request.json();
    const { bags3kg, bags1kg, bags250g, bags150g, samplesGrams } = data;

    const newBags3kg = (batch.bags3kg || 0) + (bags3kg || 0);
    const newBags1kg = (batch.bags1kg || 0) + (bags1kg || 0);
    const newBags250g = (batch.bags250g || 0) + (bags250g || 0);
    const newBags150g = (batch.bags150g || 0) + (bags150g || 0);
    const newSamplesGrams = (batch.samplesGrams || 0) + (samplesGrams || 0);

    const totalPackagedKg = +(
      newBags3kg * 3 +
      newBags1kg * 1 +
      newBags250g * 0.25 +
      newBags150g * 0.15 +
      newSamplesGrams / 1000
    ).toFixed(3);

    // Weight of only the bags submitted in THIS request — used for the ledger delta
    const deltaKg = +(
      (bags3kg || 0) * 3 +
      (bags1kg || 0) * 1 +
      (bags250g || 0) * 0.25 +
      (bags150g || 0) * 0.15 +
      (samplesGrams || 0) / 1000
    ).toFixed(3);

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

      if (batch.productId) {
        const lot = await tx.finishedGoodsLot.upsert({
          where: { roastingBatchId: batch.id },
          create: {
            productId: batch.productId,
            batchNumber: batch.batchNumber,
            roastingBatchId: batch.id,
            quantityKg: batch.roastedBeanQuantity,
            availableQty: totalPackagedKg,
            status: "AVAILABLE",
          },
          update: {
            availableQty: totalPackagedKg,
          },
        });

        await tx.inventoryMovement.create({
          data: {
            type: "IN",
            category: "FINISHED_GOODS",
            referenceEntityId: lot.id,
            quantityChanged: deltaKg,
            // previousQuantity is totalPackagedKg - deltaKg:
            //   first run  → totalPackaged == delta → previous = 0
            //   subsequent → previous = accumulated total before this run
            previousQuantity: +(totalPackagedKg - deltaKg).toFixed(3),
            newQuantity: totalPackagedKg,
            sourceDocType: "PACKING",
            sourceDocId: batch.id,
            userId: null,
            notes: null,
          },
        });
      }

      return updatedBatch;
    });

    return NextResponse.json(updated);
  } catch (err) {
    return handlePrismaError(err);
  }
}
