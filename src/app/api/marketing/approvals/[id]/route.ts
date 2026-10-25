import { route, readJson } from "@/lib/marketing/server/http";
import { cancelApproval, decideApproval } from "@/lib/marketing/server/approvals";

type P = { id: string };

/** { decision: "APPROVE" | "REJECT", note } — never on one's own request. */
export const POST = route<P>("approve", async (req, { actor, params }) => decideApproval(params.id, await readJson(req), actor));

/** The requester withdraws a pending request. */
export const DELETE = route<P>(undefined, async (_req, { actor, params }) => {
  await cancelApproval(params.id, actor);
  return { ok: true };
});
