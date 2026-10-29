// «المعاملات المتكررة» — the runner (feat/recurring-journals, 20261120090000_recurring_journals). Called by the cron
// route (/api/cron/recurring, CRON_SECRET) and by «تشغيل المستحق الآن» (/api/accounting/recurring/run-due).
//
// One occurrence at a time, each in its own transaction:
//   1. the schedule row is locked FOR UPDATE SKIP LOCKED — a second runner at the same moment skips it (no wait, no
//      double); the schedule is re-read under the lock (still ACTIVE, still due);
//   2. THE RUN KEY (schedule, due date) is looked up: a run that exists and is not FAILED means the occurrence was made
//      — the schedule is only moved on (a re-run never duplicates; the UNIQUE index enforces it besides);
//   3. the RIGHTS are re-checked as of now (council F2): a preparer who was deactivated or no longer holds
//      accounting › recurring or journal_create (and sales › invoices_create for an invoice) → the schedule is PAUSED with the reason,
//      the accounting admins are notified, nothing is made; an auto-post authoriser who was deactivated, is no longer an
//      admin or no longer holds accounting › journal_post → auto-post is WITHDRAWN (drafts only from now), logged with
//      the reason and notified — this run makes a draft;
//   4. the run SNAPSHOTS what it makes (the schedule's payload) and its auto-post authorisation; the document is made
//      from that snapshot in the SAME transaction as the run row and the move to the next occurrence:
//        · a JOURNAL — before go-live (accounting not activated, or the date before the go-live date) the run is
//          RECORDED as SKIPPED and nothing is made (the posting engine's skipped-entry pattern); otherwise a manual
//          journal DRAFT through the journal service (every journal rule), or — auto-post — the same manual journal
//          submitted by the preparer and approved + POSTED by the authoriser (type MANUAL: the manual-journal review, the
//          SoD exceptions and the auditor's filters see it; a self-authorisation is its sodBypass);
//        · a SALES_INVOICE — a manual DRAFT through the invoicing service, under the request key recurring:<id>:<date>,
//          noting that its prices are the schedule's as of the day they were copied (issuing stays a person's act);
//   5. a refusal (a closed period, an archived account, manual journals disabled …) rolls that back; a second
//      transaction records the run as FAILED (with its snapshot) and moves the schedule on — «إعادة المحاولة» retries
//      from the SNAPSHOT, never from what the schedule became since (council F3).
// The audit context names who ran it (the person, or "system:recurring" for the cron) — the database writes the trail.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { effectivePermissions } from "@/lib/notifications/recipients";
import { notify } from "@/lib/notifications/notify";
import { setAuditContext, type AuditContext } from "../audit";
import { acctError } from "../http";
import { refuse } from "../refusals";
import { dayText, parseBusinessDay, riyadhDay } from "../dates";
import { engineState } from "../posting-engine";
import { createManualJournalDraftIn, postRecurringJournalIn } from "../journal-service";
import { createManualDraftIn } from "@/lib/services/invoicing/service";
import { occurrenceDate } from "./schedule";
import { journalLines, ruleOf, type JournalPayload, type Payload } from "./schedules";
import { errorText, refText } from "./shared";

type Tx = Prisma.TransactionClient;
type Schedule = Prisma.RecurringScheduleGetPayload<object>;
export type RunTrigger = "CRON" | "MANUAL" | "RETRY";
export type Outcome =
  | { status: "CREATED" | "POSTED"; journalEntryId?: string; salesInvoiceId?: string }
  | { status: "SKIPPED"; skipReason: "NOT_ACTIVE" | "BEFORE_GO_LIVE" };
/** What a run makes, frozen at its first attempt. */
export type Snapshot = { payload: Payload; autoPost: boolean; autoPostBy: string | null; autoPostSodBypass: boolean };

export const SYSTEM_ACTOR = "system:recurring";

/** A thrown refusal (any service's) as { code, ar, en } — never a stack or a connection string. */
export async function describeError(e: unknown): Promise<{ code: string; ar: string; en: string }> {
  try {
    const res = acctError(e);
    const body = (await res.json()) as { error?: string; errorEn?: string; code?: string };
    const code = body.code ?? (res.status >= 500 ? "ERROR" : `HTTP_${res.status}`);
    const en = body.errorEn ?? body.error ?? "The run failed.";
    return { code: code.slice(0, 60), ar: (body.error ?? en).slice(0, 480), en: en.slice(0, 480) };
  } catch {
    return { code: "ERROR", ar: "تعذّر التشغيل.", en: "The run failed." };
  }
}

