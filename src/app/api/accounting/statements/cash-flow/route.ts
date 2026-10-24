import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { cashFlowCsv, cashFlowFromRequest, csvResponse } from "@/lib/accounting/report-routes";

/** «قائمة التدفقات النقدية» (indirect) — ?kind=month|quarter|year&year&n | from&to, format=csv. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const cf = await cashFlowFromRequest(request);
    if (qp(request, "format") === "csv") return csvResponse(`cash-flow-${cf.from}-${cf.to}`, cashFlowCsv(cf));
    return NextResponse.json(cf);
  } catch (err) {
    return acctError(err);
  }
}
