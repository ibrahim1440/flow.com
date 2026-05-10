import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";

export async function GET() {
  const { error } = await requireAuth();
  if (error) return error;

  const sessions = await prisma.cuppingSession.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { scores: true } },
      batch: { select: { batchNumber: true } },
      greenBean: { select: { serialNumber: true, beanType: true } },
    },
  });

  return NextResponse.json(sessions);
}

export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;

  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { name, batchId, greenBeanId } = await request.json();

  if (!name?.trim()) {
    return NextResponse.json({ error: "Session name is required" }, { status: 400 });
  }

  const session = await prisma.cuppingSession.create({
    data: {
      name: name.trim(),
      batchId: batchId || null,
      greenBeanId: greenBeanId || null,
    },
    include: {
      _count: { select: { scores: true } },
      batch: { select: { batchNumber: true } },
      greenBean: { select: { serialNumber: true, beanType: true } },
    },
  });

  return NextResponse.json(session, { status: 201 });
}
