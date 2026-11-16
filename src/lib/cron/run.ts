// R1-d (owner 5-ب): the one way a scheduled job runs — authorised by CRON_SECRET (lib/cron/auth.ts), never twice at once
// (the CronRun row: a partial UNIQUE index on (job) WHERE status = 'RUNNING' is the per-job lock), recorded with its
// outcome, and a failure raises the «system.cron_failed» alert to the people who hold Settings at edit.
//
// The GitHub Actions schedule (every hour, .github/workflows/cron.yml) and the Vercel daily cron (the backup)
// both call the same routes; whichever arrives second while the first still runs is answered 200 «skipped» and logged
// SKIPPED. A run that died without finishing (the function timed out) is closed as FAILED once it is older than the
// stale limit, so it can never hold the lock for ever.
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { cronAuthorized } from "@/lib/cron/auth";
import { cronTriggerOf, cronErrorText, type CronJob, type CronTrigger } from "@/lib/cron/jobs";
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
export async function runCronJob(request: Request, job: CronJob, work: () => Promise<CronWork>): Promise<Response> {
  const auth = cronAuthorized(request.headers);
  if (!auth.ok) return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  return runLockedJob(job, cronTriggerOf(request.headers), work);
}

/**
 * The job's lock, record and alert without the CRON_SECRET check — for a run a signed-in person starts (R1-d gate L1:
 * «شغّل الآن» on the message log), authorised by the route first. A scheduled run of the same job going on at that moment
 * makes this one SKIPPED, and the other way round.
 */
export async function runLockedJob(job: CronJob, trigger: CronTrigger, work: () => Promise<CronWork>): Promise<Response> {

  await prisma.cronRun.updateMany({
    where: { job, status: "RUNNING", startedAt: { lt: new Date(Date.now() - CRON_STALE_MS) } },
    data: { status: "FAILED", finishedAt: new Date(), error: STALE_RUN },
  });
  let runId: string;
  try {
    runId = (await prisma.cronRun.create({ data: { job, trigger }, select: { id: true } })).id;
  } catch (err) {
    if (!isUnique(err)) throw err;
    await prisma.cronRun.create({ data: { job, trigger, status: "SKIPPED", finishedAt: new Date(), summary: { reason: "already-running" } } });
    return NextResponse.json({ ok: true, skipped: "already-running" });
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
