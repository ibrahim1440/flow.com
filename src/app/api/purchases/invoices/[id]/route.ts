import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireApRead } from "@/lib/accounting/ops/http";
import { getPurchaseInvoice, savePurchaseInvoice, type PurchaseInvoiceInput } from "@/lib/accounting/ops/purchase-invoice";
import { purchaseSaveGate, shortfallLossGate } from "@/lib/purchases/gates";

type Params = { params: Promise<{ id: string }> };

/** The purchase invoice with each GRN line's receipt and item (the purchases screen's detail page). */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireApRead();
  if (error) return error;
  try {
    return NextResponse.json(await getPurchaseInvoice((await params).id));
  } catch (err) {
    return acctError(err);
  }
}

/**
 * Save a draft again, receive it, or edit a received (un-posted) invoice — { …invoice, action }. Editing a received
 * one reverses the receipts whose lines changed and receives the new ones, in one transaction.
 */
export async function PUT(request: Request, { params }: Params) {
  let body: Record<string, unknown>;
  try { body = await jsonBody(request); } catch (err) { return acctError(err); }
  const { user, error, mayReceive, mayChangeReceived } = await purchaseSaveGate(String(body.action ?? "draft"));
  if (error) return error;
  const loss = await shortfallLossGate(user, body);
  if (loss.error) return loss.error;
  try {
    return NextResponse.json(await savePurchaseInvoice(body as unknown as PurchaseInvoiceInput, (await params).id, user, auditFromRequest(request, user.id), { mayReceive, mayChangeReceived, mayWriteOffShortfall: loss.mayWriteOffShortfall }));
  } catch (err) {
    return acctError(err);
  }
}
