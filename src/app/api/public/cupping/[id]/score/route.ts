import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;

  const session = await prisma.cuppingSession.findUnique({
    where: { id },
    select: { id: true, name: true, status: true },
  });

  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(session);
}

export async function POST(request: Request, { params }: Params) {
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
