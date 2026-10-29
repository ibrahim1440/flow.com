// The monthly runs that ride on «المعاملات المتكررة»'s «تشغيل المستحق الآن» (POST /api/accounting/recurring/run-due) —
// integration/qoyod-program, APIS.md. The scheduler (/api/cron/recurring) calls them ONLY under a live
// StandingAuthorisation of the register (batch 22 WP-A, council ruling 2: schedulerGlRuns below; the authoriser's rights
// re-checked at every run, revoked when they lapsed); without one it answers SKIPPED NOT_AUTHORISED:
//   • «قوالب التأجيل»: the monthly recognition, runDueDeferralRecognition (src/lib/accounting/deferrals.ts);
//   • «الإهلاك»: the monthly depreciation, runDepreciationForMonth (src/lib/accounting/fixed-assets/runs.ts).
// Both are idempotent (one recognised line per schedule and month — deferral_line_guard; one live depreciation line per
// asset and month — FixedAssetDepreciationLine_asset_period_live_key), so a double fire or a retry is safe.
// Both run only for months that have ENDED (Asia/Riyadh): the latest is the month before today's. Both are skipped (not
// called at all) while accounting is not active or before the go-live day — the engine would only record SKIPPED runs,
// and the go-live opening carries what came before. The depreciation also runs only when that month's fiscal period
// exists and is OPEN (a closed or soft-closed month is left to a person; catch-up is automatic in the next open month).
// These functions check no permission: the routes do (register-access.ts).
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { dayText, riyadhDay } from "./dates";
import { runDueDeferralRecognition } from "./deferrals";
import { runDepreciationForMonth } from "./fixed-assets/runs";
import type { AuditContext } from "./audit";
import { authoriseRun, type RegisterWide } from "./standing-auth";

// NOT_AUTHORISED: the scheduler holds no live standing authorisation to post this register's entries (none granted, or
// revoked — the authoriser's rights lapsed); a person runs it from «تشغيل المستحق الآن» through the central gate.
export type DueSkip = "NOT_ACTIVE" | "BEFORE_GO_LIVE" | "PERIOD_NOT_OPEN" | "NOT_ALLOWED" | "NOT_SCHEDULED" | "NOT_AUTHORISED";
/** A run made under a standing authorisation: its id goes on the run, its sodBypass on the entry. */
type Standing = { id: string; sodBypass: boolean };
export type DeferralDue =
  | { status: "SKIPPED"; reason: DueSkip; detail?: string }
  | { status: "RAN"; through: string; recorded: number; posted: number; skipped: number; months: { month: string; status: string; runId: string | null }[]; stoppedAt: null | { month: string; code: string; message: string } };
export type DepreciationDue =
  | { status: "SKIPPED"; reason: DueSkip; month?: string; detail?: string }
  | { status: "RAN"; month: string; result: "posted" | "nothing"; runId: string | null; glState: string | null; assets: number; total: string | null }
  | { status: "REFUSED"; month: string; code: string; message: string };

/** The last day of the month before `today` — the latest month that has ended. */
export function lastEndedMonthEnd(today: Date = riyadhDay()): Date {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
}

async function bookState(today: Date): Promise<{ on: true; goLive: Date } | { on: false; reason: DueSkip; detail: string }> {
  const s = await prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true, goLiveDate: true } });
  if (!s?.accountingActive) return { on: false, reason: "NOT_ACTIVE", detail: "accounting is not active" };
  if (!s.goLiveDate || today < s.goLiveDate) return { on: false, reason: "BEFORE_GO_LIVE", detail: s.goLiveDate ? `go-live ${dayText(s.goLiveDate)}` : "no go-live date" };
  return { on: true, goLive: s.goLiveDate };
}

const refusal = (e: unknown) => (e instanceof AccountingError ? { code: e.code ?? "REFUSED", message: e.message } : null);

