// Year-end close (stage 5, STAGE_5_DESIGN.md §6). The ledger is perpetual: balance-sheet
// balances carry into the next year without an entry. The close moves the year's revenue and
// expense (per account, branch and cost centre) into retained earnings with one CLOSING entry dated
// the last day of the year, posted into the year's last period while it is LOCKED.
//
// prepare (snapshot) → approve by someone else (recomputed; any difference refuses) → post once
// through the event pipeline (policy "closing.year_end"). Reopen: request + approval by someone
// else while the year's last period is still LOCKED; the reversing entry is also CLOSING-typed.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ledgerTx } from "./journal-service";
import { auditAccounting } from "./audit";
import { emitAccountingEvent } from "./accounting-event-service";
import { processEvent } from "./event-processor";
import { ZERO, dec } from "./money";
import { dateStr, todayAccountingDate } from "./dates";
import { chargeThrough, startMonth, ym } from "./fa-depreciation";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;
export type CloseLine = { accountId: string; code: string; name: string; nameAr?: string | null; branchId: string | null; costCenterId: string | null; net: string };
type Blocker = { code: string; en: string; ar: string; items?: string[] };
const DAY = 86400000;

async function yearBounds(tx: Client, year: number) {
  const periods = await tx.fiscalPeriod.findMany({ where: { year }, orderBy: { startDate: "asc" } });
  if (!periods.length) throw new AccountingError(`Fiscal year ${year} has no periods.`, 404);
  return { periods, start: periods[0].startDate, end: periods[periods.length - 1].endDate, last: periods[periods.length - 1] };
}

/** The year's revenue and expense by account, branch and cost centre (posted, excluding closing entries). */
export async function closingSnapshot(tx: Client, start: Date, end: Date): Promise<CloseLine[]> {
  const rows = await tx.$queryRaw<{ accountId: string; code: string; name: string; nameAr: string | null; branchId: string | null; costCenterId: string | null; net: string }[]>`
    SELECT l."accountId", a."code", a."nameEn" AS name, a."nameAr", l."branchId", l."costCenterId", SUM(l."debit" - l."credit")::text AS net
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId" JOIN "Account" a ON a."id" = l."accountId"
     WHERE e."status" IN ('POSTED', 'REVERSED') AND e."type" <> 'CLOSING' AND e."entryDate" >= ${start} AND e."entryDate" <= ${end}
       AND a."type" IN ('REVENUE', 'EXPENSE')
     GROUP BY l."accountId", a."code", a."nameEn", a."nameAr", l."branchId", l."costCenterId"
    HAVING SUM(l."debit" - l."credit") <> 0
     ORDER BY a."code", l."branchId" NULLS FIRST, l."costCenterId" NULLS FIRST`;
  return rows.map((r) => ({ ...r, net: dec(r.net).toFixed(2) }));
}

const netIncomeOf = (lines: CloseLine[]) => lines.reduce((s, l) => s.sub(dec(l.net)), ZERO);

