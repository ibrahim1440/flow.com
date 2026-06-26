import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;

  const periods = await prisma.fiscalPeriod.findMany({
    orderBy: [{ year: "desc" }, { periodNo: "desc" }],
    take: 200,
  });
  return NextResponse.json(periods);
}

export async function POST(request: Request) {
  const { error } = await requireSub("accounting", "settings_manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { year, periodNo, startDate, endDate } = (body ?? {}) as {
    year?: unknown;
    periodNo?: unknown;
    startDate?: unknown;
    endDate?: unknown;
  };

  if (typeof year !== "number" || !Number.isInteger(year)) {
    return NextResponse.json({ error: "year must be an integer." }, { status: 400 });
  }
  if (typeof periodNo !== "number" || !Number.isInteger(periodNo) || periodNo < 1 || periodNo > 12) {
    return NextResponse.json({ error: "periodNo must be an integer between 1 and 12." }, { status: 400 });
  }
  if (typeof startDate !== "string" || typeof endDate !== "string") {
    return NextResponse.json({ error: "startDate and endDate are required (ISO date strings)." }, { status: 400 });
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return NextResponse.json({ error: "startDate and endDate must be valid dates." }, { status: 400 });
  }
  if (start > end) {
    return NextResponse.json({ error: "startDate must be on or before endDate." }, { status: 400 });
  }

  try {
    const period = await prisma.fiscalPeriod.create({
      data: { year, periodNo, startDate: start, endDate: end },
    });
    return NextResponse.json(period, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
