// R1-e (owner decision 25 = أ): does the GitHub fallback schedule have anything to do? The hourly trigger is external
// (cron-job.org → workflow_dispatch); GitHub's own schedule (every 3 hours) asks this first and stops early when nothing
// is needed. Needed, for every job the workflow calls:
//   · an hourly job (dispatch, zatca-reporting, marketing, watchdog) whose last success is older than 70 minutes;
//   · a daily job that is due (past its Riyadh hour) and has not succeeded today (Riyadh).
// The answer names the jobs only — no data. `reason` is one line for the workflow's log: why it runs or ends early.
import { prisma } from "@/lib/db";
import { NEEDED_AFTER_MS, WORKFLOW_DAILY_JOBS, WORKFLOW_HOURLY_JOBS, cronNotDue, cronSlotKey } from "@/lib/cron/jobs";

export type CronNeeded = { needed: boolean; jobs: string[]; reason: string };

export async function cronNeeded(now = new Date()): Promise<CronNeeded> {
  const jobs: string[] = [];
  const late: string[] = [], due: string[] = [];
  const last = await prisma.cronRun.groupBy({ by: ["job"], where: { status: "OK", job: { in: WORKFLOW_HOURLY_JOBS } }, _max: { startedAt: true } });
  const lastOk = new Map(last.map((r) => [r.job, r._max.startedAt]));
  for (const job of WORKFLOW_HOURLY_JOBS) {
    const at = lastOk.get(job);
    if (!at || now.getTime() - at.getTime() > NEEDED_AFTER_MS) { jobs.push(job); late.push(job); }
  }
  for (const job of WORKFLOW_DAILY_JOBS) {
    if (cronNotDue(job, now)) continue;
    const done = await prisma.cronRun.findFirst({ where: { job, status: "OK", slotKey: cronSlotKey(job, now) }, select: { id: true } });
    if (!done) { jobs.push(job); due.push(job); }
  }
  const reason = jobs.length === 0
    ? "every hourly job succeeded within 70 minutes and no daily job is due"
    : [late.length ? `no success within 70 minutes: ${late.join(", ")}` : "", due.length ? `due today (Riyadh) and not done: ${due.join(", ")}` : ""].filter(Boolean).join("; ");
  return { needed: jobs.length > 0, jobs, reason };
}
