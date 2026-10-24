import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { rangeOf } from "@/lib/accounting/reports";
import { sodExceptions } from "@/lib/accounting/sod";
import { csvRow } from "@/lib/accounting/statements";
import { csvResponse } from "@/lib/accounting/report-routes";

/** «استثناءات فصل المهام» for the auditor — ?from&to (by the day of the act), format=csv. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const { from, to } = rangeOf(qp(request, "from"), qp(request, "to"));
    const r = await sodExceptions(from, new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())));
    if (qp(request, "format") === "csv") return csvResponse(`sod-exceptions-${r.from}-${r.to}`, [csvRow(["day", "at", "kind", "ref", "amount", "actor", "detail"]), ...r.rows.map((x) => csvRow([x.day, x.at, x.kind, x.ref, x.amount, x.actorId, x.detail]))]);
    return NextResponse.json(r);
  } catch (err) {
    return acctError(err);
  }
}
