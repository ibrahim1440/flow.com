import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("accounting");
  if (error) return error;

  const { id } = await params;
  const entry = await prisma.journalEntry.findUnique({
    where: { id },
    include: { lines: { include: { account: true } }, fiscalPeriod: true, reversesEntry: true, reversedByEntry: true },
  });
  if (!entry) {
    return NextResponse.json({ error: "Journal entry not found." }, { status: 404 });
  }
  return NextResponse.json(entry);
}
