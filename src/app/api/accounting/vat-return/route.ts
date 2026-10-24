import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { csvResponse, vatCsv, vatFromRequest } from "@/lib/accounting/report-routes";

/** «إقرار ضريبة القيمة المضافة» (quarterly) — ?year&q=1..4, format=csv. A working paper, reconciled to the GL and ZATCA. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const v = await vatFromRequest(request);
    if (qp(request, "format") === "csv") return csvResponse(`vat-return-${v.year}-Q${v.quarter}`, vatCsv(v));
    return NextResponse.json(v);
  } catch (err) {
    return acctError(err);
  }
}
