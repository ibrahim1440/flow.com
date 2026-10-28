import { NextResponse } from "@/lib/api-response";
import { acctError, qp } from "@/lib/accounting/http";
import { requireCostRead } from "@/lib/accounting/ops/http";
import { holderMovements } from "@/lib/accounting/ops/valuation-report";
import { opsRefuse } from "@/lib/accounting/ops/refusals";

/** «حركات التكلفة» of one cost holder (?item=<CostItem id>&page=<n>, newest first): the drill-down of «تقييم المخزون». Cost read gate. */
export async function GET(request: Request) {
  const { error } = await requireCostRead();
  if (error) return error;
  try {
    const item = qp(request, "item");
    if (!item || item.length > 64) throw opsRefuse("OPS_BAD_INPUT", "item is required.", "حدد الصنف.");
    return NextResponse.json(await holderMovements(item, qp(request, "page")));
  } catch (err) {
    return acctError(err);
  }
}
