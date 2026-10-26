import "server-only";
import { prisma } from "@/lib/db";
import { dn, can, type Actor } from "./http";
import { periodMetrics, metricsByPlatform } from "./metrics";
import { attributionReport } from "./store";
import { listBudgets } from "./budgets";
import { listConnections } from "./connections";
import { loadSettings } from "./settings";
import { change, deliveryKpis, efficiencyKpis, previousPeriod, ratio, round, sumN, whole, dayBounds, type Num } from "../kpi";
import { PLATFORM } from "../platforms";

/**
 * «مركز القيادة التسويقية». Every figure carries where it came from and when (`src`), and a figure
 * the caller may not see (revenue without marketing › revenue_view) is omitted, not zeroed.
 */

export type Figure = { value: Num; previous: Num; changePct: Num; kpi: string; source: string; sourceEn: string; lastUpdated: Date | null };

/** `source` is the Arabic description of where the figure comes from; `sourceEn` the same in English. */
const fig = (kpi: string, value: Num, previous: Num, source: [string, string], lastUpdated: Date | null): Figure => ({ kpi, value, previous, changePct: change(value, previous), source: source[0], sourceEn: source[1], lastUpdated });

async function periodBlock(from: Date, to: Date) {
  const m = await periodMetrics({ from, to });
  const msg = await prisma.mktMessage.aggregate({ where: { sentAt: { gte: from, lt: to }, cost: { not: null } }, _sum: { cost: true }, _count: { _all: true } });
  const msgCost = msg._count._all > 0 ? dn(msg._sum.cost) : null;
  const attr = await attributionReport(from, to);
  const attributedOrders = attr.byCampaign.reduce((n, c) => n + c.orders, 0);
  const attributedRevenue = attr.byCampaign.reduce((n, c) => n + c.revenue, 0);
  const attributedNew = attr.byCampaign.reduce((n, c) => n + c.newCustomers, 0);
  const d = deliveryKpis(m.totals);
  const storeOrders = attr.totals.orders;
  const totalSpend = sumN([m.totals.spend, msgCost]);
  // Ratios only over totals every row reported (kpi.ts › totals.partial): a partial total feeds none.
  const spendWhole = whole(m.totals, "spend");
  const totalSpendWhole = spendWhole === null && m.totals.spend !== null ? null : totalSpend;
  const e = efficiencyKpis({ spend: spendWhole, linkClicks: whole(m.totals, "linkClicks"), orders: storeOrders ? attributedOrders : null, newCustomers: storeOrders ? attributedNew : null, netRevenue: storeOrders ? attributedRevenue : null, totalNetRevenue: attr.totals.netRevenue, totalSpend: totalSpendWhole });
  return {
    metrics: m, msgCost, totalSpend, d, e, attr,
    blendedCac: round2(ratio(totalSpendWhole, attr.totals.newCustomers)),
    attributedOrders: storeOrders ? round(attributedOrders) : null,
  };
}

const round2 = (v: Num) => (v === null ? null : round(v, 2));

