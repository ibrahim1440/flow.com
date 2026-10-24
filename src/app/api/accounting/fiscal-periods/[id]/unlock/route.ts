import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { unlockFiscalPeriod } from "@/lib/accounting/fiscal-years";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";

type Params = { params: Promise<{ id: string }> };

/** «فتح الفترة» of a soft-closed period: LOCKED → OPEN, with a reason (audited). */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "period_lock");
  if (error) return error;
  const refused = await requireAdminAction(user, "accounting.period_unlock", { stepUp: true, message: "Insufficient permissions." });
  if (refused) return refused;
  const { id } = await params;
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await unlockFiscalPeriod(id, body.reason, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
