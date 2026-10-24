import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { closePeriodWithChecklist, reviewPeriod, softClosePeriod } from "@/lib/accounting/close";
import { refuse } from "@/lib/accounting/refusals";

type Params = { params: Promise<{ periodId: string; action: string }> };

/**
 * The month-end close, recorded (PeriodCloseReview) — body { note? }:
 *   review      run and record the checklist (accounting › period_lock);
 *   soft-close  record it, then OPEN → LOCKED (period_lock + the admin role, step-up — as A1's lock);
 *   close       refused while a check FAILs; a WARN needs a note; then LOCKED → CLOSED (period_close + admin, step-up).
 */
export async function POST(request: Request, { params }: Params) {
  const { action, periodId } = await params;
  const sub = action === "close" ? "period_close" : "period_lock";
  const { user, error } = await requireSub("accounting", sub);
  if (error) return error;
  if (action !== "review") {
    const refused = await requireAdminAction(user, `accounting.${sub}`, { stepUp: true, message: "Insufficient permissions." });
    if (refused) return refused;
  }
  try {
    const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
    const ctx = auditFromRequest(request, user.id);
    if (action === "review") return NextResponse.json(await reviewPeriod(periodId, body.note, ctx));
    if (action === "soft-close") return NextResponse.json(await softClosePeriod(periodId, body.note, ctx));
    if (action === "close") return NextResponse.json(await closePeriodWithChecklist(periodId, body.note, ctx));
    throw refuse("NOT_FOUND");
  } catch (err) {
    return acctError(err);
  }
}
