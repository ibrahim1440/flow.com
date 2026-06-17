import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";

export async function GET(request: Request) {
  const { error } = await requireAnyModule("production", "qc", "packaging");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("q") ?? "";
  const q = raw.trim();

  if (!q) {
    return NextResponse.json(
      { error: "Query parameter 'q' is required and must be at least 8 characters." },
      { status: 400 }
    );
  }
  if (q.length < 8) {
    return NextResponse.json(
      { error: "Query parameter 'q' must be at least 8 characters." },
      { status: 400 }
    );
  }
  if (q.length > 30) {
    return NextResponse.json(
      { error: "Query parameter 'q' must be at most 30 characters." },
      { status: 400 }
    );
  }

  const [currentBatches, historyEntries] = await Promise.all([
    prisma.roastingBatch.findMany({
      where: { batchNumber: q },
      select: {
        id: true,
        batchNumber: true,
        date: true,
        status: true,
        greenBean: { select: { beanType: true } },
        orderItem: { select: { beanTypeName: true } },
      },
    }),
    prisma.batchSerialHistory.findMany({
      where: { oldBatchNumber: q },
      orderBy: { changedAt: "desc" },
      select: {
        oldBatchNumber: true,
        newBatchNumber: true,
        changedAt: true,
        reason: true,
        batch: {
          select: {
            id: true,
            batchNumber: true,
            date: true,
            status: true,
            greenBean: { select: { beanType: true } },
            orderItem: { select: { beanTypeName: true } },
          },
        },
      },
    }),
  ]);

  const currentMatches = currentBatches.map((b) => ({
    id: b.id,
    batchNumber: b.batchNumber,
    date: b.date.toISOString(),
    status: b.status,
    beanType: b.greenBean?.beanType ?? b.orderItem.beanTypeName ?? null,
  }));

  const superseded = historyEntries.map((h) => ({
    oldBatchNumber: h.oldBatchNumber,
    newBatchNumber: h.newBatchNumber,
    batchId: h.batch.id,
    currentBatchNumber: h.batch.batchNumber,
    date: h.batch.date.toISOString(),
    status: h.batch.status,
    beanType: h.batch.greenBean?.beanType ?? h.batch.orderItem.beanTypeName ?? null,
    changedAt: h.changedAt.toISOString(),
    reason: h.reason ?? null,
  }));

  return NextResponse.json({
    found: currentMatches.length > 0 || superseded.length > 0,
    query: q,
    currentMatches,
    superseded,
  });
}