// ── Rights as of now (council F2) ────────────────────────────────────────────────────────────────

type Person = { id: string; active: boolean; role: string; permissions: unknown } | null;
const loadPerson = (tx: Tx, id: string | null): Promise<Person> => (id ? tx.employee.findUnique({ where: { id }, select: { id: true, active: true, role: true, permissions: true } }) : Promise.resolve(null));
const holds = (p: Person, module: string, sub: string) => {
  if (!p || !p.active) return false;
  const perms = effectivePermissions(p);
  return hasModuleAccess(perms, module) && hasSubPrivilege(perms, module, sub);
};

/**
 * The preparer may still make this schedule's documents (council ruling 4): active, the register's maintenance duty
 * accounting › recurring, the document duty accounting › journal_create (+ sales › invoices_create for an invoice).
 */
export async function preparerProblem(tx: Tx, s: Pick<Schedule, "createdBy" | "kind">): Promise<string | null> {
  const p = await loadPerson(tx, s.createdBy);
  if (!p) return "the preparer's account no longer exists";
  if (!p.active) return "the preparer's account is deactivated";
  if (!holds(p, "accounting", "recurring")) return "the preparer no longer holds accounting › recurring";
  if (!holds(p, "accounting", "journal_create")) return "the preparer no longer holds accounting › journal_create";
  if (s.kind === "SALES_INVOICE" && !holds(p, "sales", "invoices_create")) return "the preparer no longer holds sales › invoices_create";
  return null;
}

/** The auto-post authoriser may still post: active, the admin role (the posting gate) and accounting › journal_post. */
export async function authoriserProblem(tx: Tx, id: string | null): Promise<string | null> {
  const p = await loadPerson(tx, id);
  if (!p) return "the authoriser's account no longer exists";
  if (!p.active) return "the authoriser's account is deactivated";
  if (p.role !== "admin") return "the authoriser no longer has the admin role (the posting gate)";
  if (!holds(p, "accounting", "journal_post")) return "the authoriser no longer holds accounting › journal_post";
  return null;
}

const attention = (tx: Tx, s: Schedule, state: "PAUSED" | "AUTOPOST_WITHDRAWN", due: string) =>
  notify(tx, {
    event: "finance.recurring_attention", dedupeKey: `${s.id}:${state}:${due}`, actorId: SYSTEM_ACTOR,
    facts: { state, ref: refText(s.refNo), name: s.name, scheduleId: s.id }, people: { preparer: s.createdBy, authoriser: s.autoPostApprovedBy },
    entity: { type: "RecurringSchedule", id: s.id },
  });

/** Withdraw auto-post (the authoriser lost the right), logged with the reason and notified. Returns the schedule as it now is. */
async function withdrawAutoPost(tx: Tx, s: Schedule, why: string, due: string, ctx: AuditContext): Promise<Schedule> {
  await setAuditContext(tx, { ...ctx, reason: `auto-post withdrawn by the runner: ${why}`.slice(0, 500) });
  const next = await tx.recurringSchedule.update({ where: { id: s.id }, data: { autoPost: false, autoPostApprovedBy: null, autoPostApprovedAt: null, autoPostSodBypass: false } });
  await attention(tx, s, "AUTOPOST_WITHDRAWN", due);
  await setAuditContext(tx, { ...ctx, reason: ctx.reason ?? "recurring run" });
  return next;
}

// ── Making the document ──────────────────────────────────────────────────────────────────────────

const memo = (s: Schedule, p: JournalPayload, due: string) => `${p.description || s.name} — ${refText(s.refNo)} (${due})`.slice(0, 500);
export const snapshotOf = (s: Schedule): Snapshot => ({ payload: s.payload as unknown as Payload, autoPost: s.autoPost && !!s.autoPostApprovedBy, autoPostBy: s.autoPost ? s.autoPostApprovedBy : null, autoPostSodBypass: s.autoPost && s.autoPostSodBypass });

