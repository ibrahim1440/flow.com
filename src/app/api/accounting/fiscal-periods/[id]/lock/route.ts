import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { lockFiscalPeriod } from "@/lib/accounting/fiscal-years";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";

type Params = { params: Promise<{ id: string }> };

/** Soft close («إقفال مؤقت»): OPEN → LOCKED. */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "period_lock");
  if (error) return error;
  // Defense in depth: there is no role hierarchy above "admin" yet (see saas-readiness.md),
  // so period control is additionally restricted to admin regardless of sub-privilege grants.
  // The admin role is privileged: the same verified-individual gate, with a recent step-up.
  const refused = await requireAdminAction(user, "accounting.period_lock", { stepUp: true, message: "Insufficient permissions." });
  if (refused) return refused;
  const { id } = await params;
  try {
    return NextResponse.json(await lockFiscalPeriod(id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
