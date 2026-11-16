import { runCronJob } from "@/lib/cron/run";
import { alertZatcaFailures } from "@/lib/cron/watchdog";
import { certificateAlerts, processQueue } from "@/lib/zatca/pipeline";

/**
 * The e-invoicing queue (A4), called by Vercel Cron (vercel.json `crons`, daily at 02:00 UTC on Hobby — hourly on Vercel Pro; docs/zatca/RUNBOOK.md §1): reports the simplified documents
 * (24-hour window) and retries the standard documents whose synchronous clearance did not finish. Protected by
 * lib/cron/auth.ts (CRON_SECRET). Idempotent: each document is sent with the same signed bytes, under a lease, and a
 * decided one is never sent again. Also raises the certificate-expiry alerts (30 / 7 days). Answers counts only.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  // R1-d: authorised, locked per job, recorded in CronRun, a failure alerted (lib/cron/run.ts).
  return runCronJob(request, "zatca-reporting", async () => {
    try {
      const r = await processQueue({ budgetMs: 45_000 });
      const certAlerts = await certificateAlerts();
      // R1-d (owner 2-ج): any rejected or errored document raises «system.zatca_failed» (at most once an hour).
      const zatcaAlert = await alertZatcaFailures({ rejected: r.rejected, error: r.error }).catch(() => 0);
      return { body: { ok: true, due: r.due, processed: r.processed, cleared: r.cleared, reported: r.reported, rejected: r.rejected, retry: r.retry, error: r.error, certAlerts, zatcaAlert } };
    } catch (e) {
      console.error("[zatca] cron run failed:", (e as Error)?.name ?? "error");
      return { status: 500, body: { ok: false, error: "تعذّر تشغيل طابور الفوترة الإلكترونية", errorEn: "The e-invoicing queue could not run" } };
    }
  });
}
