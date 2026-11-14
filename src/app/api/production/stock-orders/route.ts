import { requireRoastToStock, stockRun } from "@/lib/services/production/stock-http";
import { createStockOrder, openStockOrders, stockGreenLots, stockProducts } from "@/lib/services/production/stock-orders";
import { withIdempotency } from "@/lib/idempotency";

/** GET — the open stock orders, the coffees with their SKUs and default lot, and the green lots a default may point to (the «أمر تحميص للمخزون» dialog). */
export async function GET() {
  const { error } = await requireRoastToStock();
  if (error) return error;
  return stockRun(async () => ({ orders: await openStockOrders(), lots: await stockGreenLots(), products: await stockProducts() }));
}

/** POST {productSkuId, greenKg} — «أمر تحميص للمخزون»: a PENDING ProductionOrder with no order item. 201. */
export async function POST(request: Request) {
  const { actor, error } = await requireRoastToStock({ write: true });
  if (error) return error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // R1-b (owner 1-أ/1-ب): one stock order per submission. The refusals keep their mapping (stockRun).
  try {
    return await withIdempotency(request, { scope: "production.stock_order", actorId: actor.id, intent: body }, async (tx) => ({ status: 201, body: await createStockOrder(actor, body, tx) }));
  } catch (err) {
    return stockRun(async () => { throw err; });
  }
}
