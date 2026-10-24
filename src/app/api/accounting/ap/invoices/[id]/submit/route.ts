import { NextResponse } from "@/lib/api-response";
import { acctError } from "@/lib/accounting/http";
import { requireDraftWriter } from "@/lib/accounting/ops/http";
import { submitInvoice } from "@/lib/accounting/ops/ap";

type Params = { params: Promise<{ id: string }> };

/** Submit a draft for approval («حفظ وتقديم للاعتماد»). */
export async function POST(_request: Request, { params }: Params) {
  const { user, error } = await requireDraftWriter();
  if (error) return error;
  try {
    return NextResponse.json(await submitInvoice((await params).id, user.id));
  } catch (err) {
    return acctError(err);
  }
}
