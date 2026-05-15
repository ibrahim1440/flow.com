import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ token: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { token } = await params;

  const session = await prisma.cuppingSession.findUnique({
    where: { sessionToken: token },
    select: {
      id: true,
      name: true,
      status: true,
      sessionBatches: {
        orderBy: { order: "asc" },
        select: { id: true, order: true }, // intentionally blind — no bean/batch details
      },
    },
  });

  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(session);
}

export async function POST(request: Request, { params }: Params) {
  const { token } = await params;

  const session = await prisma.cuppingSession.findUnique({
    where: { sessionToken: token },
    select: { id: true, status: true },
  });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (session.status !== "Open") return NextResponse.json({ error: "Session is closed" }, { status: 409 });

  const data = await request.json();
  const { sessionBatchId, externalName, ...scoreData } = data;
  const name = (externalName ?? "").trim();

  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!sessionBatchId) return NextResponse.json({ error: "sessionBatchId is required" }, { status: 400 });

  // Verify the sessionBatch belongs to this session
  const sessionBatch = await prisma.cuppingSessionBatch.findFirst({
    where: { id: sessionBatchId, sessionId: session.id },
  });
  if (!sessionBatch) return NextResponse.json({ error: "Invalid cup" }, { status: 400 });

  // Prevent duplicate scoring of the same cup by the same external tester
  const existing = await prisma.cuppingScore.findFirst({
    where: { sessionBatchId, externalName: name },
  });
  if (existing) return NextResponse.json({ error: "You have already scored this cup" }, { status: 409 });

  try {
    const score = await prisma.cuppingScore.create({
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
    return NextResponse.json(score, { status: 201 });
  } catch (err) { return handlePrismaError(err); }
}
