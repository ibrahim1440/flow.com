import { route, readJson, qp } from "@/lib/marketing/server/http";
import { createCampaign, listCampaigns } from "@/lib/marketing/server/campaigns";

export const GET = route(undefined, async (req) => {
  const q = qp(req);
  return { rows: await listCampaigns({ status: q.get("status"), search: q.get("q") }) };
});

export const POST = route("campaigns_manage", async (req, { actor }) => createCampaign(await readJson(req), actor));
