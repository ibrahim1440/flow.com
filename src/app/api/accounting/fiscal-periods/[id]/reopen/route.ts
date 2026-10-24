import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { reopenFiscalPeriod } from "@/lib/accounting/fiscal-years";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";

type Params = { params: Promise<{ id: string }> };

/**
 * Reopen a CLOSED period: its own permission (accounting › period_reopen, step-up), the admin role (as every
 * period control), a reason; the database refuses a reopen without reason / person / a new recorded stamp, and
 * the audit log keeps who, when, why, from where.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "period_reopen");
  if (error) return error;
  const refused = await requireAdminAction(user, "accounting.period_reopen", { stepUp: true, message: "Insufficient permissions." });
  if (refused) return refused;
  const { id } = await params;
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await reopenFiscalPeriod(id, body.reason, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
