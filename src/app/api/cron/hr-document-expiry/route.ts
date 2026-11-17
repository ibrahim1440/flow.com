import { runCronJob } from "@/lib/cron/run";
import { runExpiryCheck } from "@/lib/hr/services/document-expiry";
import { deliverPendingEmails } from "@/lib/notifications/deliver";
import { invoiceQueueDigest } from "@/lib/services/invoicing/requests";
import { accountingQuoteReminders } from "@/lib/services/sales/accounting-quote-commission";
import { prisma } from "@/lib/db";

/**
 * The daily document-expiry check (feat/hr-expiry-email), due from 06:00 Riyadh (R1-e: the hourly workflow calls it; the first call at or after
 * that hour runs, once per Riyadh day — lib/cron/jobs.ts); Vercel Cron at 03:00 UTC is the backup
 * (06:00 Asia/Riyadh — vercel.json `crons`). Protected by lib/cron/auth.ts (the CRON_SECRET bearer only).
 * Answers counts only. Idempotent: a second call the
 * same day notifies nobody again. Then e-mails what it wrote (when a provider is configured).
 * The same run is available to HR from HR settings («تشغيل الآن»: POST /api/hr/document-expiry/run).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  // R1-d: authorised, locked per job, recorded in CronRun, a failure alerted (lib/cron/run.ts).
  return runCronJob(request, "hr-document-expiry", async () => {
    try {
      const report = await runExpiryCheck({ trigger: "cron" });
      // «طلبات الفواتير» (BATCH 22 WP-C): the daily digest of overdue tax invoice requests rides this daily notification
      // run (no new cron). Its failure never fails the HR check.
      const invoiceQueue = await invoiceQueueDigest().catch((e: unknown) => { console.error("[invoice-queue] digest failed:", (e as Error)?.name ?? "error"); return null; });
      // «عمولة عرض المحاسب»: the reminder of a commission decision pending for 3+ business days rides the same run.
      const quoteCommission = await accountingQuoteReminders().catch((e: unknown) => { console.error("[quote-commission] reminders failed:", (e as Error)?.name ?? "error"); return null; });
      // «صلاحية العقد» has its own daily job since batch 24's council fix round 1: GET /api/cron/contract-notices.
      const emails = await deliverPendingEmails({ limit: 200 });
      return { body: { ok: true, ...report, invoiceQueue, quoteCommission, emails: emails.length } };
    } catch (e) {
      console.error("[hr-expiry] cron run failed:", (e as Error)?.name ?? "error");
      return { status: 500, body: { ok: false, error: "تعذّر تشغيل فحص انتهاء الوثائق", errorEn: "The document-expiry check could not run" } };
    }
  });
}
