import { NextResponse } from "@/lib/api-response";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { purchaseSaveGate } from "@/lib/purchases/gates";
import { saveSimpleInvoice, MISC_CASH_SUPPLIER_ID, SIMPLE_MAX_LINES, SIMPLE_MAX_LINE_GROSS, SIMPLE_TAX_CODES } from "@/lib/accounting/ops/simple-purchase";
import { readSimpleRequest } from "@/lib/accounting/ops/simple-http";
import { requireApRead } from "@/lib/accounting/ops/http";

/**
 * «فواتير بسيطة» (BATCH22 WP-H) — a simple expense invoice, saved with its receipt in ONE act:
 *   POST multipart { data: JSON (supplierId? | vendorName / vendorVatNumber, supplierRef, invoiceDate, lines [{ expenseCategoryId,
 *        gross, taxCode?, vat? }], branchId?, action: draft | submit | post, paidFrom?: CASH | BANK), file: the receipt }
 * Gates: the purchase-invoice save gate (purchases › invoices or accounting › ap); «حفظ وموافقة» (post, and «مدفوعة من»)
 * also accounting › ap (verified individual + step-up) — the SoD setting decides in the service whether the preparer posts.
 * GET — the form's constants (the MISC-CASH supplier, the limits, the VAT categories).
 */
export async function GET() {
  const { error } = await requireApRead();
  if (error) return error;
  return NextResponse.json({ miscSupplierId: MISC_CASH_SUPPLIER_ID, maxLines: SIMPLE_MAX_LINES, maxLineGross: SIMPLE_MAX_LINE_GROSS.toFixed(2), taxCodes: SIMPLE_TAX_CODES, maxAttachmentMb: 10 });
}

export async function POST(request: Request) {
  let req: Awaited<ReturnType<typeof readSimpleRequest>>;
  try { req = await readSimpleRequest(request); } catch (err) { return acctError(err); }
  const action = req.input?.action === "post" ? "post" : "draft";
  const { user, error } = await purchaseSaveGate(action);
  if (error) return error;
  try {
    const r = await saveSimpleInvoice(req.input, req.file, null, auditFromRequest(request, user.id, "simple invoice"), { mayPost: action === "post" });
    return NextResponse.json(r, { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
