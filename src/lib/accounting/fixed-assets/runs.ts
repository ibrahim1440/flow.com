// «الإهلاك» — the monthly depreciation run (20261121090000_fixed_assets).
//
//   previewDepreciation(year, month)        what the run would record: per asset (from the day after what is recorded to
//                                           the month's end, daily pro-rata — ./schedule.ts), per category / account,
//                                           the period's state and whether the entry would post or be skipped.
//   runDepreciationForMonth(year, month)    THE function a schedule (the recurring-transactions builder) calls: one
//                                           balanced entry (Dr depreciation expense / Cr accumulated depreciation, by
//                                           category account and branch) dated the month's last day; idempotent per
//                                           (asset, month) — a second call for the same month records only assets
//                                           that have no line for it yet, or returns { status: "nothing" }.
//   reverseDepreciationRun(runId, reason)   the only correction: the run's entry reversed on its own date (its period
//                                           must be open), its lines voided, the assets back to what they carried —
//                                           only when no asset of it has anything recorded after it.
// Closed periods: a soft-closed / closed month records and reverses nothing. Before go-live (or accounting off) the run
// is recorded and its entry SKIPPED (the existing pattern); the opening balances carry it (./opening.ts).
import { randomUUID } from "node:crypto";
import { prisma, TX_OPTS } from "@/lib/db";
import { Decimal, ZERO } from "../money";
import { addDaysUtc, dayText, riyadhDay } from "../dates";
import { setAuditContext, type AuditContext } from "../audit";
import { engineState, postEntry, reverseEntry, type PostingLineInput } from "../posting-engine";
import { opsRefuse } from "../ops/refusals";
import { type Tx, dec, f2, str, categoryAccounts, categoryAccountsSoft, glFate, nextFaNumber, scheduleOf, recordedThrough } from "./common";
import { chargeThrough, isFullyDepreciated, periodKeyOf } from "./schedule";

export type RunLine = {
  assetId: string; code: string; nameAr: string; nameEn: string | null; categoryId: string; category: string; branchId: string | null;
  fromDate: string; toDate: string; amount: string; expenseAccountId: string | null; accumAccountId: string | null; fullyDepreciated: boolean; catchUp: boolean;
};

function monthBounds(year: unknown, month: unknown) {
  const y = Number(year), m = Number(month);
  if (!Number.isInteger(y) || y < 2000 || y > 2200 || !Number.isInteger(m) || m < 1 || m > 12) throw opsRefuse("FA_RUN_MONTH");
  const start = new Date(Date.UTC(y, m - 1, 1)), end = new Date(Date.UTC(y, m, 0));
  if (start > riyadhDay()) throw opsRefuse("FA_RUN_MONTH");
  return { y, m, start, end, key: `${y}-${String(m).padStart(2, "0")}` };
}

/** The lines of a run for the month (the assets read — and, with `lock`, locked in id order). */
async function computeLines(tx: Tx, end: Date, key: string, lock: boolean, post: boolean): Promise<RunLine[]> {
  const ids = (await tx.fixedAsset.findMany({ where: { status: "ACTIVE", inServiceDate: { lte: end } }, select: { id: true }, orderBy: { id: "asc" } })).map((x) => x.id);
  if (lock && ids.length) await tx.$queryRaw`SELECT "id" FROM "FixedAsset" WHERE "id" = ANY(${ids}) ORDER BY "id" FOR UPDATE`;
  const assets = ids.length ? await tx.fixedAsset.findMany({ where: { id: { in: ids }, status: "ACTIVE" }, include: { category: true }, orderBy: { code: "asc" } }) : [];
  const live = new Set((ids.length ? await tx.fixedAssetDepreciationLine.findMany({ where: { assetId: { in: ids }, periodKey: key, voidedAt: null }, select: { assetId: true } }) : []).map((l) => l.assetId));
  const accCache = new Map<string, { expense: string; accum: string } | null>();
  const out: RunLine[] = [];
  for (const a of assets) {
    if (live.has(a.id)) continue;
    const through = recordedThrough(a) as Date;
    if (through >= end) continue;
    const amount = chargeThrough(scheduleOf(a), dec(a.accumulatedDepreciation), end);
    if (!amount.gt(0)) continue;
    if (!accCache.has(a.categoryId)) {
      // A run that posts needs both accounts (ROLE_NOT_MAPPED otherwise); a skipped one records what is known.
      const acc = post ? await categoryAccounts(tx, a.category, ["expense", "accum"]) : await categoryAccountsSoft(tx, a.category);
      accCache.set(a.categoryId, acc.expense && acc.accum ? { expense: acc.expense, accum: acc.accum } : null);
    }
    const acc = accCache.get(a.categoryId);
    const from = addDaysUtc(through, 1);
    out.push({
      assetId: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, categoryId: a.categoryId, category: a.category.nameAr, branchId: a.branchId,
      fromDate: dayText(from), toDate: dayText(end), amount: amount.toFixed(2), expenseAccountId: acc?.expense ?? null, accumAccountId: acc?.accum ?? null,
      fullyDepreciated: isFullyDepreciated(dec(a.cost), dec(a.residualValue), dec(a.accumulatedDepreciation).plus(amount)),
      catchUp: periodKeyOf(from) !== key,
    });
  }
  return out;
}

