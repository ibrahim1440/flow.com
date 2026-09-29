// Fiscal periods: monthly, created a year at a time; OPEN → LOCKED → CLOSED, with LOCKED →
// OPEN ("unlock") allowed for a correction and always audited. CLOSED is final — the database
// guard refuses any move out of it.
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { auditAccounting } from "./audit";
import { ledgerTx } from "./journal-service";

export async function findPeriodForDate(date: Date) {
  return prisma.fiscalPeriod.findFirst({
    where: { startDate: { lte: date }, endDate: { gte: date } },
  });
}

/**
 * Twelve monthly periods for a fiscal year starting in `startMonth` (1 = January). The year
 * label is the calendar year the fiscal year starts in. Periods that would overlap an
 * existing one are refused by the database exclusion constraint.
 */
export async function createFiscalYear(year: number, startMonth: number, userId: string) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new AccountingError("Year must be between 2000 and 2100.", 400);
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) throw new AccountingError("Start month must be 1–12.", 400);
  return ledgerTx(async (tx) => {
    const exists = await tx.fiscalPeriod.count({ where: { year } });
    if (exists) throw new AccountingError(`Fiscal year ${year} already has periods.`, 409);
    const created = [];
    for (let i = 0; i < 12; i++) {
      const start = new Date(Date.UTC(year, startMonth - 1 + i, 1));
      const end = new Date(Date.UTC(year, startMonth + i, 0));
      created.push(await tx.fiscalPeriod.create({ data: { year, periodNo: i + 1, startDate: start, endDate: end } }));
    }
    await auditAccounting(tx, { action: "period.create_year", entityType: "fiscal_year", entityId: String(year), userId, after: { startMonth, periods: 12 } });
    return created;
  });
}

export async function lockFiscalPeriod(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const res = await tx.fiscalPeriod.updateMany({ where: { id, status: "OPEN" }, data: { status: "LOCKED", lockedAt: new Date(), lockedBy: userId } });
    if (res.count === 0) {
      const p = await tx.fiscalPeriod.findUnique({ where: { id } });
      if (!p) throw new AccountingError("Fiscal period not found.", 404);
      throw new AccountingError(`Cannot lock a period that is ${p.status}.`, 409);
    }
    await auditAccounting(tx, { action: "period.lock", entityType: "fiscal_period", entityId: id, userId });
    return tx.fiscalPeriod.findUniqueOrThrow({ where: { id } });
  });
}

/** LOCKED → OPEN for a correction. Needs a reason; CLOSED periods never reopen. */
export async function unlockFiscalPeriod(id: string, userId: string, reason: string) {
  const why = reason?.trim();
  if (!why || why.length < 5) throw new AccountingError("Unlocking a period needs a reason (at least 5 characters).", 400);
  return ledgerTx(async (tx) => {
    const res = await tx.fiscalPeriod.updateMany({ where: { id, status: "LOCKED" }, data: { status: "OPEN", lockedAt: null, lockedBy: null } });
    if (res.count === 0) {
      const p = await tx.fiscalPeriod.findUnique({ where: { id } });
      if (!p) throw new AccountingError("Fiscal period not found.", 404);
      throw new AccountingError(p.status === "CLOSED" ? "A closed period cannot be reopened." : `Only a locked period can be unlocked (this one is ${p.status}).`, 409);
    }
    await auditAccounting(tx, { action: "period.unlock", entityType: "fiscal_period", entityId: id, userId, reason: why });
    return tx.fiscalPeriod.findUniqueOrThrow({ where: { id } });
  });
}

/** What still stands between a period and closing. Empty = it can close. */
export async function closeBlockers(id: string) {
  const p = await prisma.fiscalPeriod.findUnique({ where: { id } });
  if (!p) throw new AccountingError("Fiscal period not found.", 404);
  const [pendingEntries, waitingEvents, earlierOpen] = await Promise.all([
    prisma.journalEntry.count({ where: { fiscalPeriodId: id, status: { in: ["DRAFT", "SUBMITTED", "APPROVED"] } } }),
    prisma.accountingEvent.count({
      where: { status: { in: ["PENDING", "BLOCKED", "FAILED"] }, occurredAt: { gte: new Date(p.startDate.getTime() - 3 * 3600_000), lt: new Date(p.endDate.getTime() + 21 * 3600_000) } },
    }),
    prisma.fiscalPeriod.count({ where: { endDate: { lt: p.startDate }, status: { not: "CLOSED" } } }),
  ]);
  const blockers: { code: string; count: number; en: string; ar: string }[] = [];
  if (pendingEntries) blockers.push({ code: "PENDING_ENTRIES", count: pendingEntries, en: `${pendingEntries} journal entries are still draft, submitted or approved`, ar: `${pendingEntries} قيود ما زالت مسودة أو مقدمة أو معتمدة دون ترحيل` });
  if (waitingEvents) blockers.push({ code: "WAITING_EVENTS", count: waitingEvents, en: `${waitingEvents} operational events dated in this period are not posted`, ar: `${waitingEvents} أحداث تشغيلية في هذه الفترة لم تُرحّل بعد` });
  const lastOfYear = !(await prisma.fiscalPeriod.count({ where: { year: p.year, startDate: { gt: p.startDate } } }));
  const yearClose = lastOfYear ? await prisma.yearEndClose.findFirst({ where: { year: p.year, status: { in: ["DRAFT", "REVERSAL_REQUESTED"] } } }) : null;
  if (yearClose) blockers.push({ code: "YEAR_END_PENDING", count: 1, en: `The ${p.year} year-end close is ${yearClose.status === "DRAFT" ? "prepared but not posted" : "waiting for a reopening decision"}`, ar: `إقفال سنة ${p.year} ${yearClose.status === "DRAFT" ? "معدّ ولم يُرحّل" : "بانتظار قرار إعادة الفتح"}` });
  if (earlierOpen) blockers.push({ code: "EARLIER_OPEN", count: earlierOpen, en: `${earlierOpen} earlier periods are not closed`, ar: `${earlierOpen} فترات سابقة لم تُقفل` });
  return { period: p, blockers };
}

export async function closeFiscalPeriod(id: string, userId: string) {
  const { period, blockers } = await closeBlockers(id);
  if (period.status !== "LOCKED") throw new AccountingError("A period must be locked before it can be closed.", 409);
  if (blockers.length) throw new AccountingError(`Cannot close: ${blockers.map((b) => b.en).join("; ")}.`, 409, { blockers });
  return ledgerTx(async (tx) => {
    const pending = await tx.journalEntry.count({ where: { fiscalPeriodId: id, status: { in: ["DRAFT", "SUBMITTED", "APPROVED"] } } });
    if (pending) throw new AccountingError(`Cannot close: ${pending} journal entries are still pending.`, 409);
    const res = await tx.fiscalPeriod.updateMany({ where: { id, status: "LOCKED" }, data: { status: "CLOSED", closedAt: new Date(), closedBy: userId } });
    if (res.count === 0) throw new AccountingError("The period changed while closing; reload and try again.", 409);
    await auditAccounting(tx, { action: "period.close", entityType: "fiscal_period", entityId: id, userId });
    return tx.fiscalPeriod.findUniqueOrThrow({ where: { id } });
  });
}
