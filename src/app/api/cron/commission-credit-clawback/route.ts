import { NextResponse } from "@/lib/api-response";
import { cronAuthorized } from "@/lib/cron/auth";
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
 * TODO(scheduler): NOT in vercel.json `crons` yet — the orchestrator decides. A daily call during the first
 * days of January is enough and harmless (idempotent), e.g. `{ "path": "/api/cron/commission-credit-clawback",
 * "schedule": "20 1 1-7 1 *" }` (01:20 UTC = 04:20 Riyadh, 1–7 January). Until then it is run by calling this
 * route with the secret.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = cronAuthorized(request.headers);
  if (!auth.ok || auth.via !== "secret") return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  const param = new URL(request.url).searchParams.get("year");
  const year = param ? Number(param) : lastEndedRiyadhYear(new Date());
  try {
    const r = await runYearEndCreditClawback({ year, actorId: null });
    return NextResponse.json({ ok: true, year: r.year, creditNotes: r.creditNotes, outcomes: r.outcomes, linesWritten: r.entries.length, linesAlreadyDone: r.alreadyLines });
  } catch (e) {
    const x = e as { _appCode?: number; message?: string };
    if (typeof x?._appCode === "number" && typeof x.message === "string") return NextResponse.json({ error: x.message }, { status: x._appCode });
    console.error("[commission-credit-clawback] cron run failed:", (e as Error)?.name ?? "error");
    return NextResponse.json({ ok: false, error: "تعذّر تشغيل استرداد عمولة الإشعارات الدائنة", errorEn: "The credit-note commission clawback could not run" }, { status: 500 });
  }
}