/** One balanced entry: per (expense account, accumulated account, branch) a debit and a credit. */
function runEntryLines(ls: RunLine[], memoKey: string): PostingLineInput[] {
  const g = new Map<string, { e: string; a: string; b: string | null; v: Decimal }>();
  for (const l of ls) {
    const k = `${l.expenseAccountId}|${l.accumAccountId}|${l.branchId ?? ""}`;
    const x = g.get(k) ?? { e: l.expenseAccountId as string, a: l.accumAccountId as string, b: l.branchId, v: ZERO };
    x.v = x.v.plus(l.amount); g.set(k, x);
  }
  const out: PostingLineInput[] = [];
  for (const x of g.values()) {
    out.push({ accountId: x.e, debit: x.v.toFixed(2), description: `إهلاك ${memoKey}`, dims: { branchId: x.b } });
    out.push({ accountId: x.a, credit: x.v.toFixed(2), description: `مجمع إهلاك ${memoKey}`, dims: { branchId: x.b } });
  }
  return out;
}

async function periodState(tx: Tx | typeof prisma, d: Date): Promise<string | null> {
  const p = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: d }, endDate: { gte: d } }, select: { status: true } });
  return p ? String(p.status) : null;
}

export async function previewDepreciation(year: unknown, month: unknown) {
  const b = monthBounds(year, month);
  return prisma.$transaction(async (tx) => {
    const st = await engineState(tx, b.end);
    const ls = await computeLines(tx, b.end, b.key, false, false);
    const settings = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { openingEntryId: true, goLiveDate: true } });
    const byCat = new Map<string, { categoryId: string; category: string; count: number; amount: Decimal }>();
    for (const l of ls) { const x = byCat.get(l.categoryId) ?? { categoryId: l.categoryId, category: l.category, count: 0, amount: ZERO }; x.count++; x.amount = x.amount.plus(l.amount); byCat.set(l.categoryId, x); }
    const total = ls.reduce((t, l) => t.plus(l.amount), ZERO);
    const runs = await tx.fixedAssetDepreciationRun.findMany({ where: { year: b.y, month: b.m }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true, totalAmount: true, assetCount: true, glState: true } });
    const periodStatus = await periodState(tx, b.end);
    return {
      year: b.y, month: b.m, periodKey: b.key, periodEnd: dayText(b.end), periodStatus, periodOpen: !periodStatus || periodStatus === "OPEN",
      goLiveFirstOfMonth: !settings?.goLiveDate || settings.goLiveDate.getUTCDate() === 1,
      gl: st.on ? "POST" : st.reason, openingFinal: !st.on && st.reason === "BEFORE_GO_LIVE" && !!settings?.openingEntryId,
      unmapped: ls.some((l) => !l.expenseAccountId || !l.accumAccountId),
      lines: ls, total: total.toFixed(2), count: ls.length, catchUp: ls.filter((l) => l.catchUp).length,
      byCategory: [...byCat.values()].map((x) => ({ ...x, amount: x.amount.toFixed(2) })),
      runs: runs.map((r) => ({ ...r, totalAmount: f2(r.totalAmount) })),
    };
  }, TX_OPTS);
}

export type RunResult = { status: "posted"; run: Awaited<ReturnType<typeof getRun>> } | { status: "nothing"; year: number; month: number };

/**
 * Record (and post) the month's depreciation. Idempotent per (asset, month): run it again and only assets without a
 * live line for the month are taken; nothing left → { status: "nothing" } (`opts.allowNothing`, the scheduler's call)
 * or the refusal FA_RUN_NOTHING (a person pressing the button).
 */
/** `opts.standing`: the scheduler's run under a StandingAuthorisation (DEPRECIATION, 20261124090000) — its id recorded on the
 *  run, its sodBypass on the entry; ctx.actorId is then the authoriser (the entry's postedBy). */
