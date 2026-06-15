import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";

type Params = { params: Promise<{ id: string }> };

async function generateBatchNumberForDate(
  greenBeanId: string | null | undefined,
  targetDate: Date,
  excludeBatchId: string
): Promise<string> {
  const dateStr = targetDate.toISOString().slice(0, 10).replace(/-/g, "");
  const dayStart = new Date(targetDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(targetDate);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const existing = await prisma.roastingBatch.findMany({
    where: {
      greenBeanId: greenBeanId ?? null,
      date: { gte: dayStart, lte: dayEnd },
      id: { not: excludeBatchId },
    },
    select: { id: true },
  });

  return `${dateStr}${String(existing.length + 1).padStart(2, "0")}`;
}

export async function PATCH(request: Request, { params }: Params) {
  const { error, user } = await requireSub("production", "edit_date");
  if (error) return error;

  const { id } = await params;
  const body = await request.json();
  const { newDate, reason } = body as { newDate?: string; reason?: string };

  if (!newDate) {
    return NextResponse.json({ error: "newDate required" }, { status: 400 });
  }

  if (!reason || !String(reason).trim()) {
    return NextResponse.json(
      { error: "Reason is required when changing the batch serial number." },
      { status: 400 }
    );
  }

  const targetDate = new Date(newDate);
  if (isNaN(targetDate.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }
  // Anchor to noon UTC so locale-to-UTC conversion never shifts the day
  targetDate.setUTCHours(12, 0, 0, 0);

  const batch = await prisma.roastingBatch.findUnique({
    where: { id },
    select: {
      id: true,
      batchNumber: true,
      greenBeanId: true,
      date: true,
      parentBatchId: true,
      parentBatch: { select: { id: true, batchNumber: true, date: true } },
    },
  });

  if (!batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  const oldBatchNumber = batch.batchNumber;
  const newBatchNumber = await generateBatchNumberForDate(batch.greenBeanId, targetDate, id);
  const serialChanged = oldBatchNumber !== newBatchNumber;

  await prisma.$transaction(async (tx) => {
    await tx.roastingBatch.update({
      where: { id },
      data: { batchNumber: newBatchNumber, date: targetDate },
    });

    if (serialChanged) {
      await tx.batchSerialHistory.create({
        data: {
          batchId: id,
          greenBeanId: batch.greenBeanId ?? null,
          oldBatchNumber,
          newBatchNumber,
          reason: String(reason).trim(),
          changedById: user.id,
          changedByName: user.name,
        },
      });
    }
  });

  const newDateLaterThanParent = batch.parentBatch
    ? targetDate > batch.parentBatch.date
    : false;

  return NextResponse.json({
    batchNumber: newBatchNumber,
    oldBatchNumber,
    oldDate: batch.date.toISOString(),
    userName: user.name,
    parentBatch: batch.parentBatch
      ? { id: batch.parentBatch.id, batchNumber: batch.parentBatch.batchNumber }
      : null,
    newDateLaterThanParent,
  });
}
