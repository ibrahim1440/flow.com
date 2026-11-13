import { requireModule } from "@/lib/auth-server";
import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { REGISTER_SUB, registerOf, revokeById } from "@/lib/accounting/standing-auth";

type Params = { params: Promise<{ id: string }> };

/**
 * Revoke a standing authorisation «إلغاء التفويض»: the register's sub (recurring | deferrals | fixed_assets) — withdrawing
 * an authorisation only narrows what the scheduler may do, so no journal duty or step-up. `{ reason }` (≥ 3 characters) is
 * recorded on the row and in the audit trail. A revoked row is final (STANDING_AUTH_FINAL).
 */
export async function POST(request: Request, { params }: Params) {
  // P2 SEC-10: the session and the accounting module first — nobody outside it learns whether an id exists.
  const signedIn = await requireModule("accounting");
  if (signedIn.error) return signedIn.error;
  const { id } = await params;
  const register = await registerOf(id);
  if (!register) return NextResponse.json({ error: "غير موجود", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
  const { user, error } = await requireRegisterWrite(REGISTER_SUB[register]);
  if (error) return error;
  const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
  try {
    return NextResponse.json(await revokeById(id, body.reason, auditFromRequest(request, user.id, "standing authorisation revoked")));
  } catch (err) {
    return acctError(err);
  }
}
