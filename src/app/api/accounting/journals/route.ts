import type { Prisma, JournalEntryStatus, JournalEntryType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { accountingRoute, body, query } from "@/lib/accounting/http";
import { createManualJournalEntry } from "@/lib/accounting/journal-service";
import { accountingDate } from "@/lib/accounting/dates";
import { toMinor } from "@/lib/accounting/money";
import { parseJournalBody } from "./parse";

const STATUSES = new Set(["DRAFT", "SUBMITTED", "APPROVED", "POSTED", "REVERSED"]);
const TYPES = new Set(["MANUAL", "AUTO", "REVERSAL", "ADJUSTMENT", "OPENING", "CLOSING"]);

export const GET = accountingRoute(null, async ({ request }) => {
  const q = query(request);
  const where: Prisma.JournalEntryWhereInput = {};
  const status = q.get("status");
  if (status === "PENDING") where.status = { in: ["SUBMITTED", "APPROVED"] };
  else if (status && STATUSES.has(status)) where.status = status as JournalEntryStatus;
  const type = q.get("type");
  if (type && TYPES.has(type)) where.type = type as JournalEntryType;
  const source = q.get("source");
  if (source) where.sourceModule = source;
  if (q.get("from") || q.get("to")) where.entryDate = { ...(q.get("from") ? { gte: accountingDate(q.get("from")) } : {}), ...(q.get("to") ? { lte: accountingDate(q.get("to")) } : {}) };
  const text = q.get("q")?.trim();
  if (text) {
    const n = Number(text.replace(/^#/, ""));
    where.OR = [{ description: { contains: text, mode: "insensitive" } }, ...(Number.isInteger(n) && n > 0 ? [{ entryNo: n }] : [])];
  }
  if (q.get("provisional") === "only") where.isProvisional = true;
  const page = Math.max(Number(q.get("page")) || 1, 1);
  const pageSize = Math.min(Math.max(Number(q.get("pageSize")) || 25, 10), 100);
  const sort = q.get("sort") === "amount" ? { totalDebit: "desc" as const } : q.get("sort") === "oldest" ? { entryNo: "asc" as const } : { entryNo: "desc" as const };
  const [rows, total] = await Promise.all([
    prisma.journalEntry.findMany({ where, orderBy: sort, skip: (page - 1) * pageSize, take: pageSize, include: { _count: { select: { lines: true } } } }),
    prisma.journalEntry.count({ where }),
  ]);
  const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.approvedBy, r.postedBy]).filter((x): x is string => !!x && !x.startsWith("system:")))];
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  const who = (id: string | null) => (id ? (id.startsWith("system:") ? "system" : names.get(id) ?? id) : null);
  return {
    total, page, pageSize,
    rows: rows.map((r) => ({
      id: r.id, entryNo: r.entryNo, entryDate: r.entryDate, type: r.type, status: r.status, description: r.description,
      sourceModule: r.sourceModule, sourceDocumentId: r.sourceDocumentId, total: toMinor(r.totalDebit), lines: r._count.lines,
      isProvisional: r.isProvisional, createdBy: who(r.createdBy), approvedBy: who(r.approvedBy), postedBy: who(r.postedBy),
      rejectionReason: r.status === "DRAFT" ? r.rejectionReason : null, reversesEntryId: r.reversesEntryId,
    })),
  };
});

export const POST = accountingRoute("journal_create", async ({ user, request }) => {
  return createManualJournalEntry(parseJournalBody(await body(request)), user.id);
}, 201);
