import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { requireApRead, requireDraftWriter } from "@/lib/accounting/ops/http";
import { deleteInvoice, getInvoice, updateInvoice, type InvoiceInput } from "@/lib/accounting/ops/ap";

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

/** Edit a draft. */
export async function PUT(request: Request, { params }: Params) {
  const { user, error } = await requireDraftWriter();
  if (error) return error;
  try {
    return NextResponse.json(await updateInvoice((await params).id, (await jsonBody(request)) as unknown as InvoiceInput, user.id));
  } catch (err) {
    return acctError(err);
  }
}

/** Delete a draft. */
export async function DELETE(_request: Request, { params }: Params) {
  const { error } = await requireDraftWriter();
  if (error) return error;
  try {
    return NextResponse.json(await deleteInvoice((await params).id));
  } catch (err) {
    return acctError(err);
  }
}
