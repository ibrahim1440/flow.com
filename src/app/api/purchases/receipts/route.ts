import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { receiptRegister } from "@/lib/accounting/ops/purchase-invoice";

/**
 * «الاستلامات» — the receipts register (the same audience as GET /api/purchases: the inventory module), each with
 * the live invoice it is on, or flagged as not invoiced yet; reversed receipts marked. ?from=YYYY-MM-DD.
 */
export async function GET(request: Request) {
  const { error } = await requireModule("inventory");
  if (error) return error;
  try {
    return NextResponse.json(await receiptRegister({ from: qp(request, "from") }));
  } catch (err) {
    return acctError(err);
  }
}
