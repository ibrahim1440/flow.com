import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import { extractIp } from "@/lib/rate-limit";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";

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

  const session = await prisma.cuppingSession.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (session.status !== "Open") {
    return NextResponse.json({ error: "Session is closed" }, { status: 409 });
  }

  const data = await request.json();
  const externalName = (data.externalName ?? "").trim();

  if (!externalName) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  try { const score = await prisma.cuppingScore.create({
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

  return NextResponse.json(score, { status: 201 });
  } catch (err) { return handlePrismaError(err); }
}
