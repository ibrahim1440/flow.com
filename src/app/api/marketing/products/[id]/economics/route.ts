import { route, readJson } from "@/lib/marketing/server/http";
import { upsertEconomics } from "@/lib/marketing/server/campaigns";

export const PUT = route<{ id: string }>(["campaigns_manage", "revenue_view"], async (req, { actor, params }) => upsertEconomics(params.id, await readJson(req), actor));
