import { NextResponse } from "@/lib/api-response";
import { acctError, qp } from "@/lib/accounting/http";
import { requireFaRead } from "@/lib/accounting/fixed-assets/http";
import { capitalisableLines } from "@/lib/accounting/fixed-assets/assets";

/** The EXPENSE lines of posted purchase invoices that can still be capitalised (?supplierId). */
export async function GET(request: Request) {
  const { error } = await requireFaRead();
  if (error) return error;
  try {
    return NextResponse.json({ rows: await capitalisableLines({ supplierId: qp(request, "supplierId") }) });
  } catch (err) {
    return acctError(err);
  }
}
