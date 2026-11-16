import { cronAuthorized } from "@/lib/cron/auth";
import { runCronJob, runLockedJob } from "@/lib/cron/run";
import { requireSub } from "@/lib/auth-server";
import { runAutomationDispatch } from "@/lib/automation/dispatcher";

/**
 * Run the dispatcher: process pending events, raise due tasks, send what is due.
 *
 * Called by a scheduler with `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends exactly
 * that header, and calls with GET), or by a signed-in user from the message log. Events are
 * normally processed right after the request that raised them; this route is what retries
 * failures, sends delayed steps and notices tasks falling due when nobody is using the system.
 */
export const maxDuration = 60;

async function handle(request: Request) {
  // R1-d: the scheduler (GitHub every hour, Vercel daily as the backup) goes through runCronJob — CRON_SECRET only
  // (lib/cron/auth.ts), one run at a time, recorded in CronRun, a failure alerted. A person from the message log keeps
  // the smaller budget and the same lock (below).
  if (cronAuthorized(request.headers).ok) {
    return runCronJob(request, "dispatch", async () => ({ body: { ...(await runAutomationDispatch({ budgetMs: 45_000, maxSends: 20 })) } }));
  }
  const { error } = await requireSub("automation", "manage_messages");
  if (error) return error;
  // R1-d gate L1: the person's run takes the same per-job lock (recorded trigger "manual"); while a scheduled run is going
  // on it is SKIPPED — 200 { ok, skipped: "already-running" } — instead of a second dispatcher in parallel.
  return runLockedJob("dispatch", "manual", async () => ({ body: { ...(await runAutomationDispatch({ budgetMs: 20_000, maxSends: 10 })) } }));
}

export const GET = handle;
export const POST = handle;
