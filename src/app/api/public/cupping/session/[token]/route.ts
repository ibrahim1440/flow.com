import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import { extractIp } from "@/lib/rate-limit";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";
import { CuppingRefusal, guestKey, lockOpenSessionForScore, normalizeGuestName } from "@/lib/cupping/close-policy";

type Params = { params: Promise<{ token: string }> };

export async function GET(request: Request, { params }: Params) {
  const ip = extractIp(request);
  const { limited } = await checkAndRecordRateLimit({
    scope: "cupping_session_get",
    key: ip,
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return NextResponse.json(
      { error: "Too many requests. Try again later." },
      { status: 429 }
    );
  }

  const { token } = await params;

  // Use include (not top-level select) so Prisma returns ALL related
  // sessionBatches rows — mixing select+orderBy on a nested relation
  // inside a parent select can cause only the first row to be returned.
  const session = await prisma.cuppingSession.findUnique({
    where: { sessionToken: token },
    include: {
      sessionBatches: {
        orderBy: { order: "asc" },
      },
    },
  });

  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Blind projection — guests see only id and order, no bean/batch names
  return NextResponse.json({
    id: session.id,
    name: session.name,
    status: session.status,
    sessionBatches: session.sessionBatches.map(({ id, order }) => ({ id, order })),
  });
}

export async function POST(request: Request, { params }: Params) {
  const ip = extractIp(request);
  const { limited } = await checkAndRecordRateLimit({
    scope: "cupping_session_post",
    key: ip,
    limit: 20,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return NextResponse.json(
      { error: "Too many requests. Try again later." },
      { status: 429 }
    );
  }

  const { token } = await params;

  const session = await prisma.cuppingSession.findUnique({
    where: { sessionToken: token },
    select: { id: true, status: true },
  });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (session.status !== "Open") return NextResponse.json({ error: "Session is closed" }, { status: 409 });

  const data = await request.json();
  const { sessionBatchId, externalName, ...scoreData } = data;
  const name = normalizeGuestName(externalName);

  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!sessionBatchId) return NextResponse.json({ error: "sessionBatchId is required" }, { status: 400 });

  // Verify the sessionBatch belongs to this session
  const sessionBatch = await prisma.cuppingSessionBatch.findFirst({
    where: { id: sessionBatchId, sessionId: session.id },
  });
  if (!sessionBatch) return NextResponse.json({ error: "Invalid cup" }, { status: 400 });

  try {
    const score = await prisma.$transaction(async (tx) => {
      if (!(await lockOpenSessionForScore(tx, session.id))) throw new CuppingRefusal(409, "CUPPING_SESSION_CLOSED", "Session is closed");
      // One score per cup per guest name. The name is compared normalized (trimmed, inner
      // spaces collapsed, case-insensitive) so «Sara» and « sara » are the same guest. A
      // transaction-scoped advisory lock on (cup, name) makes two simultaneous submissions
      // of the same name queue, so the second sees the first. Guest scores never count
      // toward the close minimum (E6, C-3).
      const key = guestKey(name);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cupping-guest|${sessionBatchId}|${key}`}))`;
      const prior = await tx.cuppingScore.findMany({
        where: { sessionBatchId, employeeId: null, externalName: { not: null } },
        select: { externalName: true },
      });
      if (prior.some((p) => guestKey(p.externalName ?? "") === key)) {
        throw new CuppingRefusal(409, "CUPPING_ALREADY_SCORED", "You have already scored this cup");
      }
      return tx.cuppingScore.create({
        data: {
          sessionId: session.id,
          sessionBatchId,
          employeeId: null,
          externalName: name,
          fragranceAroma: scoreData.fragranceAroma,
          flavor:         scoreData.flavor,
          aftertaste:     scoreData.aftertaste,
          acidity:        scoreData.acidity,
          body:           scoreData.body,
          balance:        scoreData.balance,
          overall:        scoreData.overall,
          uniformity:     scoreData.uniformity,
          cleanCup:       scoreData.cleanCup,
          sweetness:      scoreData.sweetness,
          defectCups:     scoreData.defectCups,
          defectType:     scoreData.defectType,
          finalScore:     scoreData.finalScore,
          notes:          scoreData.notes || null,
          flavorDescriptors: scoreData.flavorDescriptors ?? [],
        },
      });
    });
    return NextResponse.json(score, { status: 201 });
  } catch (err) {
    if (err instanceof CuppingRefusal) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    return handlePrismaError(err);
  }
}
