import { NextResponse } from "@/lib/api-response";
import { requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { deactivate } from "@/lib/accounting/setup";
import { auditFromRequest } from "@/lib/accounting/audit";
import { refuse } from "@/lib/accounting/refusals";

/** Undo an activation — only before the posting engine has posted anything (the database refuses it after). */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "settings_manage");
  if (error) return error;
  const refused = await requirePrivilegedAction(user, "accounting.activation", { stepUp: true });
  if (refused) return refused;
  try {
    const body = await jsonBody(request);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3) throw refuse("REASON_REQUIRED");
    return NextResponse.json(await deactivate(auditFromRequest(request, user.id, reason)));
  } catch (err) {
    return acctError(err);
  }
}
