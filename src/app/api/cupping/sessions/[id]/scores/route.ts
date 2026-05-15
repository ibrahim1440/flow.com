import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;

  const { id } = await params;

  const session = await prisma.cuppingSession.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const scores = await prisma.cuppingScore.findMany({
    where: { sessionId: id },
    include: { employee: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });

  if (session.status === "Open") {
    return NextResponse.json({ scores: scores.filter((s) => s.employeeId === user.id), blind: true });
  }

  return NextResponse.json({ scores, blind: false });
}

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;

  const { id } = await params;

  const session = await prisma.cuppingSession.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (session.status !== "Open") {
    return NextResponse.json({ error: "Session is closed" }, { status: 409 });
  }

  const data = await request.json();
  const sessionBatchId: string | null = data.sessionBatchId ?? null;

  // For multi-cup sessions the duplicate check is per-cup (sessionBatchId);
  // for legacy single-cup sessions it's per-session.
  const existing = await prisma.cuppingScore.findFirst({
    where: sessionBatchId
      ? { sessionId: id, employeeId: user.id, sessionBatchId }
      : { sessionId: id, employeeId: user.id, sessionBatchId: null },
  });
  if (existing) {
    return NextResponse.json({ error: "You have already scored this cup" }, { status: 409 });
  }

  try { const score = await prisma.cuppingScore.create({
    data: {
      sessionId: id,
      sessionBatchId,
      employeeId: user.id,
      fragranceAroma: data.fragranceAroma,
      flavor: data.flavor,
      aftertaste: data.aftertaste,
      acidity: data.acidity,
      body: data.body,
      balance: data.balance,
      overall: data.overall,
      uniformity: data.uniformity,
      cleanCup: data.cleanCup,
      sweetness: data.sweetness,
      defectCups: data.defectCups,
      defectType: data.defectType,
      finalScore: data.finalScore,
      notes: data.notes || null,
      flavorDescriptors: data.flavorDescriptors ?? [],
    },
    include: { employee: { select: { id: true, name: true } } },
  });

  return NextResponse.json(score, { status: 201 });
  } catch (err) { return handlePrismaError(err); }
}
