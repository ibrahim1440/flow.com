import { route, rangeOf } from "@/lib/marketing/server/http";
import { bestHours, planInsights } from "@/lib/marketing/server/posts";
import { loadSettings } from "@/lib/marketing/server/settings";

export const GET = route(undefined, async (req) => {
  const { from, to } = rangeOf(req, 30);
  const s = await loadSettings();
  return { plan: await planInsights(from, to, s.timezone), bestHours: await bestHours(s.timezone), timezone: s.timezone };
});