export async function yearEndBlockers(tx: Client, year: number, exceptCloseId?: string) {
  const { periods, start, end, last } = await yearBounds(tx, year);
  const b: Blocker[] = [];
  const notLocked = periods.filter((p) => p.status === "OPEN");
  if (notLocked.length) b.push({ code: "PERIODS_OPEN", en: `${notLocked.length} period(s) of ${year} are still open; lock them first`, ar: `${notLocked.length} فترة من ${year} ما زالت مفتوحة؛ اقفلها أولاً`, items: notLocked.map((p) => `${p.year}-${String(p.periodNo).padStart(2, "0")}`) });
  if (last.status === "CLOSED") b.push({ code: "LAST_CLOSED", en: `The last period of ${year} is already closed; a closing entry can no longer post`, ar: `الفترة الأخيرة من ${year} مغلقة نهائياً؛ لا يمكن ترحيل قيد الإقفال` });
  if (end >= todayAccountingDate()) b.push({ code: "NOT_ENDED", en: `${year} has not ended (${dateStr(end)})`, ar: `لم تنته السنة ${year} بعد (${dateStr(end)})` });
  const next = await tx.fiscalPeriod.findFirst({ where: { startDate: new Date(end.getTime() + DAY) } });
  if (!next) b.push({ code: "NO_NEXT_YEAR", en: "The next fiscal year has not been created", ar: "لم تُنشأ السنة المالية التالية بعد" });
  const prev = await tx.fiscalPeriod.findFirst({ where: { endDate: new Date(start.getTime() - DAY) } });
  if (prev) {
    const prevPosted = await tx.journalEntry.count({ where: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { lte: prev.endDate } } });
    const prevClosed = await tx.yearEndClose.count({ where: { year: prev.year, status: "POSTED" } });
    if (prevPosted && !prevClosed) b.push({ code: "PREVIOUS_OPEN", en: `${prev.year} has postings and has not been closed`, ar: `السنة ${prev.year} فيها قيود ولم تُقفل` });
  }
  const pending = await tx.journalEntry.count({ where: { status: { in: ["DRAFT", "SUBMITTED", "APPROVED"] }, entryDate: { gte: start, lte: end } } });
  if (pending) b.push({ code: "PENDING_ENTRIES", en: `${pending} journal entries dated in ${year} are not posted`, ar: `${pending} قيود بتاريخ ${year} لم تُرحّل` });
  const waiting = await tx.accountingEvent.count({ where: { status: { in: ["PENDING", "BLOCKED", "FAILED"] }, eventType: { notIn: ["gl.year.closed", "gl.year.reopened"] }, occurredAt: { gte: new Date(start.getTime() - 3 * 3600_000), lt: new Date(end.getTime() + 21 * 3600_000) } } });
  if (waiting) b.push({ code: "WAITING_EVENTS", en: `${waiting} automatic postings dated in ${year} are waiting`, ar: `${waiting} ترحيلات آلية بتاريخ ${year} لم تُرحّل` });
  const draftRun = await tx.faDepRun.findFirst({ where: { status: "DRAFT" } });
  if (draftRun) b.push({ code: "DRAFT_RUN", en: `Depreciation run #${draftRun.runNo} is a draft`, ar: `قيد الإهلاك #${draftRun.runNo} ما زال مسودة` });
  const lastMonth = ym(end);
  const missing: string[] = [];
  for (const a of await tx.faAsset.findMany({ where: { status: "CAPITALISED" } })) {
    if (startMonth(a) > lastMonth) continue;
    const posted = await tx.faDepLine.aggregate({ where: { assetId: a.id, run: { status: { in: ["POSTED", "REVERSAL_REQUESTED"] } } }, _sum: { amount: true, months: true } });
    const c = chargeThrough(a, lastMonth, { accumulated: dec(posted._sum.amount), months: posted._sum.months ?? 0 });
    if (c.amount.gt(0)) missing.push(`FA-${String(a.assetNo).padStart(4, "0")} (${c.amount.toFixed(2)})`);
  }
  if (missing.length) b.push({ code: "DEPRECIATION_MISSING", en: `Depreciation through ${dateStr(end).slice(0, 7)} has not posted for ${missing.length} asset(s)`, ar: `لم يُرحّل إهلاك حتى ${dateStr(end).slice(0, 7)} لعدد ${missing.length} أصل`, items: missing });
  const live = await tx.yearEndClose.findFirst({ where: { year, status: { in: ["DRAFT", "POSTED", "REVERSAL_REQUESTED"] }, ...(exceptCloseId ? { id: { not: exceptCloseId } } : {}) } });
  if (live) b.push({ code: "ALREADY", en: `The ${year} close is already ${live.status.toLowerCase()}`, ar: `إقفال ${year} موجود (${live.status})` });
  return { year, start: dateStr(start), end: dateStr(end), blockers: b };
}

