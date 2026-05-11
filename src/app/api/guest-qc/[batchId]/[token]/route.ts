import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ batchId: string; token: string }> };

async function getBatch(batchId: string, token: string) {
  const batch = await prisma.roastingBatch.findUnique({
    where: { id: batchId },
    include: {
      greenBean: true,
      orderItem: { include: { order: { include: { customer: true } } } },
    },
  });
  if (!batch || batch.qcToken !== token) return null;
  return batch;
}

export async function GET(_request: Request, { params }: Params) {
  const { batchId, token } = await params;
  const batch = await getBatch(batchId, token);
  if (!batch) return NextResponse.json({ error: "Invalid or expired link" }, { status: 404 });

  return NextResponse.json({
    batchNumber: batch.batchNumber,
    origin: batch.greenBean?.beanType || batch.orderItem.beanTypeName,
    processing: batch.greenBean?.process || "",
    roastedKg: batch.roastedBeanQuantity,
    status: batch.status,
    isOpen: batch.status === "Pending QC",
  });
}

export async function POST(request: Request, { params }: Params) {
  const { batchId, token } = await params;
  const batch = await getBatch(batchId, token);
  if (!batch) return NextResponse.json({ error: "Invalid or expired link" }, { status: 404 });
  if (batch.status !== "Pending QC") {
    return NextResponse.json({ error: "This batch is no longer open for QC submissions" }, { status: 409 });
  }

  const { testerName, decision, color, remarks, underDeveloped, overDeveloped } = await request.json();

  if (!testerName?.trim()) {
    return NextResponse.json({ error: "Tester name is required" }, { status: 400 });
  }

  try { const record = await prisma.qcRecord.create({
    data: {
      batchId,
      isExternal: true,
      testerName: testerName.trim(),
      decision: decision === "Reject" ? "Reject" : "Accept",
      coffeeOrigin: batch.greenBean?.beanType || batch.orderItem.beanTypeName,
      processing: batch.greenBean?.process || "",
      serialNumber: batch.batchNumber,
      onProfile: decision !== "Reject",
      underDeveloped: underDeveloped ?? false,
      overDeveloped: overDeveloped ?? false,
      color: color ? parseInt(color) : null,
      remarks: remarks || null,
    },
  });

  return NextResponse.json({ id: record.id, decision: record.decision }, { status: 201 });
  } catch (err) { return handlePrismaError(err); }
}
