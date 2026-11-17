// R1-d (owner 5-ب): the one way a scheduled job runs — authorised by CRON_SECRET (lib/cron/auth.ts), never twice at once
// (the CronRun row: a partial UNIQUE index on (job) WHERE status = 'RUNNING' is the per-job lock), recorded with its
// outcome, and a failure raises the «system.cron_failed» alert to the people who hold Settings at edit.
//
// R1-e: the hourly workflow (.github/workflows/cron.yml — started by cron-job.org, GitHub's own schedule every 3 hours as
// the fallback) and the Vercel daily cron (the backup) all call the same routes; whichever arrives second while the first still runs is answered 200 «skipped» and logged
// SKIPPED. A run that died without finishing (the function timed out) is closed as FAILED once it is older than the
// stale limit, so it can never hold the lock for ever.
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { cronAuthorized } from "@/lib/cron/auth";
import { cronTriggerOf, cronErrorText, cronSlotKey, cronNotDue, cronOriginOf, type CronJob, type CronTrigger, type CronOrigin } from "@/lib/cron/jobs";
export { CRON_JOBS, cronTriggerOf, cronErrorText, type CronJob, type CronTrigger } from "@/lib/cron/jobs";


/** A run older than this with no finish recorded is closed as FAILED (Vercel's maxDuration is 60 s; far above it). */
export const CRON_STALE_MS = 15 * 60_000;

/** The log text of a run closed because it never recorded its end (a log entry, never an API answer). */
const STALE_RUN = "stale: the run never recorded its end (timed out or crashed)";

export type CronWork = { status?: number; body: Record<string, unknown> };


function isUnique(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2002";
}

/**
 * R1-d gate M2: at most once per job per day — like «system.cron_late» — and again after the job has recovered: the key
 * carries the last successful run before this failure, so failures in a row share one alert, and a failure after a
 * success (the job came back and broke again) is a new one.
 */
export async function cronFailedKey(job: CronJob, now = new Date()): Promise<string> {
  const lastOk = await prisma.cronRun.findFirst({ where: { job, status: "OK" }, orderBy: { startedAt: "desc" }, select: { id: true } });
  return `${job}:${now.toISOString().slice(0, 10)}:${lastOk?.id ?? "none"}`;
}

async function alertFailed(job: CronJob, runId: string, error: string) {
  try {
    const { notify } = await import("@/lib/notifications/notify");
    const { deliverEvent } = await import("@/lib/notifications/deliver");
    const dedupeKey = await cronFailedKey(job);
    const n = await notify(prisma, { event: "system.cron_failed", dedupeKey, entity: { type: "CronRun", id: runId }, facts: { job, error } });
    if (n.inserted > 0) await deliverEvent(prisma, n.dedupeKey).catch(() => undefined);
  } catch (e) {
    console.error("[cron] could not raise the failure alert:", (e as Error)?.name ?? "error");
  }
}

/**
 * Run `work` as `job`: 401 unless authorised; 200 `{ ok: true, skipped: "already-running" }` when it is already running;
 * otherwise the work's own answer, recorded OK (2xx) or FAILED (≥ 500 or thrown — then 500 and the alert).
 */
export async function runCronJob(request: Request, job: CronJob, work: () => Promise<CronWork>, opts: RunOpts = {}): Promise<Response> {
  const auth = cronAuthorized(request.headers);
  if (!auth.ok) return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  const trigger = cronTriggerOf(request.headers);
  return runLockedJob(job, trigger, work, { ...opts, origin: opts.origin ?? cronOriginOf(request.headers, trigger) });
}

/** `now`: the run's moment (tests; the real clock otherwise). `origin`: the GitHub run and source that called. */
export type RunOpts = { now?: Date; origin?: CronOrigin };

/**
 * The job's lock, record and alert without the CRON_SECRET check — for a run a signed-in person starts (R1-d gate L1:
 * «شغّل الآن» on the message log), authorised by the route first. A scheduled run of the same job going on at that moment
 * makes this one SKIPPED, and the other way round.
 *
 * R1-e (owner decision 25 = أ): the INSERT of the RUNNING row is the decision. Two partial UNIQUE indexes guard it —
 * (job) WHERE RUNNING (one at a time, every job) and (job, slotKey) WHERE RUNNING or OK (once per period, the jobs that
 * have one: lib/cron/jobs.ts CRON_SLOT). Whoever loses the INSERT — at the same moment or an hour later — is recorded
 * SKIPPED («already-running» / «already-done») and the work never starts. A FAILED run leaves both indexes, so the next
 * call in the same period tries again.
 */
export async function runLockedJob(job: CronJob, trigger: CronTrigger, work: () => Promise<CronWork>, opts: RunOpts = {}): Promise<Response> {
  const now = opts.now ?? new Date();
  const origin: CronOrigin = opts.origin ?? { externalRunId: null, externalRunAttempt: null, source: trigger === "github" ? null : trigger };
  const slotKey = cronSlotKey(job, now);
  const skip = async (reason: string) => {
    await prisma.cronRun.create({ data: { job, trigger, status: "SKIPPED", startedAt: now, finishedAt: now, summary: { reason }, slotKey, ...origin } });
    return NextResponse.json({ ok: true, skipped: reason });
  };
  // A daily job runs from its due hour (Riyadh) on — before it, nothing.
  if (cronNotDue(job, now)) return skip("not-due");

  // A run whose process died after it took the lock (no OK, no FAILED) holds it for CRON_STALE_MS at most: then it is
  // closed as FAILED here, which frees both the lock and its period, and this call runs. Its effects are guarded per item.
  await prisma.cronRun.updateMany({
    where: { job, status: "RUNNING", startedAt: { lt: new Date(now.getTime() - CRON_STALE_MS) } },
    data: { status: "FAILED", finishedAt: now, error: STALE_RUN },
  });
  let runId: string;
  try {
    runId = (await prisma.cronRun.create({ data: { job, trigger, startedAt: now, slotKey, ...origin }, select: { id: true } })).id;
  } catch (err) {
    if (!isUnique(err)) throw err;
    // Which index refused it: a success already in this period, or a run still going on.
    const done = slotKey ? await prisma.cronRun.findFirst({ where: { job, slotKey, status: "OK" }, select: { id: true } }) : null;
    return skip(done ? "already-done" : "already-running");
  }

  try {
    const out = await work();
    const status = out.status ?? 200;
    const failed = status >= 500;
    const error = failed ? String(out.body.errorEn ?? out.body.error ?? `status ${status}`).slice(0, 300) : null;
    await prisma.cronRun.update({
      where: { id: runId },
      data: { status: failed ? "FAILED" : "OK", finishedAt: new Date(), summary: JSON.parse(JSON.stringify(out.body)), error },
    });
    if (failed) await alertFailed(job, runId, error!);
    return NextResponse.json(out.body, { status });
  } catch (err) {
    const error = cronErrorText(err);
    console.error(`[cron] ${job} failed:`, (err as Error)?.name ?? "error");
    await prisma.cronRun.update({ where: { id: runId }, data: { status: "FAILED", finishedAt: new Date(), error } }).catch(() => undefined);
    await alertFailed(job, runId, error);
    return NextResponse.json({ ok: false, error: "تعذّر تشغيل المهمة المجدولة", errorEn: "The scheduled job could not run", job }, { status: 500 });
  }
}
