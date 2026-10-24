// Accounting core A1 — Gregorian fiscal years with twelve monthly periods, and the period lifecycle:
//   OPEN ──soft-close──▶ LOCKED («مقفلة مؤقتًا»: nothing posts; unlocked with a reason)
//        LOCKED ──close──▶ CLOSED («مقفلة نهائيًا»: the database refuses every posting)
//        CLOSED ──reopen (permissioned, reasoned, recorded; the database checks it)──▶ OPEN
// Every change is written to the accounting audit log by the database with the actor / IP / reason of the
// transaction's audit context.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { monthPeriod } from "./dates";
import { refuse } from "./refusals";
import { setAuditContext, type AuditContext } from "./audit";

type Tx = Prisma.TransactionClient;

/**
 * Create the Gregorian year and its twelve OPEN monthly periods if they do not exist (idempotent and safe under
 * concurrency: ON CONFLICT DO NOTHING). Existing periods of that year are linked to it, never changed.
 */
export async function ensureFiscalYear(tx: Tx, year: number, actorId: string | null = null): Promise<string> {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw refuse("BAD_INPUT", "year.");
  const id = `fy-${year}`;
  const y0 = monthPeriod(year, 1).start, y1 = monthPeriod(year, 12).end;
  await tx.$executeRaw`INSERT INTO "FiscalYear" ("id", "year", "startDate", "endDate", "createdBy", "updatedAt")
                        VALUES (${id}, ${year}, ${y0}, ${y1}, ${actorId}, now()) ON CONFLICT ("tenantId", "year") DO NOTHING`;
  const fy = await tx.fiscalYear.findUniqueOrThrow({ where: { tenantId_year: { tenantId: "hiqbah", year } }, select: { id: true } });
  for (let m = 1; m <= 12; m++) {
    const { start, end } = monthPeriod(year, m);
    await tx.$executeRaw`INSERT INTO "FiscalPeriod" ("id", "year", "periodNo", "startDate", "endDate", "status", "fiscalYearId", "updatedAt")
                          VALUES (${`fp-${year}-${String(m).padStart(2, "0")}`}, ${year}, ${m}, ${start}, ${end}, 'OPEN', ${fy.id}, now())
                          ON CONFLICT ("year", "periodNo") DO NOTHING`;
  }
  await tx.fiscalPeriod.updateMany({ where: { year, fiscalYearId: null }, data: { fiscalYearId: fy.id } });
  return fy.id;
}

/** The owner's «إنشاء سنة مالية»: refuses an existing year. */
export async function createFiscalYear(year: number, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    if (await tx.fiscalYear.findUnique({ where: { tenantId_year: { tenantId: "hiqbah", year } }, select: { id: true } })) throw refuse("YEAR_EXISTS");
    const id = await ensureFiscalYear(tx, year, ctx.actorId);
    return tx.fiscalYear.findUniqueOrThrow({ where: { id }, include: { periods: { orderBy: { periodNo: "asc" } } } });
  }, TX_OPTS);
}

export async function findPeriodForDate(date: Date) {
  return prisma.fiscalPeriod.findFirst({ where: { startDate: { lte: date }, endDate: { gte: date } } });
}

const reasonOf = (r: unknown) => {
  const t = typeof r === "string" ? r.trim() : "";
  if (t.length < 3) throw refuse("REASON_REQUIRED");
  return t.slice(0, 500);
};

async function withPeriod<T>(id: string, ctx: AuditContext, fn: (tx: Tx, p: { id: string; status: string; reopenCount: number }) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    // Locked for the decision: a concurrent post / close of the same period waits.
    const rows = await tx.$queryRaw<{ id: string; status: string; reopenCount: number }[]>`
      SELECT "id", "status"::text AS status, "reopenCount" FROM "FiscalPeriod" WHERE "id" = ${id} FOR UPDATE`;
    if (!rows.length) throw refuse("NOT_FOUND");
    return fn(tx, rows[0]);
  }, TX_OPTS);
}

/** Soft close: OPEN → LOCKED. */
export async function lockFiscalPeriod(id: string, ctx: AuditContext, also?: (tx: Tx) => Promise<unknown>) {
  return withPeriod(id, ctx, async (tx, p) => {
    if (p.status !== "OPEN") throw refuse("PERIOD_STATE", `(${p.status})`);
    if (also) await also(tx); // A5: the close checklist's record, in the same transaction
    return tx.fiscalPeriod.update({ where: { id }, data: { status: "LOCKED", lockedAt: new Date(), lockedBy: ctx.actorId } });
  });
}

/** LOCKED → OPEN, with a reason (audited). */
export async function unlockFiscalPeriod(id: string, reason: unknown, ctx: AuditContext) {
  const why = reasonOf(reason);
  return withPeriod(id, { ...ctx, reason: why }, async (tx, p) => {
    if (p.status !== "LOCKED") throw refuse("PERIOD_STATE", `(${p.status})`);
    return tx.fiscalPeriod.update({ where: { id }, data: { status: "OPEN" } });
  });
}

/** LOCKED → CLOSED; refused while drafts / submitted / approved journals remain in it. */
export async function closeFiscalPeriod(id: string, ctx: AuditContext, also?: (tx: Tx) => Promise<unknown>) {
  return withPeriod(id, ctx, async (tx, p) => {
    if (p.status !== "LOCKED") throw refuse("PERIOD_STATE", "A period is soft-closed (locked) before it is closed.", "تُقفل الفترة مؤقتًا قبل الإقفال النهائي.");
    const pending = await tx.journalEntry.count({ where: { fiscalPeriodId: id, status: { in: ["DRAFT", "SUBMITTED", "APPROVED"] } } });
    if (pending > 0) throw refuse("PERIOD_PENDING", `(${pending})`, `(${pending})`);
    if (also) await also(tx); // A5: the close checklist's record, in the same transaction
    return tx.fiscalPeriod.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date(), closedBy: ctx.actorId } });
  });
}

/** CLOSED → OPEN: permissioned at the route (accounting › period_reopen + step-up), reasoned, recorded. */
export async function reopenFiscalPeriod(id: string, reason: unknown, ctx: AuditContext) {
  const why = reasonOf(reason);
  return withPeriod(id, { ...ctx, reason: why }, async (tx, p) => {
    if (p.status !== "CLOSED") throw refuse("PERIOD_STATE", `(${p.status})`);
    // A5 council fix: a month of a year closed at year end stays closed — reopening it would let postings land after
    // the closing entry (P&L balances back in a closed year). Reopening a closed year is an owner decision (not built).
    const fy = await tx.fiscalPeriod.findUnique({ where: { id }, select: { fiscalYear: { select: { status: true } } } });
    if (fy?.fiscalYear?.status === "CLOSED") throw refuse("YEAR_CLOSED");
    return tx.fiscalPeriod.update({
      where: { id },
      data: { status: "OPEN", reopenedAt: new Date(), reopenedBy: ctx.actorId, reopenReason: why, reopenCount: p.reopenCount + 1 },
    });
  });
}
