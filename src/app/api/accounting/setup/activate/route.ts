import { NextResponse } from "@/lib/api-response";
import { requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { activate } from "@/lib/accounting/setup";
import { auditFromRequest } from "@/lib/accounting/audit";

/** Activate accounting from the go-live date (readiness checked). Settings duty, verified individual, step-up. */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "settings_manage");
  if (error) return error;
  const refused = await requirePrivilegedAction(user, "accounting.activation", { stepUp: true });
  if (refused) return refused;
  try {
    const body = await jsonBody(request);
    const s = await activate(String(body.goLiveDate ?? ""), auditFromRequest(request, user.id, "activate accounting"));
    return NextResponse.json(s);
  } catch (err) {
    return acctError(err);
  }
}
