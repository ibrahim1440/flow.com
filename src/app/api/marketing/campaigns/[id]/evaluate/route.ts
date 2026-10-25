import { route, rangeOf, can } from "@/lib/marketing/server/http";
import { evaluateCampaign, redactDecision } from "@/lib/marketing/server/decisions";

/** Runs the decision engine for one campaign over ?from&to (default: the last 7 days). Proposes only. */
export const POST = route<{ id: string }>(["campaigns_manage", "revenue_view"], async (req, { actor, params }) => {
  const { from, to } = rangeOf(req, 7);
  const r = await evaluateCampaign(params.id, from, to, actor);
  if (can(actor, "revenue_view")) return r;
  // The engine reads revenue to decide; a campaign manager without revenue_view gets the verdict, the action,
  // the risk and the limits — not the figures or the reasons built from them.
  const { verdict, confidence, actionAr, riskAr, limitationsAr, requiresApproval } = r.detail;
  return { decision: redactDecision(r.decision, actor), detail: { verdict, confidence, actionAr, riskAr, limitationsAr, requiresApproval, revenueHidden: true } };
});
