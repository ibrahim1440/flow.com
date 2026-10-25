import { route, rangeOf, qp } from "@/lib/marketing/server/http";
import { attributionReport, listStoreOrders } from "@/lib/marketing/server/store";
import type { AttributionModel } from "@/lib/marketing/attribution";

export const GET = route("revenue_view", async (req) => {
  const { from, to } = rangeOf(req, 30);
  const q = qp(req);
  const model = (["FIRST_TOUCH", "LAST_TOUCH", "LINEAR"] as const).find((m) => m === q.get("model"));
  const window = Number(q.get("window")) || undefined;
  const [report, orders] = await Promise.all([
    attributionReport(from, to, model as AttributionModel | undefined, window && window >= 1 && window <= 90 ? window : undefined),
    listStoreOrders({ from, to, search: q.get("q"), unattributedOnly: q.get("unattributed") === "1" }),
  ]);
  return { report, orders };
});
