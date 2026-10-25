import "server-only";
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { MktError, str, oneOf, num, type Actor, can, denied, dn } from "./http";
import { audit, userActor } from "./audit";
import { PLATFORM } from "../platforms";
import { METRIC_FIELDS, dayBounds, dayLabel, deliveryKpis, totals, type MetricRow } from "../kpi";
import { parseCsv } from "../store-normalize";

/**
 * Daily performance snapshots. Phase 1 fills them by a person (MANUAL, one row) or by an export file
 * (IMPORT) — each row says which. Phase 3 adds the platform APIs (API). Rows of different sources
 * for the same object and day are kept side by side and never added together: the API row wins in
 * every total when present (`effectiveRows`).
 */

const INT_FIELDS = ["impressions", "reach", "clicks", "linkClicks", "landingPageViews", "videoViews", "engagements", "followersDelta", "leads", "purchases"] as const;

function readMetricRow(body: Record<string, unknown>) {
  const platform = str(body.platform, "المنصة", { required: true })!;
  if (!PLATFORM[platform]) throw new MktError("منصة غير معروفة.", "Unknown platform.");
  const dayRaw = str(body.day, "اليوم", { required: true })!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayRaw)) throw new MktError("اليوم بصيغة YYYY-MM-DD.", "day must be YYYY-MM-DD.");
  const data: Record<string, unknown> = {
    day: new Date(`${dayRaw}T00:00:00Z`), platform,
    level: oneOf(body.level, ["ACCOUNT", "CAMPAIGN", "ADSET", "AD", "POST"] as const, "المستوى", "CAMPAIGN"),
    kind: oneOf(body.kind, ["PAID", "ORGANIC"] as const, "النوع", "PAID"),
    externalId: str(body.externalId, "معرف العنصر", { max: 200 }) ?? "account",
    campaignId: str(body.campaignId, "الحملة"),
    currency: (str(body.currency, "العملة", { max: 3 }) ?? "SAR").toUpperCase(),
    spend: num(body.spend, "الإنفاق", { min: 0 }),
    conversionValue: num(body.conversionValue, "قيمة التحويل", { min: 0 }),
  };
  for (const f of INT_FIELDS) data[f] = num(body[f], f, { min: f === "followersDelta" ? -1e9 : 0, int: true });
  // Riyadh's today is a valid day from its local midnight (21:00 UTC the day before).
  if (data.day! > dayLabel(new Date())) throw new MktError("لا يمكن إدخال أداء ليوم لم يأتِ.", "Day is in the future.");
  return data;
}

export async function saveManualMetric(body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "campaigns_manage") && !can(actor, "budget_manage")) throw denied();
  const d = readMetricRow(body);
  const key = { day: d.day as Date, platform: d.platform as string, level: d.level as string, externalId: d.externalId as string, source: "MANUAL" };
  return prisma.$transaction(async (tx) => {
    const before = await tx.mktMetricSnapshot.findUnique({ where: { day_platform_level_externalId_source: key } });
    const row = await tx.mktMetricSnapshot.upsert({
      where: { day_platform_level_externalId_source: key },
      create: { ...(d as Prisma.MktMetricSnapshotUncheckedCreateInput), source: "MANUAL", enteredById: actor.id },
      update: { ...(d as Prisma.MktMetricSnapshotUncheckedUpdateInput), enteredById: actor.id, fetchedAt: new Date() },
    });
    await audit(tx, userActor(actor), before ? "metrics.manual_updated" : "metrics.manual_entered", "MktMetricSnapshot", row.id, { before, after: row });
    return row;
  }, TX_OPTS);
}

/**
 * An export file from an ads manager. Required headers: day, platform; optional: level, external_id,
 * campaign (utm_campaign), spend, impressions, reach, clicks, link_clicks, landing_page_views,
 * video_views, engagements, leads, purchases, conversion_value, currency. An empty cell is "not
 * reported" (NULL), never zero.
 */
