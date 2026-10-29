import { NextResponse } from "@/lib/api-response";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { runDue } from "@/lib/accounting/recurring/runner";
import { journalDutyGate, requireRegisterWrite } from "@/lib/accounting/register-access";
import { runDueDeferrals, runDueDepreciation, type DeferralDue, type DepreciationDue } from "@/lib/accounting/due-runners";

export const maxDuration = 60;

/**
 * «تشغيل المستحق الآن»: run every recurring transaction due on / before today (Asia/Riyadh) — or only `scheduleIds` —
 * the same idempotent runner as the scheduler (/api/cron/recurring). accounting › recurring (the register's maintenance
 * duty). Then, unless `scheduleIds` narrows the run, the monthly runs that write the GL (src/lib/accounting/due-runners.ts,
 * months that have ended only, nothing before go-live):
 *   • «قوالب التأجيل» recognition — for a holder of accounting › journal_post;
 *   • «الإهلاك» depreciation (the latest ended month, its period open) — for a holder of accounting › fixed_assets AND
 *     journal_post;
 * both through the central gate (verified individual + step-up: a 401 REAUTH_REQUIRED is answered before anything runs,
 * and the dialog retries — every part is idempotent). A holder who is refused by the gate's identity check still runs
 * the recurring transactions; the GL runs are reported NOT_ALLOWED. Answers the counts, each occurrence's outcome and the
 * two monthly runs' outcomes (`deferrals`, `depreciation`).
 */
export async function POST(request: Request) {
  const { user, error } = await requireRegisterWrite("recurring");
  if (error) return error;
  const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
  const ids = Array.isArray(body.scheduleIds) ? body.scheduleIds.filter((x): x is string => typeof x === "string").slice(0, 200) : undefined;
  const has = (s: string) => hasSubPrivilege(user.permissions, "accounting", s);
  const wantGl = !ids && has("journal_post");
  let glRefused: { code: string } | null = null;
  if (wantGl) {
    const refused = await journalDutyGate(user, "journal_post");
    if (refused?.status === 401) return refused;
    if (refused) glRefused = { code: (((await refused.clone().json().catch(() => ({}))) as { code?: string }).code) ?? "FORBIDDEN" };
  }
  try {
    const recurring = await runDue({ trigger: "MANUAL", ctx: auditFromRequest(request, user.id, "recurring: run due now"), scheduleIds: ids, budgetMs: 40_000 });
    const notAllowed = (detail: string) => ({ status: "SKIPPED" as const, reason: "NOT_ALLOWED" as const, detail });
    let deferrals: DeferralDue, depreciation: DepreciationDue;
    if (ids) deferrals = depreciation = { status: "SKIPPED", reason: "NOT_SCHEDULED", detail: "only the chosen recurring transactions" };
    else if (!wantGl || glRefused) {
      const why = glRefused ? `the central gate refused (${glRefused.code})` : "needs accounting › journal_post";
      deferrals = notAllowed(why);
      depreciation = notAllowed(glRefused ? why : "needs accounting › fixed_assets + journal_post");
    } else {
      deferrals = await runDueDeferrals(auditFromRequest(request, user.id, "deferral recognition: run due now"));
      depreciation = has("fixed_assets")
        ? await runDueDepreciation(auditFromRequest(request, user.id, "depreciation: run due now"))
        : notAllowed("needs accounting › fixed_assets");
    }
    return NextResponse.json({ ...recurring, deferrals, depreciation });
  } catch (err) {
    return acctError(err);
  }
}
