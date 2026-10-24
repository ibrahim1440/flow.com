import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { closePeriodWithChecklist } from "@/lib/accounting/close";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";

type Params = { params: Promise<{ id: string }> };

/** Final close («إقفال نهائي»): LOCKED → CLOSED; the database then refuses every posting into it. A5: through the close
 *  checklist — refused while a check FAILs, a WARN needs { note } — and recorded with it (PeriodCloseReview). */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "period_close");
  if (error) return error;
  // Defense in depth: there is no role hierarchy above "admin" yet (see saas-readiness.md),
  // so period control is additionally restricted to admin regardless of sub-privilege grants.
  // The admin role is privileged: the same verified-individual gate, with a recent step-up.
  const refused = await requireAdminAction(user, "accounting.period_close", { stepUp: true, message: "Insufficient permissions." });
  if (refused) return refused;
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as { note?: unknown } | null;
    const r = await closePeriodWithChecklist(id, body?.note, auditFromRequest(request, user.id));
    return NextResponse.json(r.period);
  } catch (err) {
    return acctError(err);
  }
}
