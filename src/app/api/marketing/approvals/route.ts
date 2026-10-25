import { route, qp } from "@/lib/marketing/server/http";
import { listApprovals } from "@/lib/marketing/server/approvals";

export const GET = route(undefined, async (req, { actor }) => {
  const q = qp(req);
  return { rows: await listApprovals({ status: q.get("status"), mine: q.get("mine") === "1" }, actor) };
});
