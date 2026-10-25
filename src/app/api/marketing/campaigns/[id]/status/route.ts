import { route, readJson, str } from "@/lib/marketing/server/http";
import { setCampaignStatus } from "@/lib/marketing/server/campaigns";

export const POST = route<{ id: string }>("campaigns_manage", async (req, { actor, params }) => {
  const b = await readJson(req);
  return setCampaignStatus(params.id, String(b.status ?? ""), actor, str(b.note, "ملاحظة", { max: 500 }));
});