export async function runDepreciationForMonth(year: unknown, month: unknown, ctx: AuditContext, opts: { allowNothing?: boolean; standing?: { id: string; sodBypass: boolean } } = {}): Promise<RunResult> {
  const b = monthBounds(year, month);
  const runId = await prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: ctx.reason ?? `depreciation ${b.key}` });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('fa:depreciation', 0))`;
    const ps = await periodState(tx, b.end);
    if (ps && ps !== "OPEN") throw opsRefuse("FA_PERIOD_CLOSED", `(${b.key})`, `(${b.key})`);
    const fate = await glFate(tx, b.end);
    const ls = await computeLines(tx, b.end, b.key, true, fate.post);
    if (!ls.length) { if (opts.allowNothing) return null; throw opsRefuse("FA_RUN_NOTHING"); }
    const id = `fadr_${randomUUID().replace(/-/g, "")}`;
    const number = await nextFaNumber(tx, "DEP", b.end);
    const total = ls.reduce((t, l) => t.plus(l.amount), ZERO);
    let journalEntryId: string | null = null;
    if (fate.post) {
      const r = await postEntry(tx, { source: { module: "accounting", type: "FA_DEPRECIATION_RUN", id, event: "POSTED" }, date: dayText(b.end), createdBy: ctx.actorId, memo: `إهلاك الأصول الثابتة ${b.key} (${number})`, lines: runEntryLines(ls, b.key), ...(opts.standing ? { sodBypass: opts.standing.sodBypass } : {}) });
      if (r.status === "posted") journalEntryId = r.entryId;
    }
    const glState = journalEntryId ? "POSTED" : "SKIPPED";
    await tx.fixedAssetDepreciationRun.create({ data: { id, number, year: b.y, month: b.m, periodEnd: b.end, totalAmount: total, assetCount: ls.length, glState, journalEntryId, createdBy: ctx.actorId, standingAuthorisationId: opts.standing?.id ?? null } });
    for (const l of ls) {
      await tx.fixedAssetDepreciationLine.create({ data: { runId: id, assetId: l.assetId, periodKey: b.key, fromDate: new Date(`${l.fromDate}T00:00:00Z`), toDate: b.end, amount: dec(l.amount), categoryId: l.categoryId, branchId: l.branchId, expenseAccountId: l.expenseAccountId, accumAccountId: l.accumAccountId } });
      await tx.fixedAssetEvent.create({ data: { assetId: l.assetId, kind: "DEPRECIATION", eventDate: b.end, accumDelta: dec(l.amount), sourceType: "RUN", sourceId: id, glState, journalEntryId, createdBy: ctx.actorId } });
      const a = await tx.fixedAsset.findUniqueOrThrow({ where: { id: l.assetId }, select: { accumulatedDepreciation: true } });
      await tx.fixedAsset.update({ where: { id: l.assetId }, data: { accumulatedDepreciation: dec(a.accumulatedDepreciation).plus(l.amount), depreciatedThrough: b.end, ...(l.fullyDepreciated ? { status: "FULLY_DEPRECIATED" } : {}), updatedBy: ctx.actorId } });
    }
    return id;
  }, { ...TX_OPTS, timeout: 120_000 });
  if (!runId) return { status: "nothing", year: b.y, month: b.m };
  return { status: "posted", run: await getRun(runId) };
}

/** Reverse a whole run (the only correction of depreciation). */
export async function reverseDepreciationRun(runId: string, reason: string, ctx: AuditContext) {
  const r = str(reason, 500);
  if (!r || r.length < 3) throw opsRefuse("OPS_BAD_INPUT", "A reason is required.", "السبب مطلوب.");
  await prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('fa:depreciation', 0))`;
    const run = await tx.fixedAssetDepreciationRun.findUnique({ where: { id: runId }, include: { lines: { where: { voidedAt: null }, orderBy: { assetId: "asc" } } } });
    if (!run) throw opsRefuse("OPS_NOT_FOUND");
    if (run.status !== "POSTED") throw opsRefuse("FA_RUN_STATE");
    const ids = run.lines.map((l) => l.assetId);
    if (ids.length) await tx.$queryRaw`SELECT "id" FROM "FixedAsset" WHERE "id" = ANY(${ids}) ORDER BY "id" FOR UPDATE`;
    const assets = new Map((await tx.fixedAsset.findMany({ where: { id: { in: ids } } })).map((a) => [a.id, a]));
    for (const l of run.lines) {
      const a = assets.get(l.assetId)!;
      const laterAdd = await tx.fixedAssetAddition.count({ where: { assetId: a.id, status: "POSTED", createdAt: { gt: run.createdAt } } });
      if (a.status === "DISPOSED" || laterAdd || !a.depreciatedThrough || a.depreciatedThrough.getTime() !== l.toDate.getTime()) throw opsRefuse("FA_RUN_NOT_LATEST", `(${a.code})`, `(${a.code})`);
    }
    const ps = await periodState(tx, run.periodEnd);
    if (ps && ps !== "OPEN") throw opsRefuse("FA_PERIOD_CLOSED", `(${dayText(run.periodEnd)})`, `(${dayText(run.periodEnd)})`);
    const fate = await glFate(tx, run.periodEnd);
    if (run.glState === "SKIPPED" && fate.openingPosted) throw opsRefuse("FA_OPENING_FINAL");
    let reversalEntryId: string | null = null;
    if (run.journalEntryId) reversalEntryId = (await reverseEntry(tx, { entryId: run.journalEntryId, reason: r, actorId: ctx.actorId, date: dayText(run.periodEnd) })).entryId;
    const now = new Date();
    for (const l of run.lines) {
      const a = assets.get(l.assetId)!;
      const ev = await tx.fixedAssetEvent.findFirstOrThrow({ where: { assetId: a.id, sourceType: "RUN", sourceId: run.id, reversesEventId: null } });
      await tx.fixedAssetEvent.create({ data: { assetId: a.id, kind: "DEPRECIATION", eventDate: run.periodEnd, accumDelta: dec(l.amount).negated(), sourceType: "RUN", sourceId: run.id, reversesEventId: ev.id, glState: reversalEntryId ? "POSTED" : "SKIPPED", journalEntryId: reversalEntryId, createdBy: ctx.actorId } });
      await tx.fixedAssetDepreciationLine.update({ where: { id: l.id }, data: { voidedAt: now } });
      const back = addDaysUtc(l.fromDate, -1);
      await tx.fixedAsset.update({ where: { id: a.id }, data: {
        accumulatedDepreciation: dec(a.accumulatedDepreciation).minus(l.amount), depreciatedThrough: a.inServiceDate && back < a.inServiceDate ? null : back,
        ...(a.status === "FULLY_DEPRECIATED" ? { status: "ACTIVE" } : {}), updatedBy: ctx.actorId } });
    }
    await tx.fixedAssetDepreciationRun.update({ where: { id: run.id }, data: { status: "REVERSED", reversedAt: now, reversedBy: ctx.actorId, reverseReason: r, reversalEntryId } });
  }, { ...TX_OPTS, timeout: 120_000 });
  return getRun(runId);
}

