import { NextResponse } from "@/lib/api-response";
import { cronAuthorized } from "@/lib/cron/auth";
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
  const auth = cronAuthorized(request.headers);
  if (!auth.ok) return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  try {
    const r = await processQueue({ budgetMs: 45_000 });
    const certAlerts = await certificateAlerts();
    return NextResponse.json({ ok: true, due: r.due, processed: r.processed, cleared: r.cleared, reported: r.reported, rejected: r.rejected, retry: r.retry, error: r.error, certAlerts });
  } catch (e) {
    console.error("[zatca] cron run failed:", (e as Error)?.name ?? "error");
    return NextResponse.json({ ok: false, error: "تعذّر تشغيل طابور الفوترة الإلكترونية", errorEn: "The e-invoicing queue could not run" }, { status: 500 });
  }
}