/** «قوالب التأجيل»: every due month that has ended, oldest first (stops at the first refusal, e.g. PERIOD_CLOSED). */
export async function runDueDeferrals(ctx: AuditContext, today: Date = riyadhDay(), standing?: Standing): Promise<DeferralDue> {
  const st = await bookState(today);
  if (!st.on) return { status: "SKIPPED", reason: st.reason, detail: st.detail };
  const through = dayText(lastEndedMonthEnd(today));
  const r = await runDueDeferralRecognition({ actorId: ctx.actorId, asOf: through, audit: { ip: ctx.ip, userAgent: ctx.userAgent, reason: ctx.reason ?? "deferral recognition: due months" }, standing });
  const months = r.results.map((x) => ({ month: x.month, status: x.status === "RECORDED" ? x.run.status : x.status, runId: x.status === "RECORDED" ? x.run.id : null }));
  return {
    status: "RAN", through, months, stoppedAt: r.stoppedAt,
    recorded: months.filter((m) => m.runId).length, posted: months.filter((m) => m.status === "POSTED").length, skipped: months.filter((m) => m.status === "SKIPPED").length,
  };
}

/** «الإهلاك»: the latest ended month, when its period is open and it ends on / after the go-live day. */
export async function runDueDepreciation(ctx: AuditContext, today: Date = riyadhDay(), standing?: Standing): Promise<DepreciationDue> {
  const st = await bookState(today);
  if (!st.on) return { status: "SKIPPED", reason: st.reason, detail: st.detail };
  const end = lastEndedMonthEnd(today);
  const y = end.getUTCFullYear(), m = end.getUTCMonth() + 1;
  const month = `${y}-${String(m).padStart(2, "0")}`;
  if (end < st.goLive) return { status: "SKIPPED", reason: "BEFORE_GO_LIVE", month, detail: `the month ends before go-live ${dayText(st.goLive)}` };
  const period = await prisma.fiscalPeriod.findFirst({ where: { startDate: { lte: end }, endDate: { gte: end } }, select: { status: true } });
  if (!period || String(period.status) !== "OPEN") return { status: "SKIPPED", reason: "PERIOD_NOT_OPEN", month, detail: period ? String(period.status) : "no fiscal period" };
  try {
    const r = await runDepreciationForMonth(y, m, { ...ctx, reason: ctx.reason ?? `depreciation ${month}: due run` }, { allowNothing: true, standing });
    if (r.status === "nothing") return { status: "RAN", month, result: "nothing", runId: null, glState: null, assets: 0, total: null };
    return { status: "RAN", month, result: "posted", runId: r.run.id, glState: String(r.run.glState), assets: r.run.assetCount, total: String(r.run.totalAmount) };
  } catch (e) {
    const x = refusal(e);
    if (x) return { status: "REFUSED", month, ...x };
    throw e;
  }
}

export type ScheduledGl<T> = T & { authorisationId?: string | null; revokedAuthorisationId?: string | null };

/**
 * The scheduler's monthly GL runs (/api/cron/recurring): each register only under its live StandingAuthorisation, whose
 * authoriser's rights are re-checked first (authoriseRun: lapsed → revoked 'RIGHTS_LAPSED: …', logged, notified, and the
 * run SKIPPED NOT_AUTHORISED). Under it, the run is the person-run one with the authoriser as the actor — the entries'
 * postedBy, never the system actor — and the authorisation's sodBypass on the entries; the run records the
 * authorisation. Idempotent like the person-run ones (one recognised line per schedule and month; one live
 * depreciation line per asset and month): a replay posts nothing new.
 */
export async function schedulerGlRuns(today: Date = riyadhDay()): Promise<{ deferrals: ScheduledGl<DeferralDue>; depreciation: ScheduledGl<DepreciationDue> }> {
  const under = async <T>(register: RegisterWide, run: (ctx: AuditContext, s: Standing) => Promise<T>): Promise<ScheduledGl<T | DeferralDue>> => {
    const a = await authoriseRun(register);
    if (!a.ok) return { status: "SKIPPED", reason: "NOT_AUTHORISED", detail: a.detail, authorisationId: null, revokedAuthorisationId: a.revoked?.id ?? null };
    const ctx: AuditContext = { actorId: a.auth.authorisedBy, reason: `scheduler under standing authorisation ${a.auth.id} (${register})` };
    return { ...(await run(ctx, { id: a.auth.id, sodBypass: a.auth.sodBypass })), authorisationId: a.auth.id };
  };
  const deferrals = (await under("DEFERRAL_RECOGNITION", (ctx, s) => runDueDeferrals(ctx, today, s))) as ScheduledGl<DeferralDue>;
  const depreciation = (await under("DEPRECIATION", (ctx, s) => runDueDepreciation(ctx, today, s))) as ScheduledGl<DepreciationDue>;
  return { deferrals, depreciation };
}
