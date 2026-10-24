import { NextResponse } from "@/lib/api-response";
import { acctError, qp } from "@/lib/accounting/http";
import { requireCostRead, csvResponse } from "@/lib/accounting/ops/http";
import { batchCosts } from "@/lib/accounting/ops/valuation";

/** «تكلفة الإنتاج لكل دفعة»: green cost, loss (normal / abnormal), cost per roasted kg. */
export async function GET(request: Request) {
  const { error } = await requireCostRead();
  if (error) return error;
  try {
    const r = await batchCosts(qp(request, "from"), qp(request, "to"));
    if (qp(request, "format") === "csv") {
      return csvResponse(`roast-costs-${r.from}-${r.to}`, ["batch", "date", "product", "green_lot", "green_kg", "roasted_kg", "loss_kg", "loss_pct", "green_cost", "abnormal_loss_cost", "roasted_cost", "roasted_cost_per_kg"],
        r.rows.map((x) => [x.batchNumber, x.date, x.product, x.greenLot, x.greenKg, x.roastedKg, x.lossKg, x.lossPct, x.greenCost, x.abnormalCost, x.roastedCost, x.roastedUnitCost]));
    }
    return NextResponse.json(r);
  } catch (err) {
    return acctError(err);
  }
}
