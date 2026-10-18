import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import { extractIp } from "@/lib/rate-limit";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";
import { CuppingRefusal, guestKey, lockOpenSessionForScore, normalizeGuestName } from "@/lib/cupping/close-policy";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const ip = extractIp(request);
  const { limited } = await checkAndRecordRateLimit({
    scope: "cupping_score_get",
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

  const { id } = await params;

  const session = await prisma.cuppingSession.findUnique({
    where: { id },
    select: { id: true, name: true, status: true },
  });

  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(session);
}

export async function POST(request: Request, { params }: Params) {
  const ip = extractIp(request);
  const { limited } = await checkAndRecordRateLimit({
    scope: "cupping_score_post",
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

  const { id } = await params;

  const session = await prisma.cuppingSession.findUnique({
    where: { id },
    select: { id: true, status: true, _count: { select: { sessionBatches: true } } },
  });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (session.status !== "Open") {
    return NextResponse.json({ error: "Session is closed" }, { status: 409 });
  }
  // This link is the single-cup guest form. A multi-cup (blind) session is scored per cup
  // through its own session link; a cup-less score posted here would sit outside every cup.
  if (session._count.sessionBatches > 0) {
    return NextResponse.json({ error: "This session is scored through its session link.", code: "CUPPING_USE_SESSION_LINK" }, { status: 400 });
  }

  const data = await request.json();
  const externalName = normalizeGuestName(data.externalName);

  if (!externalName) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  try {
    const score = await prisma.$transaction(async (tx) => {
      if (!(await lockOpenSessionForScore(tx, id))) throw new CuppingRefusal(409, "CUPPING_SESSION_CLOSED", "Session is closed");
      // E6 / C-3: one score per guest name per single-cup session — the same rule the
      // multi-cup link applies per cup. The name is compared normalized (trimmed, spaces
      // collapsed, case-insensitive); an advisory lock on (session, name) makes concurrent
      // repeats queue so the second one is refused. Rate limiting above is unchanged.
      // Existing duplicate rows from before this guard are kept (no unique index: it would
      // conflict with them); they never count toward the close minimum anyway.
      const key = guestKey(externalName);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cupping-guest|${id}|single|${key}`}))`;
      const prior = await tx.cuppingScore.findMany({
        where: { sessionId: id, sessionBatchId: null, employeeId: null, externalName: { not: null } },
        select: { externalName: true },
      });
      if (prior.some((p) => guestKey(p.externalName ?? "") === key)) {
        throw new CuppingRefusal(409, "CUPPING_ALREADY_SCORED", "You have already scored this session");
      }
      return tx.cuppingScore.create({
        data: {
          sessionId: id,
          employeeId: null,
          externalName,
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
      });
    });
    return NextResponse.json(score, { status: 201 });
  } catch (err) {
    if (err instanceof CuppingRefusal) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    return handlePrismaError(err);
  }
}
