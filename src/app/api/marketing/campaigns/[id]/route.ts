import { route, readJson } from "@/lib/marketing/server/http";
import { getCampaign, updateCampaign } from "@/lib/marketing/server/campaigns";
import { listDecisions } from "@/lib/marketing/server/decisions";
import { prisma } from "@/lib/db";

type P = { id: string };

export const GET = route<P>(undefined, async (_req, { params, actor }) => {
  const campaign = await getCampaign(params.id);
  const [decisions, posts, approvals] = await Promise.all([
    listDecisions(params.id, actor),
    prisma.mktPost.findMany({ where: { campaignId: params.id }, select: { id: true, title: true, status: true, scheduledAt: true }, orderBy: { scheduledAt: "desc" }, take: 50 }),
    prisma.mktApproval.findMany({ where: { subjectType: { in: ["CAMPAIGN", "MESSAGE_CAMPAIGN"] }, subjectId: params.id }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  return { campaign, decisions, posts, approvals };
});

export const PATCH = route<P>("campaigns_manage", async (req, { actor, params }) => updateCampaign(params.id, await readJson(req), actor));
