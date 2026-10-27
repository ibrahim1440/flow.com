import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireApRead } from "@/lib/accounting/ops/http";
import { listInvoices } from "@/lib/accounting/ops/ap";
import { savePurchaseInvoice, type PurchaseInvoiceInput } from "@/lib/accounting/ops/purchase-invoice";
import { sodPolicy } from "@/lib/accounting/sod";
import { isSimpleMode } from "@/lib/simple-mode";
import { purchaseCan, purchaseSaveGate } from "@/lib/purchases/gates";

/**
 * Phase 2 — «الفواتير», the purchases screen's default tab: the purchase invoices (status, supplier, period, search),
 * the counts per status, and what the viewer may do (the AP read gate).
 *   GET  ?status=&supplierId=&from=&to=&q=     the list (+ `can`, the SoD setting, `viewer`)
 *   POST { …invoice, action: draft | receive | post }   «حفظ كمسودة» / «حفظ واستلام» / «حفظ واستلام واعتماد»
 */
export async function GET(request: Request) {
  const { user, error } = await requireApRead();
  if (error) return error;
  try {
    const r = await listInvoices({ status: qp(request, "status"), supplierId: qp(request, "supplierId"), from: qp(request, "from"), to: qp(request, "to"), q: qp(request, "q") });
    const sod = await sodPolicy();
    return NextResponse.json({ ...r, viewer: { id: user.id }, simpleMode: isSimpleMode(), sodSelfAllowed: sod.allowSelfApproval, can: purchaseCan(user.permissions) });
  } catch (err) {
    return acctError(err);
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await jsonBody(request); } catch (err) { return acctError(err); }
  const { user, error, mayReceive, mayChangeReceived } = await purchaseSaveGate(String(body.action ?? "draft"));
  if (error) return error;
  try {
    const r = await savePurchaseInvoice(body as unknown as PurchaseInvoiceInput, null, user, auditFromRequest(request, user.id), { mayReceive, mayChangeReceived });
    return NextResponse.json(r, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    return acctError(err);
  }
}