/** Make the occurrence's document from its SNAPSHOT inside `tx` (the caller holds the schedule's lock). */
export async function makeDocument(tx: Tx, s: Schedule, snap: Snapshot, due: string, ctx: AuditContext): Promise<Outcome> {
  const p = snap.payload;
  if (s.kind === "JOURNAL" && p.kind === "JOURNAL") {
    const day = parseBusinessDay(due);
    const state = await engineState(tx, day);
    if (!state.on) return { status: "SKIPPED", skipReason: state.reason };
    const input = { entryDate: day, description: memo(s, p, due), lines: journalLines(p) };
    const source = { type: "RECURRING", id: s.id, event: due };
    if (snap.autoPost && snap.autoPostBy) {
      const je = await postRecurringJournalIn(tx, input, { preparer: s.createdBy, poster: snap.autoPostBy, sodBypass: snap.autoPostSodBypass }, source);
      return { status: "POSTED", journalEntryId: je.id };
    }
    const je = await createManualJournalDraftIn(tx, input, s.createdBy, source);
    return { status: "CREATED", journalEntryId: je.id };
  }
  if (s.kind === "SALES_INVOICE" && p.kind === "SALES_INVOICE") {
    const priced = p.pricedAt ?? dayText(s.updatedAt);
    const r = await createManualDraftIn(tx, {
      customerId: p.customerId, family: p.family === "SIMPLIFIED" ? "SIMPLIFIED" : "STANDARD", lines: p.lines, paymentTermsDays: p.paymentTermsDays,
      notes: [`${refText(s.refNo)} · ${s.name} (${due})`, `الأسعار من الجدول بتاريخ ${priced} · Prices from the schedule as of ${priced}`, p.notes].filter(Boolean).join("\n"),
      supplyDate: due, requestKey: `recurring:${s.id}:${due}`,
    }, { ...ctx, actorId: s.createdBy });
    return { status: "CREATED", salesInvoiceId: r.id };
  }
  throw refuse("RECURRING_INVALID", "(the schedule's payload does not match its kind)", "(محتوى المعاملة لا يطابق نوعها)");
}

/** Move the schedule past occurrence `k` (to k + 1, or COMPLETED when the rule has ended). */
async function advance(tx: Tx, s: Schedule, k: number) {
  const next = occurrenceDate(ruleOf(s), k + 1);
  await tx.recurringSchedule.update({
    where: { id: s.id },
    data: { nextIndex: k + 1, nextRunDate: next ? parseBusinessDay(next) : null, status: next ? s.status : "COMPLETED", lastRunAt: new Date() },
  });
}

const runData = (o: Outcome) => ({
  status: o.status, journalEntryId: "journalEntryId" in o ? o.journalEntryId ?? null : null, salesInvoiceId: "salesInvoiceId" in o ? o.salesInvoiceId ?? null : null,
  skipReason: o.status === "SKIPPED" ? o.skipReason : null, errorCode: null, errorMessage: null,
});
const snapData = (snap: Snapshot) => ({ payload: snap.payload as unknown as Prisma.InputJsonValue, autoPost: snap.autoPost, autoPostBy: snap.autoPostBy, autoPostSodBypass: snap.autoPostSodBypass });
const snapOfRun = (r: { payload: unknown; autoPost: boolean; autoPostBy: string | null; autoPostSodBypass: boolean }): Snapshot => ({ payload: r.payload as Payload, autoPost: r.autoPost, autoPostBy: r.autoPostBy, autoPostSodBypass: r.autoPostSodBypass });

export type StepResult = { state: "busy" | "not-due" | "already" | "paused" | "CREATED" | "POSTED" | "SKIPPED" | "FAILED"; scheduleId: string; dueDate?: string; runId?: string; error?: { code: string; ar: string; en: string } };

