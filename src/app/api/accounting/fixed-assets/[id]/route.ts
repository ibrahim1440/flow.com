import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireFaRead, requireFaWrite, faCan } from "@/lib/accounting/fixed-assets/http";
import { getAsset, updateAsset, deleteDraft } from "@/lib/accounting/fixed-assets/assets";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireFaRead();
  if (error) return error;
  try {
    return NextResponse.json({ ...(await getAsset((await params).id)), can: faCan(user.permissions) });
  } catch (err) {
    return acctError(err);
  }
}

/** Edit: a DRAFT in full; an asset in the books only its descriptive fields (names, branch, location, serial, custodian, attachments, notes). */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireFaWrite();
  if (error) return error;
  try {
    return NextResponse.json(await updateAsset((await params).id, await jsonBody(request), auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}

/** Only a DRAFT is deleted (the database refuses anything else). */
export async function DELETE(request: Request, { params }: Params) {
  const { user, error } = await requireFaWrite();
  if (error) return error;
  try {
    return NextResponse.json(await deleteDraft((await params).id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
