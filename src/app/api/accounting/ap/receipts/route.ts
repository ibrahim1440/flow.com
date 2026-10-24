import { NextResponse } from "@/lib/api-response";
import { acctError, qp } from "@/lib/accounting/http";
import { requireApRead } from "@/lib/accounting/ops/http";
import { openReceipts } from "@/lib/accounting/ops/ap";

/** Costed goods receipts not yet matched by a posted invoice (GRNI open items) — to match on an invoice. */
export async function GET(request: Request) {
  const { error } = await requireApRead();
  if (error) return error;
  try {
    return NextResponse.json(await openReceipts(qp(request, "supplierId")));
  } catch (err) {
    return acctError(err);
  }
}
