import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";

type Params = { params: Promise<{ batchId: string }> };

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("qc", "create_record");
  if (error) return error;

  const { batchId } = await params;
  const { decision, color, remarks, underDeveloped, overDeveloped, coffeeOrigin, processing, serialNumber } =
    await request.json();

  const batch = await prisma.roastingBatch.findUnique({ where: { id: batchId } });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  if (batch.status !== "Pending QC") {
    return NextResponse.json({ error: "Batch is no longer open for QC submissions" }, { status: 409 });
  }

  // Prevent duplicate submission from same employee
  const existing = await prisma.qcRecord.findFirst({
    where: { batchId, employeeId: user.id, isExternal: false },
  });
  if (existing) {
    return NextResponse.json({ error: "You have already submitted a record for this batch" }, { status: 409 });
  }

  const record = await prisma.qcRecord.create({
    data: {
      batchId,
      employeeId: user.id,
      isExternal: false,
      testerName: user.name,
      decision: decision === "Reject" ? "Reject" : "Accept",
      coffeeOrigin: coffeeOrigin || batch.batchNumber,
      processing: processing || "",
      serialNumber: serialNumber || batch.batchNumber,
      onProfile: decision !== "Reject",
      underDeveloped: underDeveloped ?? false,
      overDeveloped: overDeveloped ?? false,
      color: color ? parseInt(color) : null,
      remarks: remarks || null,
    },
    include: { employee: { select: { id: true, name: true } } },
  });

  return NextResponse.json(record, { status: 201 });
}
