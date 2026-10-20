import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { nextBlendBatchNumber, nextRoastBatchNumber } from "@/lib/services/batch-number";

type Params = { params: Promise<{ id: string }> };

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
      isBlend: true,
      date: true,
      parentBatchId: true,
      parentBatch: { select: { id: true, batchNumber: true, date: true } },
    },
  });

  if (!batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  const oldBatchNumber = batch.batchNumber;
  let newBatchNumber = oldBatchNumber;

  // Gap G22: the serial for the new day comes from the same generator a new roast (or blend)
  // uses — the Riyadh day, the day's MAX, under its advisory lock, inside the transaction —
  // instead of a count of the same bean's batches that day, which could repeat another bean's
  // serial and raced without a lock.
  await prisma.$transaction(async (tx) => {
    newBatchNumber = batch.isBlend
      ? await nextBlendBatchNumber(tx, targetDate, id)
      : await nextRoastBatchNumber(tx, targetDate, id);
    const serialChanged = oldBatchNumber !== newBatchNumber;
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
