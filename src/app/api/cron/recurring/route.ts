import { NextResponse } from "@/lib/api-response";
import { cronAuthorized } from "@/lib/cron/auth";
import { runDue, SYSTEM_ACTOR } from "@/lib/accounting/recurring/runner";
import { dueMonths } from "@/lib/accounting/deferrals";
import { lastEndedMonthEnd, schedulerGlRuns } from "@/lib/accounting/due-runners";

/**
 * «المعاملات المتكررة» — the scheduler (vercel.json `crons`, daily 01:10 UTC = 04:10 Riyadh). It CREATES DOCUMENTS, so
 * unlike the read-only jobs it accepts ONLY the CRON_SECRET bearer (lib/cron/auth.ts) — never the Vercel user-agent
 * fallback. Without the secret it answers 401 and the accountant runs the due transactions on demand («تشغيل المستحق
 * الآن», POST /api/accounting/recurring/run-due). Idempotent (the run key is the schedule and the due date). Answers
 * counts only.
 *
 * The monthly GL runs (deferral recognition, depreciation) are posted here ONLY under the register's live
 * StandingAuthorisation (batch 22 WP-A, council ruling 2 — schedulerGlRuns, lib/accounting/due-runners.ts): its
 * authoriser's rights are re-checked first (lapsed → revoked RIGHTS_LAPSED, logged, notified), and the entries name the
 * authoriser as postedBy — never the system actor. Without one, a register answers
 * `{ status: "SKIPPED", reason: "NOT_AUTHORISED" }`; the skip is logged with the deferral months waiting, and the
 * accountant dashboard's backlog alert says the scheduler does not recognise them; a person runs them from «تشغيل
 * المستحق الآن» through the central gate.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = cronAuthorized(request.headers);
  if (!auth.ok || auth.via !== "secret") return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  try {
    const r = await runDue({ trigger: "CRON", ctx: { actorId: SYSTEM_ACTOR, reason: "recurring: scheduler" }, budgetMs: 45_000 });
    const gl = await schedulerGlRuns();
    const unauthorised = (x: { status: string; reason?: string }) => x.status === "SKIPPED" && x.reason === "NOT_AUTHORISED";
    const waiting = unauthorised(gl.deferrals) ? await dueMonths(lastEndedMonthEnd()).catch(() => []) : [];
    if (waiting.length) console.warn(`[recurring] cron: deferral recognition SKIPPED (NOT_AUTHORISED) — ${waiting.length} ended month(s) waiting (${waiting[0].month}…): run «تشغيل المستحق الآن»`);
    // Counts and states only (no names, no amounts).
    const brief = (x: { status: string; reason?: string; authorisationId?: string | null; revokedAuthorisationId?: string | null }) => ({ status: x.status, ...(x.reason ? { reason: x.reason } : {}), authorised: !!x.authorisationId, ...(x.revokedAuthorisationId ? { revoked: true } : {}) });
    return NextResponse.json({
      ok: true, today: r.today, schedules: r.schedules, created: r.created, posted: r.posted, skipped: r.skipped, failed: r.failed, already: r.already, busy: r.busy, capped: r.capped,
      deferrals: { ...brief(gl.deferrals), ...(unauthorised(gl.deferrals) ? { waitingMonths: waiting.length } : {}), ...("posted" in gl.deferrals ? { recorded: gl.deferrals.recorded, posted: gl.deferrals.posted } : {}) },
      depreciation: brief(gl.depreciation),
    });
  } catch (e) {
    console.error("[recurring] cron run failed:", (e as Error)?.name ?? "error");
    return NextResponse.json({ ok: false, error: "تعذّر تشغيل المعاملات المتكررة", errorEn: "The recurring transactions could not run" }, { status: 500 });
  }
}
