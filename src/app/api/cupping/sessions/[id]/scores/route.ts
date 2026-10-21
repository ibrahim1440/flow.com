import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { CuppingRefusal, lockOpenSessionForScore } from "@/lib/cupping/close-policy";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireModule("cupping");
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
  const { user, error } = await requireEdit("cupping");
  if (error) return error;

  const { id } = await params;

  const session = await prisma.cuppingSession.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (session.status !== "Open") {
    return NextResponse.json({ error: "Session is closed" }, { status: 409 });
  }

  const data = await request.json();
  const sessionBatchId: string | null = data.sessionBatchId ?? null;

  // A staff evaluation counts toward the close minimum only as part of a complete set (owner
  // decision 3), so each one must be valid and must name a cup of THIS session: a multi-cup
  // session is scored per cup, a single-cup session without one.
  const invalid = invalidEvaluation(data);
  if (invalid) return NextResponse.json({ error: invalid, code: "CUPPING_SCORE_INVALID" }, { status: 400 });
  const cupCount = await prisma.cuppingSessionBatch.count({ where: { sessionId: id } });
  if (cupCount > 0) {
    const cup = sessionBatchId ? await prisma.cuppingSessionBatch.findFirst({ where: { id: sessionBatchId, sessionId: id }, select: { id: true } }) : null;
    if (!cup) return NextResponse.json({ error: "Choose a cup of this session.", code: "CUPPING_CUP_INVALID" }, { status: 400 });
  } else if (sessionBatchId) {
    return NextResponse.json({ error: "This session has no cups to choose.", code: "CUPPING_CUP_INVALID" }, { status: 400 });
  }

  try {
    const score = await prisma.$transaction(async (tx) => {
      // FOR SHARE on the open session: a close (FOR UPDATE) cannot count scorers while this
      // score is being written, and a score cannot land after the close (E6).
      if (!(await lockOpenSessionForScore(tx, id))) throw new CuppingRefusal(409, "CUPPING_SESSION_CLOSED", "Session is closed");
      // Same scorer, same cup: concurrent submissions queue on this lock, so the second one
      // sees the first and is refused below. (No unique index: historic duplicate rows may
      // exist and would make it fail to build.)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cupping-staff|${id}|${sessionBatchId ?? "single"}|${user.id}`}))`;
      // For multi-cup sessions the duplicate check is per-cup (sessionBatchId);
      // for legacy single-cup sessions it's per-session.
      const existing = await tx.cuppingScore.findFirst({
        where: sessionBatchId
          ? { sessionId: id, employeeId: user.id, sessionBatchId }
          : { sessionId: id, employeeId: user.id, sessionBatchId: null },
      });
      if (existing) throw new CuppingRefusal(409, "CUPPING_ALREADY_SCORED", "You have already scored this cup");

      return tx.cuppingScore.create({
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
    });
    return NextResponse.json(score, { status: 201 });
  } catch (err) {
    if (err instanceof CuppingRefusal) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    return handlePrismaError(err);
  }
}

const ATTRS = ["fragranceAroma", "flavor", "aftertaste", "acidity", "body", "balance", "overall", "uniformity", "cleanCup", "sweetness"] as const;

/** null when the evaluation is valid; otherwise a short reason. Attributes left out keep their defaults. */
function invalidEvaluation(data: Record<string, unknown>): string | null {
  const fs = data.finalScore;
  if (typeof fs !== "number" || !Number.isFinite(fs) || fs < 0 || fs > 100) return "finalScore must be a number from 0 to 100.";
  for (const k of ATTRS) {
    const v = data[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10)) return `${k} must be a number from 0 to 10.`;
  }
  const dc = data.defectCups;
  if (dc !== undefined && (typeof dc !== "number" || !Number.isInteger(dc) || dc < 0 || dc > 5)) return "defectCups must be a whole number from 0 to 5.";
  return null;
}
