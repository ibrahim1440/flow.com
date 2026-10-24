import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { csvResponse, incomeCsv, incomeFromRequest } from "@/lib/accounting/report-routes";

/** «قائمة الدخل» — ?kind=month|quarter|year&year&n | from&to, compare=prior|lastYear|none, format=csv. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const pl = await incomeFromRequest(request);
    if (qp(request, "format") === "csv") return csvResponse(`income-statement-${pl.columns[0].from}-${pl.columns[0].to}`, incomeCsv(pl));
    return NextResponse.json(pl);
  } catch (err) {
    return acctError(err);
  }
}
