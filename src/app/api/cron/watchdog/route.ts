import { runCronJob } from "@/lib/cron/run";
import { runWatchdog } from "@/lib/cron/watchdog";

/**
 * R1-d (owner 5-ب / 2-ج): the watchdog — a job that has not run on time («system.cron_late», once per job per day), the
 * message send queue backing up («system.message_backlog»: more than 50 waiting or the oldest over 2 hours, at most
 * once an hour), and the expired idempotency keys removed (idempotency_purge, 7 days). Called last by the GitHub
 * schedule every hour and daily by Vercel Cron (the backup). CRON_SECRET only (lib/cron/auth.ts). Counts only.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return runCronJob(request, "watchdog", async () => ({ body: await runWatchdog() }));
}
