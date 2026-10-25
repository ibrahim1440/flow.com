import "server-only";
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { MktError, notFound, str, oneOf, type Actor, can, denied, dn } from "./http";
import { audit, userActor } from "./audit";
import { periodMetrics } from "./metrics";
import { attributionReport } from "./store";
import { listBudgets } from "./budgets";
import { decide, DEFAULT_TOLERANCES, type DecisionInput } from "../decision";
import { previousPeriod, whole } from "../kpi";

/** Evaluate one campaign over a period and keep the verdict (with its evidence) for comparison later. */
export async function evaluateCampaign(campaignId: string, from: Date, to: Date, actor: Actor | null) {
  const c = await prisma.mktCampaign.findUnique({ where: { id: campaignId }, include: { product: { include: { mktEconomics: true } } } });
  if (!c) throw notFound();
  const [m, attr] = await Promise.all([periodMetrics({ from, to, campaignId }), attributionReport(from, to)]);
  const prev = previousPeriod(from, to);
  const [pm, pattr] = await Promise.all([periodMetrics({ from: prev.from, to: prev.to, campaignId }), attributionReport(prev.from, prev.to)]);
  const credit = attr.byCampaign.find((x) => x.campaignId === campaignId);
  const pcredit = pattr.byCampaign.find((x) => x.campaignId === campaignId);
  const econ = c.product?.mktEconomics;

  // Tracking is "healthy" when orders with this campaign's UTM arrived in the last 30 days; unknown when none ever did.
  const lastUtm = await prisma.mktStoreOrder.findFirst({ where: { campaignId }, orderBy: { placedAt: "desc" }, select: { placedAt: true } });
  const trackingHealthy = lastUtm ? lastUtm.placedAt.getTime() > Date.now() - 30 * 86_400_000 : null;
  const openAlerts = await prisma.mktAlert.findMany({ where: { status: "OPEN", kind: { in: ["STOCK_OUT", "LANDING_DOWN", "CHECKOUT_ISSUE"] } }, select: { title: true } });
  const month = to.toISOString().slice(0, 7);
  const budget = await listBudgets(month).catch(() => null);
  const line = budget?.lines.find((l) => l.scope === "CAMPAIGN" && l.campaign?.id === campaignId) ?? budget?.lines.find((l) => l.scope === "TOTAL");

  const input: DecisionInput = {
    periodDays: Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000)),
    // Partial totals (only some rows reported them) are unknown to the engine, never a smaller number.
    spend: whole(m.totals, "spend"), impressions: whole(m.totals, "impressions"), linkClicks: whole(m.totals, "linkClicks"),
    orders: attr.totals.orders ? credit?.orders ?? 0 : null, newCustomers: attr.totals.orders ? credit?.newCustomers ?? 0 : null, netRevenue: attr.totals.orders ? credit?.revenue ?? 0 : null,
    previous: { spend: whole(pm.totals, "spend"), linkClicks: whole(pm.totals, "linkClicks"), impressions: whole(pm.totals, "impressions"), orders: pattr.totals.orders ? pcredit?.orders ?? 0 : null },
    targets: { targetCac: dn(c.targetCac) ?? dn(econ?.targetCac), targetRoas: dn(c.targetRoas), minSpend: dn(c.minSpendForDecision), minConversions: c.minConversionsForDecision },
    economics: econ ? { grossMarginPct: dn(econ.grossMarginPct), variableCostPerOrder: dn(econ.variableCostPerOrder), avgOrderValue: dn(econ.avgOrderValue) } : null,
    trackingHealthy,
    dataAgeHours: m.lastUpdated ? (Date.now() - m.lastUpdated.getTime()) / 3600_000 : null,
    budgetHeadroom: line?.pacing.remaining ?? null,
    sellSideIssues: openAlerts.map((a) => a.title),
  };
  const d = decide(input, DEFAULT_TOLERANCES, line?.maxAutoIncreasePct ?? null);
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.mktDecision.create({
      data: {
        campaignId, verdict: d.verdict, periodStart: from, periodEnd: to, confidence: d.confidence, reasoning: d.reasonsAr.join("\n"), requiresApproval: d.requiresApproval,
        evidence: { ...d.evidence, limitations: d.limitationsAr, action: d.actionAr, impact: d.impactAr, risk: d.riskAr, maxStep: d.maxStep ?? null, attributionModel: attr.model, windowDays: attr.windowDays, sources: m.sources } as Prisma.InputJsonValue,
      },
    });
    await audit(tx, actor ? userActor(actor) : { kind: "RULE", name: "decision-engine" }, "decision.evaluated", "MktCampaign", campaignId, { after: { verdict: d.verdict, decisionId: r.id } });
    return r;
  }, TX_OPTS);
  return { decision: row, detail: d };
}

// Figures that are revenue (or derived from it): shown only to revenue_view, like the rest of the module.
const REVENUE_KEYS = ["netRevenue", "roas", "targetRoas", "breakEvenRoas", "impact"] as const;
const REVENUE_HIDDEN_AR = "تتضمن أرقام الإيراد والعائد؛ تظهر لمن يملك صلاحية «عرض الإيرادات».";

/** A decision as a viewer without revenue_view may see it: the verdict, action, risk and limits, no revenue. */
export function redactDecision<T extends { evidence?: unknown; reasoning?: string }>(d: T, actor: Actor): T {
  if (can(actor, "revenue_view")) return d;
  const ev = { ...((d.evidence ?? {}) as Record<string, unknown>) };
  for (const k of REVENUE_KEYS) if (k in ev) ev[k] = k === "impact" ? REVENUE_HIDDEN_AR : null;
  return { ...d, evidence: { ...ev, revenueHidden: true }, ...(d.reasoning !== undefined ? { reasoning: `الأسباب ${REVENUE_HIDDEN_AR}` } : {}) };
}

export async function listDecisions(campaignId: string, actor: Actor) {
  const rows = await prisma.mktDecision.findMany({ where: { campaignId }, orderBy: { createdAt: "desc" }, take: 30 });
  return rows.map((r) => redactDecision(r, actor));
}

/** A person records what was done with a verdict, and later what happened (point 10 of the brief). */
export async function closeDecision(id: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "campaigns_manage")) throw denied();
  const status = oneOf(body.status, ["ACCEPTED", "DISMISSED", "EXECUTED"] as const, "الحالة");
  const outcomeNote = str(body.outcomeNote, "النتيجة", { max: 2000 });
  if (status === "EXECUTED" && !outcomeNote) throw new MktError("صف ما نُفّذ ونتيجته.", "Describe what was executed.", 400, "MKT_REQUIRED");
  return prisma.$transaction(async (tx) => {
    const d = await tx.mktDecision.findUnique({ where: { id } });
    if (!d) throw notFound();
    const row = await tx.mktDecision.update({ where: { id }, data: { status, outcomeNote, decidedById: actor.id } });
    await audit(tx, userActor(actor), "decision.closed", "MktDecision", id, { before: { status: d.status }, after: { status, outcomeNote } });
    return row;
  }, TX_OPTS);
}