export async function yearEndStatus(year: number) {
  const { start, end } = await yearBounds(prisma, year);
  const [check, lines, closes] = await Promise.all([
    yearEndBlockers(prisma, year),
    closingSnapshot(prisma, start, end),
    prisma.yearEndClose.findMany({ where: { year }, orderBy: { preparedAt: "desc" } }),
  ]);
  return { ...check, preview: lines, netIncome: netIncomeOf(lines).toFixed(2), closes };
}

export async function prepareYearEnd(year: number, userId: string) {
  return ledgerTx(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"year-end:" + year}))`;
    const check = await yearEndBlockers(tx, year);
    if (check.blockers.length) throw new AccountingError(`The ${year} close cannot be prepared: ${check.blockers.map((b) => b.en).join("; ")}.`, 409, { blockers: check.blockers });
    const { start, end } = await yearBounds(tx, year);
    const lines = await closingSnapshot(tx, start, end);
    if (!lines.length) throw new AccountingError(`${year} has no revenue or expense to close.`, 409);
    const c = await tx.yearEndClose.create({ data: { year, yearStart: start, yearEnd: end, snapshot: lines as unknown as Prisma.InputJsonValue, netIncome: netIncomeOf(lines), preparedBy: userId } });
    await auditAccounting(tx, { action: "year_end.prepare", entityType: "year_end_close", entityId: c.id, userId, after: { year, netIncome: c.netIncome.toFixed(2), lines: lines.length } });
    return c;
  });
}

export async function approveYearEnd(id: string, userId: string) {
  const out = await ledgerTx(async (tx) => {
    const c0 = await tx.yearEndClose.findUnique({ where: { id } });
    if (!c0) throw new AccountingError("Year-end close not found.", 404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"year-end:" + c0.year}))`;
    const c = await tx.yearEndClose.findUniqueOrThrow({ where: { id } });
    if (c.status !== "DRAFT") throw new AccountingError(`The ${c.year} close is ${c.status}.`, 409);
    if (c.preparedBy === userId) throw new AccountingError("You prepared this close; someone else must approve it.", 403);
    const check = await yearEndBlockers(tx, c.year, c.id);
    if (check.blockers.length) throw new AccountingError(`The ${c.year} close cannot post: ${check.blockers.map((b) => b.en).join("; ")}.`, 409, { blockers: check.blockers });
    const now = await closingSnapshot(tx, c.yearStart, c.yearEnd);
    const key = (ls: CloseLine[]) => ls.map((l) => `${l.accountId}|${l.branchId ?? ""}|${l.costCenterId ?? ""}|${l.net}`).join(";");
    if (key(now) !== key(c.snapshot as unknown as CloseLine[])) throw new AccountingError(`The ${c.year} figures changed since the close was prepared; cancel it and prepare again.`, 409);
    const res = await tx.yearEndClose.updateMany({ where: { id, status: "DRAFT" }, data: { status: "POSTED", approvedBy: userId, postedAt: new Date() } });
    if (res.count === 0) throw new AccountingError("The close changed while approving; reload.", 409);
    const ev = await emitAccountingEvent({ eventType: "gl.year.closed", sourceModule: "closing", sourceDocumentId: id, sourceEventId: "1", occurredAt: c.yearEnd, payload: { closeId: id } }, tx);
    await auditAccounting(tx, { action: "year_end.post", entityType: "year_end_close", entityId: id, userId, after: { year: c.year, netIncome: c.netIncome.toFixed(2) } });
    return { close: await tx.yearEndClose.findUniqueOrThrow({ where: { id } }), eventId: ev.id };
  });
  return { close: out.close, ledger: await processEvent(out.eventId) };
}

export async function cancelYearEnd(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const res = await tx.yearEndClose.updateMany({ where: { id, status: "DRAFT" }, data: { status: "CANCELLED" } });
    if (res.count === 0) throw new AccountingError("Only a prepared (unposted) close can be cancelled.", 409);
    await auditAccounting(tx, { action: "year_end.cancel", entityType: "year_end_close", entityId: id, userId });
    return tx.yearEndClose.findUniqueOrThrow({ where: { id } });
  });
}

