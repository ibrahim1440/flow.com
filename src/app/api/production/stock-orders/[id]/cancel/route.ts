import { requireRoastToStock, stockRun } from "@/lib/services/production/stock-http";
import { cancelStockOrder } from "@/lib/services/production/stock-orders";

type Params = { params: Promise<{ id: string }> };
/** POST — cancel a stock order that has not started (PENDING). */
export async function POST(_request: Request, { params }: Params) {
  const { actor, error } = await requireRoastToStock({ write: true });
  if (error) return error;
  const { id } = await params;
  return stockRun(() => cancelStockOrder(actor, id));
}
