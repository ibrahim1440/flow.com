import { runCronJob } from "@/lib/cron/run";
import { runWorkspaceJobs } from "@/lib/workspace/server/reminders";
import { notifyStaleBuckets } from "@/lib/services/station/roast-v2";

/**
 * «مساحة عملي» scheduler entry: sends the task and appointment reminders and escalations that are due.
 * Protected by lib/cron/auth.ts (CRON_SECRET). Idempotent — any number of calls, at any interval, never
 * send a reminder twice. vercel.json runs it daily (the Hobby plan's limit) as a floor; an external
 * scheduler every 5 minutes gives the reminders their intended precision (docs/workspace/OPERATIONS.md).
 * Signed-in pages also run it opportunistically (at most once a minute per instance).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  // R1-d: authorised, locked per job, recorded in CronRun, a failure alerted (lib/cron/run.ts).
  return runCronJob(request, "workspace", async () => {
    try {
      const summary = await runWorkspaceJobs("cron");
      // «محطة التحميص v2»: buckets left in staging over 72 h (once per bucket); never fails the workspace run.
      const staging = await notifyStaleBuckets().catch((e) => { console.error("[workspace] stale buckets failed:", (e as Error)?.name ?? "error"); return null; });
      return { body: { ok: true, ...summary, ...(staging ? { stagingStale: staging } : {}) } };
    } catch (e) {
      console.error("[workspace] cron run failed:", (e as Error)?.name ?? "error");
      return { status: 500, body: { ok: false, error: "تعذّر تشغيل مهام مساحة العمل", errorEn: "Workspace jobs could not run" } };
    }
  });
}