export async function listRuns(q: { year?: number | null } = {}) {
  const rows = await prisma.fixedAssetDepreciationRun.findMany({ where: q.year ? { year: q.year } : {}, orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }], take: 240 });
  return rows.map((r) => ({ id: r.id, number: r.number, year: r.year, month: r.month, periodEnd: dayText(r.periodEnd), status: r.status, totalAmount: f2(r.totalAmount), assetCount: r.assetCount, glState: r.glState, journalEntryId: r.journalEntryId, reversalEntryId: r.reversalEntryId, reversedAt: r.reversedAt?.toISOString() ?? null, reverseReason: r.reverseReason, createdAt: r.createdAt.toISOString(), createdBy: r.createdBy }));
}

export async function getRun(id: string) {
  const r = await prisma.fixedAssetDepreciationRun.findUnique({ where: { id }, include: { lines: { orderBy: { createdAt: "asc" }, include: { asset: { select: { code: true, nameAr: true, nameEn: true, category: { select: { nameAr: true, nameEn: true } } } } } } } });
  if (!r) throw opsRefuse("OPS_NOT_FOUND");
  return {
    id: r.id, number: r.number, year: r.year, month: r.month, periodEnd: dayText(r.periodEnd), status: r.status, totalAmount: f2(r.totalAmount), assetCount: r.assetCount, glState: r.glState,
    journalEntryId: r.journalEntryId, reversalEntryId: r.reversalEntryId, reversedAt: r.reversedAt?.toISOString() ?? null, reverseReason: r.reverseReason, createdAt: r.createdAt.toISOString(), createdBy: r.createdBy,
    lines: r.lines.map((l) => ({ id: l.id, assetId: l.assetId, asset: l.asset, fromDate: dayText(l.fromDate), toDate: dayText(l.toDate), amount: f2(l.amount), voided: !!l.voidedAt })),
  };
}
