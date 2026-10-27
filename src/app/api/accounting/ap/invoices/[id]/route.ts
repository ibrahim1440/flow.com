import { NextResponse } from "@/lib/api-response";
import { auditFromRequest } from "@/lib/accounting/audit";
import { acctError } from "@/lib/accounting/http";
import { opsRefuse } from "@/lib/accounting/ops/refusals";
import { requireApRead, requireDraftWriter } from "@/lib/accounting/ops/http";
import { deleteInvoice, getInvoice } from "@/lib/accounting/ops/ap";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireApRead();
  if (error) return error;
  try {
    return NextResponse.json(await getInvoice((await params).id));
  } catch (err) {
    return acctError(err);
  }
}

/** Gone (council review SA1): a purchase invoice is edited through PUT /api/purchases/invoices/:id. */
export async function PUT() {
  const { error } = await requireDraftWriter();
  if (error) return error;
  return acctError(opsRefuse("LEGACY_AP_ROUTE_GONE"));
}

/** Refused (EA2): no supplier invoice is deleted — every one is numbered; a draft is cancelled instead. */
export async function DELETE(request: Request, { params }: Params) {
  const { user, error } = await requireDraftWriter();
  if (error) return error;
  try {
    return NextResponse.json(await deleteInvoice((await params).id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
