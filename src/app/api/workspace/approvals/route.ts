import { wsRoute } from "@/lib/workspace/server/http";
import { myApprovals, type ApprovalType } from "@/lib/workspace/server/approvals";

const TYPES = ["LEAVE", "ADVANCE", "DISCOUNT", "FINANCE", "MARKETING"];

/**
 * GET /api/workspace/approvals?type= — what waits for the caller's decision, from each department's own
 * queue and rules. Decisions are POSTed to each item's `decide.url` (the department's own endpoint).
 */
export const GET = wsRoute(({ actor, query }) => {
  const t = query.get("type");
  return myApprovals(actor, t && TYPES.includes(t) ? (t as ApprovalType) : null);
});
