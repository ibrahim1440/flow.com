import { NextResponse } from "@/lib/api-response";
import { acctError } from "@/lib/accounting/http";
import { requireFaRead } from "@/lib/accounting/fixed-assets/http";
import { openSaleLines } from "@/lib/accounting/fixed-assets/assets";

type Params = { params: Promise<{ id: string }> };

/** GET — the asset's open «بيع أصل ثابت» lines (issued, not credited, not disposed of): what a disposal for value clears. */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireFaRead();
  if (error) return error;
  try {
    return NextResponse.json({ items: await openSaleLines((await params).id) });
  } catch (err) {
    return acctError(err);
  }
}
