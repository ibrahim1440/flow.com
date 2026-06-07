import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireSub("qc", "view_records");
  if (error) return error;

  const { id } = await params;

  const record = await prisma.qcRecord.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!record) return NextResponse.json({ error: "QC record not found." }, { status: 404 });

  const corrections = await prisma.qcCorrectionHistory.findMany({
    where: { qcRecordId: id },
    orderBy: { changedAt: "desc" },
    include: {
      fieldChanges: {
        orderBy: { fieldName: "asc" },
      },
    },
  });

  return NextResponse.json({ corrections });
}
