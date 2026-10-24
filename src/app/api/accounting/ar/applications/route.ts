import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { jsonBody } from "@/lib/accounting/http";
import { applyToInvoice } from "@/lib/services/invoicing/ar";
import { invError } from "@/lib/services/invoicing/refusals";

/**
 * POST /api/accounting/ar/applications { invoiceId, amount, collectionId | creditNoteId } — apply part of an approved
 * receipt (or of a credit note's credit) to an issued invoice / debit note of the same customer (full, partial,
 * many-to-many). Posts Dr customer advances / Cr AR when the receipt was posted. accounting › ar (verified individual).
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "ar");
  if (error) return error;
  try {
    const b = await jsonBody(request);
    const r = await applyToInvoice({
      invoiceId: String(b.invoiceId ?? ""), amount: String(b.amount ?? ""),
      collectionId: typeof b.collectionId === "string" ? b.collectionId : null, creditNoteId: typeof b.creditNoteId === "string" ? b.creditNoteId : null,
    }, auditFromRequest(request, user.id, "AR application"));
    return NextResponse.json(r, { status: 201 });
  } catch (err) {
    return invError(err);
  }
}
