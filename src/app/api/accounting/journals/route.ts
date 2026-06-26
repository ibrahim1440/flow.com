import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { createManualJournalEntry, type ManualJournalLineInput } from "@/lib/accounting/journal-service";
import { AccountingError } from "@/lib/accounting/errors";

export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;

  const journals = await prisma.journalEntry.findMany({
    orderBy: { entryNo: "desc" },
    take: 500,
    include: { lines: true },
  });
  return NextResponse.json(journals);
}

function parseLines(raw: unknown): ManualJournalLineInput[] | null {
  if (!Array.isArray(raw)) return null;
  const lines: ManualJournalLineInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const { accountId, debit, credit, description, taxCategoryId } = item as Record<string, unknown>;
    if (typeof accountId !== "string" || !accountId) return null;
    if (typeof debit !== "number" && typeof debit !== "string") return null;
    if (typeof credit !== "number" && typeof credit !== "string") return null;
    if (description !== undefined && typeof description !== "string") return null;
    if (taxCategoryId !== undefined && typeof taxCategoryId !== "string") return null;
    lines.push({ accountId, debit, credit, description, taxCategoryId });
  }
  return lines;
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "journal_create");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { entryDate, description, lines: rawLines } = (body ?? {}) as {
    entryDate?: unknown;
    description?: unknown;
    lines?: unknown;
  };

  if (typeof entryDate !== "string") {
    return NextResponse.json({ error: "entryDate is required (ISO date string)." }, { status: 400 });
  }
  const parsedDate = new Date(entryDate);
  if (Number.isNaN(parsedDate.getTime())) {
    return NextResponse.json({ error: "entryDate must be a valid date." }, { status: 400 });
  }
  if (description !== undefined && typeof description !== "string") {
    return NextResponse.json({ error: "description must be a string." }, { status: 400 });
  }

  const lines = parseLines(rawLines);
  if (!lines) {
    return NextResponse.json(
      { error: "lines must be an array of { accountId, debit, credit, description?, taxCategoryId? }." },
      { status: 400 },
    );
  }

  try {
    const entry = await createManualJournalEntry(
      { entryDate: parsedDate, description, lines },
      user.id,
    );
    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    if (err instanceof AccountingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return handlePrismaError(err);
  }
}
