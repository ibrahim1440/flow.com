import { runCronJob } from "@/lib/cron/run";
import { runYearEndCreditClawback } from "@/lib/services/commissions/credit-clawback";
import { lastEndedRiyadhYear } from "@/lib/services/commissions/credit-clawback-rule";

/**
 * Year-end clawback of commission on credit notes left unused (owner decision, 29 Oct 2026;
 * docs/sales/COMMISSION_RULES.md §10, lib/services/commissions/credit-clawback.ts).
 *
 * It WRITES PAY (negative commission adjustments), so like the recurring-transactions job it accepts ONLY
 * the CRON_SECRET bearer (lib/cron/auth.ts) — never the Vercel user-agent fallback. `?year=YYYY` names the
 * year; without it, the last calendar year that has ended in Riyadh. Safe to call any number of times:
 * each (credit note, person) is written once, and a year that has not ended is refused. Answers counts only
 * (no names, no amounts).
 *
 * Scheduled (R1-e): every hourly workflow run calls it; it is due from 06:00 Riyadh and runs at most once per Riyadh day
 * (lib/cron/jobs.ts DUE_FROM_RIYADH_HOUR / CRON_SLOT). Outside the first days after a year ends it finds nothing new to
 * write and answers zero counts. vercel.json keeps a daily backup at 03:15 UTC (06:15 Riyadh).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  // R1-d: authorised, locked per job, recorded in CronRun, a failure alerted (lib/cron/run.ts).
  return runCronJob(request, "commission-credit-clawback", async () => {
    const param = new URL(request.url).searchParams.get("year");
    const year = param ? Number(param) : lastEndedRiyadhYear(new Date());
    try {
      const r = await runYearEndCreditClawback({ year, actorId: null });
      return { body: { ok: true, year: r.year, creditNotes: r.creditNotes, outcomes: r.outcomes, linesWritten: r.entries.length, linesAlreadyDone: r.alreadyLines } };
    } catch (e) {
      const x = e as { _appCode?: number; message?: string };
      if (typeof x?._appCode === "number" && typeof x.message === "string") return { status: x._appCode, body: { error: x.message } };
      console.error("[commission-credit-clawback] cron run failed:", (e as Error)?.name ?? "error");
      return { status: 500, body: { ok: false, error: "تعذّر تشغيل استرداد عمولة الإشعارات الدائنة", errorEn: "The credit-note commission clawback could not run" } };
    }
  });
}
