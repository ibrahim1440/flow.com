import { NextResponse } from "@/lib/api-response";
import { acctError, qp } from "@/lib/accounting/http";
import { requireCostRead, csvResponse } from "@/lib/accounting/ops/http";
import { valuation } from "@/lib/accounting/ops/valuation";

/** «قيمة المخزون»: every costed holder (moving average), by inventory role. inventory › valuation or accounting. */
export async function GET(request: Request) {
  const { error } = await requireCostRead();
  if (error) return error;
  try {
    const v = await valuation({ includeZero: qp(request, "includeZero") === "1" });
    if (qp(request, "format") === "csv") {
      return csvResponse(`inventory-valuation-${v.asOf}`, ["role", "kind", "item", "reference", "unit", "qty_cost_ledger", "qty_operations", "avg_cost", "value"],
        v.rows.map((r) => [r.role, r.kind, r.label, r.sub, r.unit, r.qty, r.opsQty, r.avgCost, r.value]));
    }
    return NextResponse.json(v);
  } catch (err) {
    return acctError(err);
  }
}
