import { NextResponse } from "@/lib/api-response";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { updateTemplate } from "@/lib/accounting/deferrals";

type Params = { params: Promise<{ id: string }> };

/** Edit or (de)activate a template (accounting › deferrals); the schedules made from it keep their copy. */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("deferrals");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await updateTemplate(id, await jsonBody(request), auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
