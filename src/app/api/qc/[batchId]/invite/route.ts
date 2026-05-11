import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ batchId: string }> };

export async function POST(_request: Request, { params }: Params) {
  const { error } = await requireSub("qc", "manage");
  if (error) return error;

  const { batchId } = await params;

  const batch = await prisma.roastingBatch.findUnique({ where: { id: batchId } });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  if (batch.status !== "Pending QC") {
    return NextResponse.json({ error: "Batch is no longer open for QC" }, { status: 409 });
  }

  const token = batch.qcToken ?? crypto.randomUUID().replace(/-/g, "");

  try {
    if (!batch.qcToken) {
      await prisma.roastingBatch.update({ where: { id: batchId }, data: { qcToken: token } });
    }
    return NextResponse.json({ token, batchId });
  } catch (err) {
    return handlePrismaError(err);
  }
}
