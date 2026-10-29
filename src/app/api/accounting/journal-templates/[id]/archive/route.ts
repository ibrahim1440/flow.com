import { NextResponse } from "@/lib/api-response";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { setTemplateArchived } from "@/lib/accounting/recurring/templates";

type Params = { params: Promise<{ id: string }> };

/** Archive (`{ archived: true }`) or restore a journal template — accounting › recurring. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("recurring");
  if (error) return error;
  const { id } = await params;
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await setTemplateArchived(id, body.archived !== false, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