/** Run the schedule's next occurrence if it is due on / before `today`. */
export async function runNext(scheduleId: string, today: string, trigger: RunTrigger, ctx: AuditContext): Promise<StepResult> {
  let due: string | undefined, k = -1, snap: Snapshot | null = null;
  try {
    return await prisma.$transaction(async (tx) => {
      await setAuditContext(tx, { ...ctx, reason: ctx.reason ?? "recurring run" });
      const got = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "RecurringSchedule" WHERE "id" = ${scheduleId} FOR UPDATE SKIP LOCKED`;
      if (!got.length) return { state: "busy" as const, scheduleId };
      let s = await tx.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
      if (s.status !== "ACTIVE" || !s.nextRunDate || dayText(s.nextRunDate) > today) return { state: "not-due" as const, scheduleId };
      due = dayText(s.nextRunDate); k = s.nextIndex;
      const prior = await tx.recurringRun.findUnique({ where: { scheduleId_dueDate: { scheduleId, dueDate: parseBusinessDay(due) } } });
      if (prior && prior.status !== "FAILED") {
        await advance(tx, s, k);
        return { state: "already" as const, scheduleId, dueDate: due, runId: prior.id };
      }
      // F2: the rights as of now.
      const noPreparer = await preparerProblem(tx, s);
      if (noPreparer) {
        await setAuditContext(tx, { ...ctx, reason: `paused by the runner: ${noPreparer}`.slice(0, 500) });
        await tx.recurringSchedule.update({ where: { id: s.id }, data: { status: "PAUSED", pausedAt: new Date(), pausedBy: SYSTEM_ACTOR, pauseReason: `المُعدّ لم يعد يملك الصلاحية — ${noPreparer}`.slice(0, 500) } });
        await attention(tx, s, "PAUSED", due);
        return { state: "paused" as const, scheduleId, dueDate: due };
      }
      if (s.autoPost) {
        const noAuth = await authoriserProblem(tx, s.autoPostApprovedBy);
        if (noAuth) s = await withdrawAutoPost(tx, s, noAuth, due, ctx);
      }
      snap = prior ? snapOfRun(prior) : snapshotOf(s);
      if (prior && snap.autoPost && (await authoriserProblem(tx, snap.autoPostBy))) snap = { ...snap, autoPost: false, autoPostSodBypass: false };
      const o = await makeDocument(tx, s, snap, due, ctx);
      const run = prior
        ? await tx.recurringRun.update({ where: { id: prior.id }, data: { ...runData(o), autoPost: snap.autoPost, autoPostSodBypass: snap.autoPostSodBypass, attempts: prior.attempts + 1, trigger, actorId: ctx.actorId } })
        : await tx.recurringRun.create({ data: { scheduleId, occurrenceIndex: k, dueDate: parseBusinessDay(due), ...snapData(snap), ...runData(o), trigger, actorId: ctx.actorId } });
      await advance(tx, s, k);
      return { state: o.status, scheduleId, dueDate: due, runId: run.id };
    }, TX_OPTS);
  } catch (e) {
    const err = await describeError(e);
    if (due === undefined) return { state: "FAILED", scheduleId, error: err };
    // Record the failure and move on — under the lock (waiting this time), and only if nobody made it meanwhile.
    const dueDay = due, firstSnap = snap as Snapshot | null;
    return prisma.$transaction(async (tx) => {
      await setAuditContext(tx, { ...ctx, reason: `recurring run failed: ${err.code}` });
      await tx.$queryRaw`SELECT "id" FROM "RecurringSchedule" WHERE "id" = ${scheduleId} FOR UPDATE`;
      let s = await tx.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
      const prior = await tx.recurringRun.findUnique({ where: { scheduleId_dueDate: { scheduleId, dueDate: parseBusinessDay(dueDay) } } });
      if (prior && prior.status !== "FAILED") return { state: "already" as const, scheduleId, dueDate: dueDay, runId: prior.id };
      // The withdrawal of the first attempt rolled back with it: withdraw again (logged, notified) when still due.
      if (s.autoPost) {
        const noAuth = await authoriserProblem(tx, s.autoPostApprovedBy);
        if (noAuth) s = await withdrawAutoPost(tx, s, noAuth, dueDay, { ...ctx, reason: `recurring run failed: ${err.code}` });
      }
      const fail = { status: "FAILED", journalEntryId: null, salesInvoiceId: null, skipReason: null, errorCode: err.code, errorMessage: errorText(err), trigger, actorId: ctx.actorId };
      // The snapshot of the first attempt: what this run would have made (the schedule as it was when it was due).
      const snapshot = firstSnap ?? snapshotOf(s);
      const run = prior
        ? await tx.recurringRun.update({ where: { id: prior.id }, data: { ...fail, attempts: prior.attempts + 1 } })
        : await tx.recurringRun.create({ data: { scheduleId, occurrenceIndex: k, dueDate: parseBusinessDay(dueDay), ...snapData(snapshot), ...fail } });
      if (s.status === "ACTIVE" && s.nextRunDate && dayText(s.nextRunDate) === dueDay) await advance(tx, s, s.nextIndex);
      return { state: "FAILED" as const, scheduleId, dueDate: dueDay, runId: run.id, error: err };
    }, TX_OPTS);
  }
}

export type RunSummary = { today: string; schedules: number; created: number; posted: number; skipped: number; failed: number; already: number; busy: number; paused: number; capped: boolean; results: StepResult[] };

/**
 * Run everything due on / before today (Asia/Riyadh): each ACTIVE schedule's occurrences in date order, at most
 * `perSchedule` per call (a long-paused or back-dated schedule catches up over several runs) and within `budgetMs`.
 */
export async function runDue(opts: { trigger: "CRON" | "MANUAL"; ctx: AuditContext; today?: string; scheduleIds?: string[]; perSchedule?: number; budgetMs?: number }): Promise<RunSummary> {
  const today = opts.today ?? dayText(riyadhDay());
  const started = Date.now(), budget = opts.budgetMs ?? 45_000, per = Math.min(Math.max(opts.perSchedule ?? 31, 1), 400);
  const due = await prisma.recurringSchedule.findMany({
    where: { status: "ACTIVE", nextRunDate: { lte: parseBusinessDay(today) }, ...(opts.scheduleIds ? { id: { in: opts.scheduleIds } } : {}) },
    orderBy: [{ nextRunDate: "asc" }, { refNo: "asc" }], select: { id: true }, take: 500,
  });
  const out: RunSummary = { today, schedules: due.length, created: 0, posted: 0, skipped: 0, failed: 0, already: 0, busy: 0, paused: 0, capped: false, results: [] };
  for (const { id } of due) {
    for (let i = 0; i < per; i++) {
      if (Date.now() - started > budget) { out.capped = true; break; }
      const r = await runNext(id, today, opts.trigger, opts.ctx);
      if (r.state === "not-due") break;
      out.results.push(r);
      if (r.state === "busy") { out.busy++; break; }
      if (r.state === "paused") { out.paused++; break; }
      if (r.state === "CREATED") out.created++;
      else if (r.state === "POSTED") out.posted++;
      else if (r.state === "SKIPPED") out.skipped++;
      else if (r.state === "FAILED") out.failed++;
      else if (r.state === "already") out.already++;
      if (r.state === "FAILED" && !r.dueDate) break;
      if (i === per - 1) out.capped = true;
    }
    if (out.capped && Date.now() - started > budget) break;
  }
  return out;
}

/**
 * «إعادة المحاولة» of a FAILED run, from the run's SNAPSHOT (what it would have made when it was due — council F3), never
 * from what the schedule became since. The rights are re-checked: a preparer without the right refuses the retry
 * (RECURRING_PREPARER_RIGHTS); an authoriser without it makes the retry a draft (auto-post withdrawn on the run). The
 * schedule does not move: it moved on when the run failed.
 */
export async function retryRun(runId: string, ctx: AuditContext): Promise<StepResult> {
  const head = await prisma.recurringRun.findUnique({ where: { id: runId }, select: { scheduleId: true, dueDate: true } });
  if (!head) throw refuse("NOT_FOUND");
  const due = dayText(head.dueDate);
  try {
    return await prisma.$transaction(async (tx) => {
      await setAuditContext(tx, { ...ctx, reason: ctx.reason ?? "recurring run retried" });
      await tx.$queryRaw`SELECT "id" FROM "RecurringSchedule" WHERE "id" = ${head.scheduleId} FOR UPDATE`;
      const run = await tx.recurringRun.findUniqueOrThrow({ where: { id: runId } });
      if (run.status !== "FAILED") throw refuse("RUN_NOT_FAILED");
      const s = await tx.recurringSchedule.findUniqueOrThrow({ where: { id: head.scheduleId } });
      if (s.status === "CANCELLED") throw refuse("RECURRING_STATE");
      const noPreparer = await preparerProblem(tx, s);
      if (noPreparer) throw refuse("RECURRING_PREPARER_RIGHTS", `(${noPreparer})`);
      let snap = snapOfRun(run);
      if (snap.autoPost && (await authoriserProblem(tx, snap.autoPostBy))) snap = { ...snap, autoPost: false, autoPostSodBypass: false };
      const o = await makeDocument(tx, s, snap, due, ctx);
      await tx.recurringRun.update({ where: { id: runId }, data: { ...runData(o), autoPost: snap.autoPost, autoPostSodBypass: snap.autoPostSodBypass, attempts: run.attempts + 1, trigger: "RETRY", actorId: ctx.actorId } });
      return { state: o.status, scheduleId: s.id, dueDate: due, runId };
    }, TX_OPTS);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "RUN_NOT_FAILED" || code === "RECURRING_STATE" || code === "NOT_FOUND") throw e;
    const err = await describeError(e);
    await prisma.$transaction(async (tx) => {
      await setAuditContext(tx, { ...ctx, reason: `recurring retry failed: ${err.code}` });
      const run = await tx.recurringRun.findUniqueOrThrow({ where: { id: runId } });
      if (run.status === "FAILED") await tx.recurringRun.update({ where: { id: runId }, data: { errorCode: err.code, errorMessage: errorText(err), attempts: run.attempts + 1, trigger: "RETRY", actorId: ctx.actorId } });
    }, TX_OPTS);
    return { state: "FAILED", scheduleId: head.scheduleId, dueDate: due, runId, error: err };
  }
}
