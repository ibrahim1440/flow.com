import { NextResponse } from "@/lib/api-response";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { setPaused } from "@/lib/accounting/recurring/schedules";

type Params = { params: Promise<{ id: string }> };

/** «إيقاف مؤقت» (`{ paused: true }`) or «استئناف» (`{ paused: false }`: no back-fill) — accounting › recurring. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("recurring");
  if (error) return error;
  const { id } = await params;
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await setPaused(id, body.paused !== false, auditFromRequest(request, user.id), body.reason));
  } catch (err) {
    return acctError(err);
  }
}
