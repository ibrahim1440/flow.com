import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";

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

  if (totalPackagedKg > batch.roastedBeanQuantity + MARGIN) {
    return NextResponse.json(
      { error: `Total packaged weight (${totalPackagedKg}kg) would exceed roasted quantity (${batch.roastedBeanQuantity}kg).` },
      { status: 400 }
    );
  }

  const fullyPackaged = totalPackagedKg >= batch.roastedBeanQuantity - MARGIN;
  const status = fullyPackaged ? "Packaged" : "Partially Packaged";

  const updated = await prisma.roastingBatch.update({
    where: { id },
    data: {
      bags3kg: newBags3kg,
      bags1kg: newBags1kg,
      bags250g: newBags250g,
      bags150g: newBags150g,
      samplesGrams: newSamplesGrams,
      status,
    },
  });

  return NextResponse.json(updated);
}
