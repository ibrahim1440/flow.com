import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { requireModule, requireSub } from "@/lib/auth-server";
import { createManualJournalEntry } from "@/lib/accounting/journal-service";
import { parseJournalBody } from "@/lib/accounting/journal-input";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { refuse } from "@/lib/accounting/refusals";
import { auditFromRequest } from "@/lib/accounting/audit";
import { isBusinessDay, parseBusinessDay, dayText } from "@/lib/accounting/dates";
import { postingRef } from "@/lib/accounting/posting-engine";

const STATUSES = new Set(["DRAFT", "SUBMITTED", "APPROVED", "POSTED", "REVERSED"]);
const TYPES = new Set(["MANUAL", "AUTO", "REVERSAL", "ADJUSTMENT", "OPENING", "CLOSING"]);

/**
 * The journal list («القيود»): filters status, type, module, date range (YYYY-MM-DD), account, text (memo,
 * source id, entry number); newest first; `take` ≤ 200, `skip`. Each row carries its posting reference and source.
 */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const q = new URL(request.url).searchParams;
    const where: Prisma.JournalEntryWhereInput = {};
    const status = q.get("status");
    if (status) {
      const list = status.split(",").filter((s) => STATUSES.has(s));
      if (list.length) where.status = { in: list as never };
    }
    const type = q.get("type");
    if (type && TYPES.has(type)) where.type = type as never;
    const mod = q.get("module");
    if (mod) where.sourceModule = mod.slice(0, 40);
    const from = q.get("from"), to = q.get("to");
    if ((from && !isBusinessDay(from)) || (to && !isBusinessDay(to))) throw refuse("BAD_INPUT", "from / to are YYYY-MM-DD.");
    if (from || to) where.entryDate = { ...(from ? { gte: parseBusinessDay(from) } : {}), ...(to ? { lte: new Date(parseBusinessDay(to).getTime() + 86_399_999) } : {}) };
    const accountId = q.get("accountId");
    if (accountId) where.lines = { some: { accountId } };
    const text = (q.get("q") ?? "").trim().slice(0, 80);
    if (text) {
      const n = Number(text.replace(/^#/, ""));
      const ref = /^JE-(\d{4})-(\d{1,9})$/i.exec(text);
      where.OR = [
        { description: { contains: text, mode: "insensitive" } },
        { sourceId: text },
        ...(Number.isInteger(n) && n > 0 ? [{ entryNo: n }] : []),
        ...(ref ? [{ postingYear: Number(ref[1]), postingSeq: Number(ref[2]) }] : []),
      ];
    }
    const take = Math.min(Math.max(Number(q.get("take")) || 50, 1), 200);
    const skip = Math.max(Number(q.get("skip")) || 0, 0);
    const [items, total, counts] = await Promise.all([
      prisma.journalEntry.findMany({
        where, orderBy: [{ entryDate: "desc" }, { entryNo: "desc" }], take, skip,
        select: { id: true, entryNo: true, postingYear: true, postingSeq: true, entryDate: true, type: true, status: true, sourceModule: true, sourceType: true, sourceId: true, sourceEvent: true, description: true, totalDebit: true, createdBy: true, createdAt: true, postedAt: true, reversesEntryId: true, sodBypass: true, _count: { select: { lines: true } } },
      }),
      prisma.journalEntry.count({ where }),
      prisma.journalEntry.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    return NextResponse.json({
      items: items.map((j) => ({ ...j, ref: postingRef(j), entryDate: dayText(j.entryDate), totalDebit: j.totalDebit.toFixed(2), lineCount: j._count.lines, _count: undefined })),
      total, take, skip,
      byStatus: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    });
  } catch (err) {
    return acctError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "journal_create");
  if (error) return error;
  try {
    const input = parseJournalBody(await jsonBody(request));
    const entry = await createManualJournalEntry(input, auditFromRequest(request, user.id));
    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
