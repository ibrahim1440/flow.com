import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";

type Params = { params: Promise<{ batchId: string }> };

export async function POST(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("qc", "manage");
  if (error) return error;

  const { batchId } = await params;

  const batch = await prisma.roastingBatch.findUnique({
    where: { id: batchId },
    include: { qcRecords: true },
  });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  if (batch.status !== "Pending QC") {
    return NextResponse.json({ error: "Batch is already finalized" }, { status: 409 });
  }

  const total = batch.qcRecords.length;
  if (total === 0) {
    return NextResponse.json({ error: "No QC records submitted yet" }, { status: 400 });
  }

  const acceptCount = batch.qcRecords.filter((r) => r.decision === "Accept").length;
  // >50% Accept → Passed; otherwise → Rejected
  const passed = acceptCount > total / 2;
  const newStatus = passed ? "Passed" : "Rejected";

  await prisma.roastingBatch.update({
    where: { id: batchId },
    data: {
      status: newStatus,
      qcClosedById: user.id,
    },
  });

  return NextResponse.json({
    status: newStatus,
    total,
    acceptCount,
    rejectCount: total - acceptCount,
  });
}