export async function requestYearReopen(id: string, userId: string, reason: unknown) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 5) throw new AccountingError("Reopening a closed year needs a reason (at least 5 characters).", 400);
  return ledgerTx(async (tx) => {
    const c = await tx.yearEndClose.findUnique({ where: { id } });
    if (!c || c.status !== "POSTED") throw new AccountingError("Only a posted close can be reopened.", 409);
    const { last } = await yearBounds(tx, c.year);
    if (last.status !== "LOCKED") throw new AccountingError(`The last period of ${c.year} is ${last.status}; the close is final.`, 409);
    await tx.yearEndClose.update({ where: { id }, data: { status: "REVERSAL_REQUESTED", reversalRequestedBy: userId, reversalReason: why.slice(0, 300) } });
    await auditAccounting(tx, { action: "year_end.reopen_request", entityType: "year_end_close", entityId: id, userId, reason: why });
    return tx.yearEndClose.findUniqueOrThrow({ where: { id } });
  });
}

export async function decideYearReopen(id: string, userId: string, approve: boolean) {
  const out = await ledgerTx(async (tx) => {
    const c = await tx.yearEndClose.findUnique({ where: { id } });
    if (!c || c.status !== "REVERSAL_REQUESTED") throw new AccountingError("No reopening is waiting for this close.", 409);
    if (c.reversalRequestedBy === userId) throw new AccountingError("You requested this reopening; someone else must decide it.", 403);
    if (!approve) {
      await tx.yearEndClose.update({ where: { id }, data: { status: "POSTED", reversalRequestedBy: null, reversalReason: null } });
      await auditAccounting(tx, { action: "year_end.reopen_reject", entityType: "year_end_close", entityId: id, userId });
      return { close: await tx.yearEndClose.findUniqueOrThrow({ where: { id } }), eventId: null };
    }
    const { last } = await yearBounds(tx, c.year);
    if (last.status !== "LOCKED") throw new AccountingError(`The last period of ${c.year} is ${last.status}; the close is final.`, 409);
    await tx.yearEndClose.update({ where: { id }, data: { status: "REVERSED", reversedBy: userId, reversedAt: new Date() } });
    const ev = await emitAccountingEvent({ eventType: "gl.year.reopened", sourceModule: "closing", sourceDocumentId: id, sourceEventId: "1", occurredAt: c.yearEnd, payload: { closeId: id } }, tx);
    await auditAccounting(tx, { action: "year_end.reopen", entityType: "year_end_close", entityId: id, userId, reason: c.reversalReason });
    return { close: await tx.yearEndClose.findUniqueOrThrow({ where: { id } }), eventId: ev.id };
  });
  return { close: out.close, ledger: out.eventId ? await processEvent(out.eventId) : null };
}

/** Balances carried into the year after `year`: every account's balance at the year end (closing entries included). */
export async function openingBalancesAfter(year: number) {
  const { end } = await yearBounds(prisma, year);
  const rows = await prisma.$queryRaw<{ id: string; code: string; name: string; nameAr: string | null; type: string; net: string }[]>`
    SELECT a."id", a."code", a."nameEn" AS name, a."nameAr", a."type"::text AS type, COALESCE(SUM(l."debit" - l."credit"), 0)::text AS net
      FROM "Account" a JOIN "JournalEntryLine" l ON l."accountId" = a."id" JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" <= ${end}
     GROUP BY a."id", a."code", a."nameEn", a."nameAr", a."type" ORDER BY a."code"`;
  const lines = rows.map((r) => ({ ...r, net: dec(r.net).toFixed(2) })).filter((r) => r.net !== "0.00");
  const pnlLeft = lines.filter((l) => l.type === "REVENUE" || l.type === "EXPENSE");
  return { year, carriedInto: year + 1, asOf: dateStr(end), lines, profitAndLossNotClosed: pnlLeft.length, balanced: lines.reduce((s, l) => s.add(dec(l.net)), ZERO).isZero() };
}
