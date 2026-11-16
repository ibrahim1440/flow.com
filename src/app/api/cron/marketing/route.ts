import { runCronJob } from "@/lib/cron/run";
import { runMarketingJobs } from "@/lib/marketing/server/jobs";

/**
 * The marketing automation engine's scheduler entry (publisher, journeys, WhatsApp sender, alerts,
 * daily decisions). Protected by lib/cron/auth.ts. Not added to vercel.json: on the Hobby plan Vercel
 * refuses crons more frequent than daily (docs/marketing/OPERATIONS.md — pick a scheduler).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  // R1-d: authorised, locked per job, recorded in CronRun, a failure alerted (lib/cron/run.ts).
  return runCronJob(request, "marketing", async () => {
    try {
      const results = await runMarketingJobs("cron");
      return { body: { ok: true, results: results.map((r) => ({ job: r.job, status: r.status })) } };
    } catch (e) {
      console.error("[marketing] cron run failed:", (e as Error)?.name ?? "error");
      return { status: 500, body: { ok: false, error: "تعذّر تشغيل مهام التسويق", errorEn: "Marketing jobs could not run" } };
    }
  });
}
