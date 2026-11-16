// R1-d (owner 5-ب / 2-ج): what the scheduler itself cannot tell anyone — a job that has not run on time (the GitHub
// schedule is best-effort: delayed under load, and stopped entirely if the workflow is disabled), and messages piling up
// in the send queue. Run by the watchdog job (every hour on the GitHub schedule, daily by Vercel as the backup).
// Alerts go to the people who hold Settings at edit, at most once per job per day (late) / once per hour (backlog).
// It also removes the expired idempotency keys (R1-b L1: idempotency_purge, 7 days).
import { prisma } from "@/lib/db";
import { LATE_AFTER_MS, BACKLOG_MAX, BACKLOG_AGE_MS, MIN, type CronJob } from "@/lib/cron/jobs";
export { LATE_AFTER_MS, BACKLOG_MAX, BACKLOG_AGE_MS } from "@/lib/cron/jobs";


export type LateJob = { job: CronJob; lastOk: string | null; minutes: number };

async function raise(event: string, dedupeKey: string, facts: Record<string, string | number | null>) {
  const { notify } = await import("@/lib/notifications/notify");
  const { deliverEvent } = await import("@/lib/notifications/deliver");
  const n = await notify(prisma, { event, dedupeKey, entity: { type: "CronRun", id: dedupeKey }, facts });
  if (n.inserted > 0) await deliverEvent(prisma, n.dedupeKey).catch(() => undefined);
  return n.inserted;
}

/** Which jobs are late at `now`. A job that has never succeeded counts from the first run ever recorded (so a fresh
 *  deployment is not late on its first minute, but a schedule that never starts is noticed). */
export async function lateJobs(now = new Date()): Promise<LateJob[]> {
  const rows = await prisma.cronRun.groupBy({ by: ["job"], where: { status: "OK" }, _max: { startedAt: true } });
  const lastOk = new Map(rows.map((r) => [r.job, r._max.startedAt]));
  const first = (await prisma.cronRun.aggregate({ _min: { startedAt: true } }))._min.startedAt;
  const late: LateJob[] = [];
  for (const [job, after] of Object.entries(LATE_AFTER_MS) as [CronJob, number][]) {
    const ref = lastOk.get(job) ?? first;
    if (!ref) continue;
    const age = now.getTime() - ref.getTime();
    if (age > after) late.push({ job, lastOk: lastOk.get(job)?.toISOString() ?? null, minutes: Math.round(age / MIN) });
  }
  return late;
}

/** Messages waiting to be sent (WhatsApp + e-mail: QUEUED or SENDING) and the oldest one's age. */
export async function messageBacklog(now = new Date()): Promise<{ waiting: number; oldestMinutes: number }> {
  const waiting = ["QUEUED", "SENDING"] as const;
  const [wa, em, waOld, emOld] = await Promise.all([
    prisma.whatsAppMessage.count({ where: { status: { in: [...waiting] } } }),
    prisma.emailMessage.count({ where: { status: { in: [...waiting] } } }),
    prisma.whatsAppMessage.aggregate({ where: { status: { in: [...waiting] } }, _min: { createdAt: true } }),
    prisma.emailMessage.aggregate({ where: { status: { in: [...waiting] } }, _min: { createdAt: true } }),
  ]);
  const oldest = [waOld._min.createdAt, emOld._min.createdAt].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
  return { waiting: wa + em, oldestMinutes: oldest ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / MIN)) : 0 };
}

export async function runWatchdog(now = new Date()) {
  const late = await lateJobs(now);
  const day = now.toISOString().slice(0, 10);
  let lateAlerts = 0;
  for (const l of late) {
    lateAlerts += await raise("system.cron_late", `${l.job}:${day}`, { job: l.job, lastOk: l.lastOk, minutes: l.minutes });
  }
  const backlog = await messageBacklog(now);
  let backlogAlert = 0;
  if (backlog.waiting > BACKLOG_MAX || backlog.oldestMinutes * MIN > BACKLOG_AGE_MS) {
    backlogAlert = await raise("system.message_backlog", now.toISOString().slice(0, 13), { waiting: backlog.waiting, oldestMinutes: backlog.oldestMinutes });
  }
  const { purgeExpiredIdempotencyKeys } = await import("@/lib/idempotency");
  const purgedKeys = await purgeExpiredIdempotencyKeys();
  return { ok: true, late: late.map((l) => l.job), lateAlerts, backlog, backlogAlert, purgedKeys };
}

/** Owner 2-ج: any ZATCA failure in a queue run (rejected or errored documents) — at most one alert per hour. */
export async function alertZatcaFailures(r: { rejected: number; error: number }, now = new Date()) {
  if ((r.rejected ?? 0) + (r.error ?? 0) <= 0) return 0;
  return raise("system.zatca_failed", now.toISOString().slice(0, 13), { rejected: r.rejected, failed: r.error });
}
