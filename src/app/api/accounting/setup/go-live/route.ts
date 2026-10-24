import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { setGoLiveDate } from "@/lib/accounting/setup";
import { auditFromRequest } from "@/lib/accounting/audit";

/** The go-live date, before activation. */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("accounting", "settings_manage");
  if (error) return error;
  try {
    const body = await jsonBody(request);
    const v = body.goLiveDate;
    const s = await setGoLiveDate(typeof v === "string" && v ? v : null, auditFromRequest(request, user.id));
    return NextResponse.json(s);
  } catch (err) {
    return acctError(err);
  }
}
