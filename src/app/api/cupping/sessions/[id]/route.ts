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
      scores: {
        include: { employee: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Blind mode: while Open, only return the current user's own score
  if (session.status === "Open") {
    const myScore = session.scores.find((s) => s.employeeId === user.id) ?? null;
    return NextResponse.json({ ...session, scores: myScore ? [myScore] : [], blind: true });
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
