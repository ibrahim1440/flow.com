import { NextResponse } from "@/lib/api-response";
import { cronAuthorized } from "@/lib/cron/auth";
import { runExpiryCheck } from "@/lib/hr/services/document-expiry";
import { deliverPendingEmails } from "@/lib/notifications/deliver";

/**
 * The daily document-expiry check (feat/hr-expiry-email), called by Vercel Cron once a day at 03:00 UTC
 * (06:00 Asia/Riyadh — vercel.json `crons`). Protected by lib/cron/auth.ts (CRON_SECRET, or the Vercel
 * Cron user agent on Vercel when no secret is set). Answers counts only. Idempotent: a second call the
 * same day notifies nobody again. Then e-mails what it wrote (when a provider is configured).
 * The same run is available to HR from HR settings («تشغيل الآن»: POST /api/hr/document-expiry/run).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = cronAuthorized(request.headers);
  if (!auth.ok) return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  try {
    const report = await runExpiryCheck({ trigger: "cron" });
    const emails = await deliverPendingEmails({ limit: 200 });
    return NextResponse.json({ ok: true, ...report, emails: emails.length });
  } catch (e) {
    console.error("[hr-expiry] cron run failed:", (e as Error)?.name ?? "error");
    return NextResponse.json({ ok: false, error: "تعذّر تشغيل فحص انتهاء الوثائق", errorEn: "The document-expiry check could not run" }, { status: 500 });
  }
}
