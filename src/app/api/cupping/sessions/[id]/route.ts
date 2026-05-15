import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;

  const { id } = await params;

  const session = await prisma.cuppingSession.findUnique({
    where: { id },
    include: {
      batch: { select: { batchNumber: true } },
      greenBean: { select: { serialNumber: true, beanType: true } },
      sessionBatches: {
        orderBy: { order: "asc" },
        include: {
          batch: {
            select: {
              batchNumber: true, roastProfile: true,
              greenBean: { select: { beanType: true, serialNumber: true } },
              orderItem: { select: { beanTypeName: true } },
            },
          },
        },
      },
      scores: {
        include: { employee: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Blind mode: while Open, only return the current user's own scores
  // (filter, not find — multi-cup sessions produce one score per cup)
  if (session.status === "Open") {
    const myScores = session.scores.filter((s) => s.employeeId === user.id);
    return NextResponse.json({ ...session, scores: myScores, blind: true });
  }

  return NextResponse.json({ ...session, blind: false });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;

  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { id } = await params;
  try {
    await prisma.cuppingSession.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