export async function commandCenter(from: Date, to: Date, actor: Actor) {
  const showMoney = can(actor, "revenue_view");
  const prev = previousPeriod(from, to);
  const [cur, old, settings] = await Promise.all([periodBlock(from, to), periodBlock(prev.from, prev.to), loadSettings()]);
  const upd = cur.metrics.lastUpdated;
  const adsAr = cur.metrics.sources.length ? `منصات الإعلان (${cur.metrics.sources.join("، ")})` : "لا توجد بيانات إنفاق";
  const adsEn = cur.metrics.sources.length ? `Ad platforms (${cur.metrics.sources.join(", ")})` : "No spend data";
  const adsSrc: [string, string] = [adsAr, adsEn];
  const storeSrc: [string, string] = ["طلبات المتجر الإلكتروني", "Online store orders"];
  const lastOrder = await prisma.mktStoreOrder.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } });

  const figures: Record<string, Figure> = {
    spend: fig("spend", cur.totalSpend, old.totalSpend, [`${adsAr} + تكلفة رسائل واتساب`, `${adsEn} + WhatsApp messaging cost`], upd),
    impressions: fig("impressions", cur.d.impressions, old.d.impressions, adsSrc, upd),
    linkClicks: fig("linkClicks", cur.d.linkClicks, old.d.linkClicks, adsSrc, upd),
    ctr: fig("ctr", cur.d.ctr, old.d.ctr, adsSrc, upd),
    linkCtr: fig("linkCtr", cur.d.linkCtr, old.d.linkCtr, adsSrc, upd),
    cpc: fig("cpc", cur.d.cpc, old.d.cpc, adsSrc, upd),
    cpm: fig("cpm", cur.d.cpm, old.d.cpm, adsSrc, upd),
  };
  if (showMoney) {
    const ordersKnown = cur.attr.totals.orders > 0 || !!lastOrder;
    Object.assign(figures, {
      orders: fig("orders", ordersKnown ? cur.attr.totals.orders : null, ordersKnown ? old.attr.totals.orders : null, storeSrc, lastOrder?.updatedAt ?? null),
      netRevenue: fig("netRevenue", ordersKnown ? cur.attr.totals.netRevenue : null, ordersKnown ? old.attr.totals.netRevenue : null, storeSrc, lastOrder?.updatedAt ?? null),
      newCustomers: fig("newCustomers", ordersKnown ? cur.attr.totals.newCustomers : null, ordersKnown ? old.attr.totals.newCustomers : null, storeSrc, lastOrder?.updatedAt ?? null),
      cac: fig("cac", cur.blendedCac, old.blendedCac, [`${adsAr} ÷ ${storeSrc[0]} (إجمالي)`, `${adsEn} ÷ ${storeSrc[1]} (total)`], upd),
      cpa: fig("cpa", cur.e.cpa, old.e.cpa, [`الإنفاق ÷ الطلبات المنسوبة (${cur.attr.model})`, `Spend ÷ attributed orders (${cur.attr.model})`], upd),
      cvr: fig("cvr", cur.e.cvr, old.e.cvr, [`الطلبات المنسوبة ÷ نقرات الرابط`, "Attributed orders ÷ link clicks"], upd),
      roas: fig("roas", cur.e.roas, old.e.roas, [`الإيراد المنسوب (${cur.attr.model}, ${cur.attr.windowDays} يوم) ÷ إنفاق الإعلانات`, `Attributed revenue (${cur.attr.model}, ${cur.attr.windowDays} days) ÷ ad spend`], upd),
      mer: fig("mer", cur.e.mer, old.e.mer, ["صافي إيراد المتجر ÷ إجمالي الإنفاق التسويقي", "Store net revenue ÷ total marketing spend"], upd),
    });
  }

  const [postsByStatus, pendingApprovals, openAlerts, manualRequired] = await Promise.all([
    prisma.mktPost.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.mktApproval.count({ where: { status: "PENDING" } }),
    prisma.mktAlert.findMany({ where: { status: "OPEN" }, orderBy: [{ severity: "desc" }, { createdAt: "desc" }], take: 10 }),
    prisma.mktPostVariant.count({ where: { status: "MANUAL_REQUIRED" } }),
  ]);
  const publishedInPeriod = await prisma.mktPostVariant.count({ where: { publishedAt: { gte: from, lt: to } } });
  const posts = { byStatus: Object.fromEntries(postsByStatus.map((p) => [p.status, p._count._all])), publishedInPeriod, manualRequired };

  const month = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone, year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  const budget = can(actor, "budget_manage") || showMoney ? await listBudgets(month).catch(() => null) : null;

  const platforms = await metricsByPlatform(from, to);
  const campaigns = await prisma.mktCampaign.findMany({ where: { status: { in: ["ACTIVE", "PAUSED", "COMPLETED"] } }, select: { id: true, name: true, objective: true, status: true } });
  const credit = new Map(cur.attr.byCampaign.map((c) => [c.campaignId, c]));
  const campaignRows = await Promise.all(campaigns.map(async (c) => {
    const m = await periodMetrics({ from, to, campaignId: c.id });
    const cr = credit.get(c.id);
    const d = deliveryKpis(m.totals);
    return {
      ...c, spend: m.totals.spend, linkClicks: m.totals.linkClicks, ctr: d.ctr,
      ...(showMoney ? { orders: cr?.orders ?? (cur.attr.totals.orders ? 0 : null), revenue: cr?.revenue ?? null, roas: round2(ratio(cr?.revenue ?? null, whole(m.totals, "spend"))), cac: round2(ratio(whole(m.totals, "spend"), cr?.newCustomers ?? null)) } : {}),
    };
  }));
  // Best / worst by the metric of each campaign's objective, only among campaigns with that metric.
  const scoreKey = (o: string) => (showMoney && ["SALES", "CONVERSIONS", "RETENTION"].includes(o) ? "roas" : "ctr");
  const ranked = campaignRows.map((c) => ({ ...c, score: (c as Record<string, unknown>)[scoreKey(c.objective)] as Num, scoreKpi: scoreKey(c.objective) })).filter((c) => c.score !== null);
  ranked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const topPosts = await prisma.mktMetricSnapshot.groupBy({
    by: ["platform", "externalId"], where: { level: "POST", day: dayBounds(from, to) },
    _sum: { reach: true, engagements: true, linkClicks: true }, orderBy: { _sum: { engagements: "desc" } }, take: 5,
  });
  const variants = await prisma.mktPostVariant.findMany({ where: { externalPostId: { in: topPosts.map((t) => t.externalId) } }, select: { externalPostId: true, externalUrl: true, post: { select: { id: true, title: true } } } });

  const connections = (await listConnections()).filter((c) => c.status !== "NOT_CONFIGURED" || ["KARZOUN", "WHATSAPP_CLOUD", "STORE", "FACEBOOK", "INSTAGRAM"].includes(c.platform))
    .map((c) => ({ platform: c.platform, name: PLATFORM[c.platform]?.ar ?? c.platform, status: c.status, expiringSoon: c.expiringSoon, lastCheckedAt: c.lastCheckedAt, missingEnv: c.missingEnv.length }));

  // Tracking health: share of the period's live store orders that arrived with a utm_campaign.
  const live = cur.attr.totals.orders;
  const withUtm = await prisma.mktStoreOrder.count({ where: { placedAt: { gte: from, lt: to }, status: { notIn: ["CANCELLED", "PENDING"] }, utmCampaign: { not: null } } });
  const tracking = { orders: live, withUtm, sharePct: live ? round((withUtm / live) * 100, 1) : null, unknownUtmCampaigns: cur.attr.unknownUtmCampaigns };

  return {
    period: { from, to, previousFrom: prev.from, previousTo: prev.to, timezone: settings.timezone, currency: settings.currency },
    showMoney, figures, posts, pendingApprovals, alerts: openAlerts, budget: budget ? { period: budget.period, total: budget.lines.find((l) => l.scope === "TOTAL") ?? null, actual: budget.actual, allocation: budget.allocation } : null,
    platforms, best: ranked.slice(0, 3), worst: ranked.length > 3 ? ranked.slice(-3).reverse() : [],
    topPosts: topPosts.map((t) => ({ platform: t.platform, externalId: t.externalId, reach: t._sum.reach, engagements: t._sum.engagements, linkClicks: t._sum.linkClicks, post: variants.find((v) => v.externalPostId === t.externalId)?.post ?? null, url: variants.find((v) => v.externalPostId === t.externalId)?.externalUrl ?? null })),
    connections, tracking,
    kill: { all: settings.killAll, publishing: settings.killPublishing, ads: settings.killAds, messaging: settings.killMessaging },
    attribution: showMoney ? { model: cur.attr.model, windowDays: cur.attr.windowDays, unattributed: cur.attr.unattributed, revenueBasis: cur.attr.revenueBasis } : null,
  };
}
