import { route, MktError } from "@/lib/marketing/server/http";
import { importMetricsCsv } from "@/lib/marketing/server/metrics";

/** text/csv body (an ads-manager export). Empty cells are "not reported", never zero. */
export const POST = route("campaigns_manage", async (req, { actor }) => {
  const text = await req.text();
  if (text.length > 5_000_000) throw new MktError("الملف أكبر من 5 ميغابايت.", "File too large.", 413);
  return importMetricsCsv(text, actor);
});
