import { NextResponse } from "@/lib/api-response";
import { requireModule, requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { readiness, setRoles } from "@/lib/accounting/setup";
import { auditFromRequest } from "@/lib/accounting/audit";
import { refuse } from "@/lib/accounting/refusals";

/** The posting roles and the account each maps to («ربط الحسابات»). */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const r = await readiness();
    return NextResponse.json({ roles: r.roles, missingByPhase: r.missingByPhase });
  } catch (err) {
    return acctError(err);
  }
}

/** `{ roles: { AR: "<accountId>", ROUNDING: null, … } }` — map / unmap. Settings duty, step-up (it decides where money posts). */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("accounting", "settings_manage");
  if (error) return error;
  const refused = await requirePrivilegedAction(user, "accounting.roles_map", { stepUp: true });
  if (refused) return refused;
  try {
    const body = await jsonBody(request);
    if (!body.roles || typeof body.roles !== "object" || Array.isArray(body.roles)) throw refuse("BAD_INPUT", "roles is an object { ROLE: accountId | null }.");
    return NextResponse.json(await setRoles(body.roles as Record<string, unknown>, auditFromRequest(request, user.id, typeof body.reason === "string" ? body.reason : null)));
  } catch (err) {
    return acctError(err);
  }
}
