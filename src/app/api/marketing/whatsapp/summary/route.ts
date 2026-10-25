import { route, rangeOf, can } from "@/lib/marketing/server/http";
import { whatsappSummary } from "@/lib/marketing/server/wa-summary";

export const GET = route(["customers_data", "messaging_manage"], async (req, { actor }) => {
  const { from, to } = rangeOf(req, 30);
  return whatsappSummary(from, to, can(actor, "revenue_view"));
});
