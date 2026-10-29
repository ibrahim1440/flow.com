import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireFaRead, requireFaWrite } from "@/lib/accounting/fixed-assets/http";
import { disposeAsset, disposalPreview } from "@/lib/accounting/fixed-assets/assets";

type Params = { params: Promise<{ id: string }> };

/** What a disposal would record (?disposalDate&kind&proceedsNet) — the depreciation to the day, NBV, gain / loss. */
export async function GET(request: Request, { params }: Params) {
  const { error } = await requireFaRead();
  if (error) return error;
  try {
    return NextResponse.json(await disposalPreview((await params).id, { disposalDate: qp(request, "disposalDate") ?? "", kind: qp(request, "kind") ?? "", proceedsNet: qp(request, "proceedsNet"), salesInvoiceLineId: qp(request, "salesInvoiceLineId") }));
  } catch (err) {
    return acctError(err);
  }
}

/**
 * «استبعاد أصل» — { disposalDate, kind SCRAP | SALE, reason } without proceeds; or { salesInvoiceLineId, disposalDate?, reason }
 * for a disposal for value (BATCH 22 WP-F): the issued «بيع أصل ثابت» line gives the proceeds (its net) and the kind, the
 * date defaults to its supply date, and the entry debits FA_DISPOSAL_CLEARING (no VAT: the invoice carried it). Proceeds
 * without a line: FA_SALE_NEEDS_INVOICE. journal_post + step-up.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireFaWrite({ duty: "journal_post" });
  if (error) return error;
  try {
    const b = await jsonBody(request);
    return NextResponse.json(await disposeAsset((await params).id, b, auditFromRequest(request, user.id, typeof b.reason === "string" ? b.reason : null)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
