import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { balanceCsv, balanceFromRequest, csvResponse } from "@/lib/accounting/report-routes";

/** «قائمة المركز المالي» — ?asOf&compareAsOf (default: the previous 31 December; none), format=csv. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const bs = await balanceFromRequest(request);
    if (qp(request, "format") === "csv") return csvResponse(`balance-sheet-${bs.columns[0].asOf}`, balanceCsv(bs));
    return NextResponse.json(bs);
  } catch (err) {
    return acctError(err);
  }
}
