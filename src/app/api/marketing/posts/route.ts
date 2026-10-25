import { route, readJson, qp, MktError } from "@/lib/marketing/server/http";
import { createPost, listPosts } from "@/lib/marketing/server/posts";

export const GET = route(undefined, async (req) => {
  const q = qp(req);
  const from = q.get("from") ? new Date(q.get("from")!) : null;
  const to = q.get("to") ? new Date(q.get("to")!) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) throw new MktError("نطاق التاريخ غير صالح.", "Invalid range.");
  return { rows: await listPosts({ from, to, platform: q.get("platform"), campaignId: q.get("campaignId"), productId: q.get("productId"), status: q.get("status"), unscheduled: q.get("unscheduled") === "1" }) };
});

export const POST = route("content_manage", async (req, { actor }) => createPost(await readJson(req), actor));
