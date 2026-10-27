import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { cancelPurchaseInvoice } from "@/lib/accounting/ops/purchase-invoice";
import { purchaseSaveGate } from "@/lib/purchases/gates";

type Params = { params: Promise<{ id: string }> };

/**
 * Cancel an invoice that is not posted: its receipts are reversed (stock and cost back) and it is kept as CANCELLED
 * («ملغاة», its number stays issued — never deleted), in one transaction; refused when its goods have been used since,
 * or when it is posted (a supplier return is a later phase). The draft writer; reversing receipts also takes
 * inventory › receive AND purchases › received_change (enforced in the service). A reason.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error, mayReceive, mayChangeReceived } = await purchaseSaveGate("cancel");
  if (error) return error;
  try {
    const b = await jsonBody(request);
    const reason = String(b.reason ?? "");
    return NextResponse.json(await cancelPurchaseInvoice((await params).id, reason, user, auditFromRequest(request, user.id, reason), { mayReceive, mayChangeReceived }));
  } catch (err) {
    return acctError(err);
  }
}