export async function importMetricsCsv(text: string, actor: Actor) {
  if (!can(actor, "campaigns_manage")) throw denied();
  const rows = parseCsv(text);
  if (!rows.length) throw new MktError("الملف فارغ.", "Empty file.");
  if (rows.length > 10000) throw new MktError("الحد الأقصى 10000 صف.", "At most 10000 rows.");
  const campaigns = new Map((await prisma.mktCampaign.findMany({ select: { id: true, utmCampaign: true } })).map((c) => [c.utmCampaign, c.id]));
  const errors: { row: number; reason: string }[] = [];
  let saved = 0;
  await prisma.$transaction(async (tx) => {
    for (const [i, r] of rows.entries()) {
      try {
        const d = readMetricRow({
          day: r.day, platform: r.platform?.toUpperCase(), level: r.level?.toUpperCase() || undefined, kind: r.kind?.toUpperCase() || undefined,
          externalId: r.external_id || undefined, campaignId: r.campaign ? campaigns.get(r.campaign.toLowerCase()) ?? null : null,
          currency: r.currency || undefined, spend: r.spend, impressions: r.impressions, reach: r.reach, clicks: r.clicks, linkClicks: r.link_clicks,
          landingPageViews: r.landing_page_views, videoViews: r.video_views, engagements: r.engagements, followersDelta: r.followers_delta,
          leads: r.leads, purchases: r.purchases, conversionValue: r.conversion_value,
        });
        if (r.campaign && !d.campaignId) throw new MktError(`الحملة «${r.campaign}» غير معروفة`, "unknown campaign");
        const key = { day: d.day as Date, platform: d.platform as string, level: d.level as string, externalId: d.externalId as string, source: "IMPORT" };
        await tx.mktMetricSnapshot.upsert({ where: { day_platform_level_externalId_source: key }, create: { ...(d as Prisma.MktMetricSnapshotUncheckedCreateInput), source: "IMPORT", enteredById: actor.id }, update: { ...(d as Prisma.MktMetricSnapshotUncheckedUpdateInput), fetchedAt: new Date(), enteredById: actor.id } });
        saved++;
      } catch (e) {
        errors.push({ row: i + 2, reason: e instanceof MktError ? e.ar : "صف غير صالح" });
      }
    }
    await audit(tx, userActor(actor), "metrics.csv_import", "MktMetricSnapshot", null, { after: { rows: rows.length, saved, errors: errors.length } });
  }, { ...TX_OPTS, timeout: 120_000 });
  return { rows: rows.length, saved, errors: errors.slice(0, 100) };
}

type SnapshotRow = Prisma.MktMetricSnapshotGetPayload<object>;

/** One row per (day, platform, level, object): API beats IMPORT beats MANUAL. */
export function effectiveRows(rows: SnapshotRow[]): SnapshotRow[] {
  const rank: Record<string, number> = { API: 3, IMPORT: 2, MANUAL: 1 };
  const best = new Map<string, SnapshotRow>();
  for (const r of rows) {
    const k = `${r.day.toISOString()}|${r.platform}|${r.level}|${r.externalId}`;
    const cur = best.get(k);
    if (!cur || rank[r.source] > rank[cur.source]) best.set(k, r);
  }
  return [...best.values()];
}

export function toMetricRow(r: SnapshotRow): MetricRow {
  const out = {} as MetricRow;
  for (const f of METRIC_FIELDS) {
    const v = (r as unknown as Record<string, unknown>)[f];
    out[f] = v === null || v === undefined ? null : typeof v === "number" ? v : dn(v as { toString(): string });
  }
  return out;
}

/**
 * Metric rows of a period at ONE level so nothing is double counted: campaign-level rows when they
 * exist for a platform, else account-level. Paid only unless `kind` says otherwise.
 */
/** `days`: explicit day labels (a budget period) — used as they are instead of the days the instants cover. */
export async function periodMetrics(q: { from: Date; to: Date; days?: { gte: Date; lt: Date }; platform?: string | null; campaignId?: string | null; kind?: "PAID" | "ORGANIC" }) {
  const rows = effectiveRows(await prisma.mktMetricSnapshot.findMany({
    where: { day: q.days ?? dayBounds(q.from, q.to), kind: q.kind ?? "PAID", ...(q.platform ? { platform: q.platform } : {}), ...(q.campaignId ? { campaignId: q.campaignId } : {}), level: { in: ["ACCOUNT", "CAMPAIGN"] } },
  }));
  const platforms = [...new Set(rows.map((r) => r.platform))];
  const chosen: SnapshotRow[] = [];
  for (const p of platforms) {
    const pr = rows.filter((r) => r.platform === p);
    const camp = pr.filter((r) => r.level === "CAMPAIGN");
    chosen.push(...(q.campaignId || camp.length ? camp : pr.filter((r) => r.level === "ACCOUNT")));
  }
  const newest = chosen.reduce<Date | null>((d, r) => (!d || r.fetchedAt > d ? r.fetchedAt : d), null);
  const sources = [...new Set(chosen.map((r) => r.source))];
  return { rows: chosen, totals: totals(chosen.map(toMetricRow)), lastUpdated: newest, sources };
}

export async function metricsByPlatform(from: Date, to: Date) {
  const { rows } = await periodMetrics({ from, to });
  const by = new Map<string, SnapshotRow[]>();
  for (const r of rows) (by.get(r.platform) ?? by.set(r.platform, []).get(r.platform)!).push(r);
  return [...by.entries()].map(([platform, rs]) => ({ platform, ...deliveryKpis(totals(rs.map(toMetricRow))), lastUpdated: rs.reduce((d, r) => (r.fetchedAt > d ? r.fetchedAt : d), rs[0].fetchedAt), sources: [...new Set(rs.map((r) => r.source))] }));
}

export async function listSnapshots(q: { from: Date; to: Date; platform?: string | null }) {
  return prisma.mktMetricSnapshot.findMany({ where: { day: dayBounds(q.from, q.to), ...(q.platform ? { platform: q.platform } : {}) }, orderBy: [{ day: "desc" }, { platform: "asc" }], take: 500, include: { campaign: { select: { id: true, name: true } } } });
}
