import { NextResponse } from "@/lib/api-response";
import { requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { reverseDeferralRun } from "@/lib/accounting/deferrals";

type Params = { params: Promise<{ id: string }> };

/** «عكس التشغيل» (accounting › journal_reverse, verified individual + step-up): its entry reversed on its own date, its months pending again. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_reverse");
  if (error) return error;
  const refused = await requirePrivilegedAction(user, "accounting.deferral_reverse", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  try {
    const body = await jsonBody(request);
    const reason = typeof body.reason === "string" ? body.reason : "";
    return NextResponse.json(await reverseDeferralRun(id, reason, auditFromRequest(request, user.id, reason)));
  } catch (err) {
    return acctError(err);
  }
}
