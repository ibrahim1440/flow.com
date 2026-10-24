import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireModule, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { setSodPolicy, sodPolicy } from "@/lib/accounting/sod";
import { refuse } from "@/lib/accounting/refusals";

/** «فصل المهام»: the effective policy and the stored toggles. */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json(await sodPolicy());
  } catch (err) {
    return acctError(err);
  }
}

/** Change the toggles { allowSelfApproval?, approverMayPost? } — accounting › settings_manage + the admin role, step-up; audited. */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("accounting", "settings_manage");
  if (error) return error;
  const refused = await requireAdminAction(user, "accounting.sod_settings", { stepUp: true, message: "Insufficient permissions." });
  if (refused) return refused;
  try {
    const body = await jsonBody(request);
    try {
      return NextResponse.json(await setSodPolicy({ allowSelfApproval: body.allowSelfApproval, approverMayPost: body.approverMayPost }, auditFromRequest(request, user.id, "SoD settings")));
    } catch (e) {
      if (e instanceof TypeError) throw refuse("BAD_INPUT", `${e.message} is true / false.`);
      throw e;
    }
  } catch (err) {
    return acctError(err);
  }
}
