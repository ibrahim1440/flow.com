import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";

export async function GET() {
  const { error } = await requireModule("qc");
  if (error) return error;

  const records = await prisma.qcRecord.findMany({
    orderBy: { date: "desc" },
    include: {
      employee: { select: { id: true, name: true } },
      batch: {
        include: {
          orderItem: { include: { order: { include: { customer: true } } } },
        },
      },
    },
  });
  return NextResponse.json(records);
}

export async function POST(request: Request) {
  const { error } = await requireSub("qc", "create_record");
  if (error) return error;

  const data = await request.json();
  const record = await prisma.qcRecord.create({
    data,
    include: { batch: true, employee: { select: { id: true, name: true } } },
  });

  if (data.onProfile) {
    await prisma.roastingBatch.update({
      where: { id: data.batchId },
      data: { status: "Passed" },
    });
  }

  return NextResponse.json(record, { status: 201 });
}
