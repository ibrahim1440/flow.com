import { route, readJson, rangeOf, qp } from "@/lib/marketing/server/http";
import { listSnapshots, metricsByPlatform, periodMetrics, saveManualMetric } from "@/lib/marketing/server/metrics";
import { deliveryKpis } from "@/lib/marketing/kpi";

export const GET = route(undefined, async (req) => {
  const { from, to } = rangeOf(req, 30);
  const platform = qp(req).get("platform");
  const [snapshots, byPlatform, paid, organic] = await Promise.all([
    listSnapshots({ from, to, platform }), metricsByPlatform(from, to),
    periodMetrics({ from, to, platform }), periodMetrics({ from, to, platform, kind: "ORGANIC" }),
  ]);
  return { snapshots, byPlatform, paid: { ...deliveryKpis(paid.totals), lastUpdated: paid.lastUpdated, sources: paid.sources }, organic: { ...deliveryKpis(organic.totals), lastUpdated: organic.lastUpdated, sources: organic.sources } };
});

export const POST = route(["campaigns_manage", "budget_manage"], async (req, { actor }) => saveManualMetric(await readJson(req), actor));
