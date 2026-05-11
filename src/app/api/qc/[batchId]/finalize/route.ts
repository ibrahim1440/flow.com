import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ batchId: string }> };

export async function POST(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("qc", "manage");
  if (error) return error;

  const { batchId } = await params;

  try {
    const batch = await prisma.roastingBatch.findUnique({
      where: { id: batchId },
      include: { qcRecords: true },
    });
    if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

    const total = batch.qcRecords.length;
    if (total === 0) return NextResponse.json({ error: "No QC records submitted yet" }, { status: 400 });

    const acceptCount = batch.qcRecords.filter((r) => r.decision === "Accept").length;
    const newStatus = acceptCount > total / 2 ? "Passed" : "Rejected";

    if (!isValidTransition(batch.status, newStatus)) {
      return NextResponse.json(
        { error: `Cannot transition batch from "${batch.status}" to "${newStatus}".` },
        { status: 409 }
      );
    }

    await prisma.roastingBatch.update({
      where: { id: batchId },
      data: { status: newStatus, qcClosedById: user.id },
    });

    return NextResponse.json({ status: newStatus, total, acceptCount, rejectCount: total - acceptCount });
  } catch (err) {
    return handlePrismaError(err);
  }
}
