import { NextResponse } from "@/lib/api-response";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { requireModule } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { deleteTemplate, getTemplate, saveTemplate } from "@/lib/accounting/recurring/templates";

type Params = { params: Promise<{ id: string }> };

/** One journal template. PATCH replaces it (name, description, mode, lines; `expectedUpdatedAt`); DELETE only while no
 *  recurring transaction uses it — both accounting › recurring (the register's maintenance duty). */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await getTemplate(id));
  } catch (err) {
    return acctError(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("recurring");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await saveTemplate(await jsonBody(request), id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("recurring");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await deleteTemplate(id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
