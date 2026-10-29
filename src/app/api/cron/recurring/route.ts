import { NextResponse } from "@/lib/api-response";
import { cronAuthorized } from "@/lib/cron/auth";
import { runDue, SYSTEM_ACTOR } from "@/lib/accounting/recurring/runner";
import { dueMonths } from "@/lib/accounting/deferrals";
import { lastEndedMonthEnd } from "@/lib/accounting/due-runners";

/**
 * «المعاملات المتكررة» — the scheduler (vercel.json `crons`, daily 01:10 UTC = 04:10 Riyadh). It CREATES DOCUMENTS, so
 * unlike the read-only jobs it accepts ONLY the CRON_SECRET bearer (lib/cron/auth.ts) — never the Vercel user-agent
 * fallback. Without the secret it answers 401 and the accountant runs the due transactions on demand («تشغيل المستحق
 * الآن», POST /api/accounting/recurring/run-due). Idempotent (the run key is the schedule and the due date). Answers
 * counts only.
 *
 * The monthly GL runs (deferral recognition, depreciation) are NOT posted here (council ruling 2, interim): the system
 * actor holds no standing authorisation for them. Both answer `{ status: "SKIPPED", reason: "NOT_AUTHORISED" }`; the
 * skip is logged with the deferral months waiting, and the accountant dashboard's backlog alert says the scheduler does
 * not recognise them. A person runs them from «تشغيل المستحق الآن» through the central gate. The full design (one
 * generic StandingAuthorisation, re-checked at run time) is in FOLLOWUPS.md for the next batch.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = cronAuthorized(request.headers);
  if (!auth.ok || auth.via !== "secret") return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  try {
    const r = await runDue({ trigger: "CRON", ctx: { actorId: SYSTEM_ACTOR, reason: "recurring: scheduler" }, budgetMs: 45_000 });
    const waiting = await dueMonths(lastEndedMonthEnd()).catch(() => []);
    if (waiting.length) console.warn(`[recurring] cron: deferral recognition SKIPPED (NOT_AUTHORISED) — ${waiting.length} ended month(s) waiting (${waiting[0].month}…): run «تشغيل المستحق الآن»`);
    return NextResponse.json({
      ok: true, today: r.today, schedules: r.schedules, created: r.created, posted: r.posted, skipped: r.skipped, failed: r.failed, already: r.already, busy: r.busy, capped: r.capped,
      deferrals: { status: "SKIPPED", reason: "NOT_AUTHORISED", waitingMonths: waiting.length },
      depreciation: { status: "SKIPPED", reason: "NOT_AUTHORISED" },
    });
  } catch (e) {
    console.error("[recurring] cron run failed:", (e as Error)?.name ?? "error");
    return NextResponse.json({ ok: false, error: "تعذّر تشغيل المعاملات المتكررة", errorEn: "The recurring transactions could not run" }, { status: 500 });
  }
}
