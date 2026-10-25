import "server-only";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { type Actor, MktError } from "./http";
import { commandCenter } from "./overview";
import { attributionReport } from "./store";
import { listBudgets } from "./budgets";
import { loadSettings } from "./settings";
import { KPI, dayBounds } from "../kpi";
import { PLATFORM } from "../platforms";
import { VERDICT_LABELS, type Verdict } from "../decision";

export type ReportKind = "DAILY" | "WEEKLY" | "MONTHLY";

/** The period a report covers, in the company's timezone (Asia/Riyadh has no DST: whole days at 21:00Z). */
export function reportPeriod(kind: ReportKind, anchor: Date, timezone: string): { from: Date; to: Date; label: string } {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(anchor);
  const [y, m, d] = ymd.split("-").map(Number);
  // Offset of the zone at the anchor (UTC = local − offset); fine for zones without a DST jump inside the period.
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(anchor).map((x) => [x.type, x.value]));
  const offsetMs = -(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(anchor.getTime() / 1000) * 1000);
  const localMidnight = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd) + offsetMs);
  if (kind === "DAILY") {
    const from = localMidnight(y, m, d - 1);
    return { from, to: localMidnight(y, m, d), label: new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10) };
  }
  if (kind === "WEEKLY") {
    const to = localMidnight(y, m, d);
    return { from: new Date(to.getTime() - 7 * 86_400_000), to, label: `${new Date(Date.UTC(y, m - 1, d - 7)).toISOString().slice(0, 10)} → ${new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)}` };
  }
  // MONTHLY: the previous full calendar month.
  return { from: localMidnight(y, m - 1, 1), to: localMidnight(y, m, 1), label: `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}` };
}

export async function buildReport(kind: ReportKind, anchor: Date, actor: Actor) {
  const s = await loadSettings();
  const p = reportPeriod(kind, anchor, s.timezone);
  const cc = await commandCenter(p.from, p.to, actor);
  const failedPosts = await prisma.mktPostVariant.findMany({ where: { status: "FAILED", updatedAt: { gte: p.from, lt: p.to } }, select: { platform: true, lastError: true, post: { select: { title: true } } } });
  const published = await prisma.mktPostVariant.findMany({ where: { publishedAt: { gte: p.from, lt: p.to } }, select: { platform: true, externalUrl: true, status: true, post: { select: { title: true } } } });
  const decisions = await prisma.mktDecision.findMany({ where: { createdAt: { gte: p.from, lt: p.to } }, include: { campaign: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 50 });
  const byPlatformContent = await prisma.mktMetricSnapshot.groupBy({ by: ["platform"], where: { level: "POST", day: dayBounds(p.from, p.to) }, _sum: { reach: true, engagements: true, linkClicks: true } });
  const attribution = cc.showMoney ? await attributionReport(p.from, p.to) : null;
  const budget = kind === "MONTHLY" ? await listBudgets(p.label).catch(() => null) : null;
  const msgs = await prisma.mktMessage.groupBy({ by: ["status"], where: { createdAt: { gte: p.from, lt: p.to } }, _count: { _all: true } });
  return {
    kind, period: { ...p, timezone: s.timezone }, generatedAt: new Date(), figures: cc.figures, showMoney: cc.showMoney,
    platforms: cc.platforms, best: cc.best, worst: cc.worst, alerts: cc.alerts, posts: { published, failed: failedPosts },
    contentByPlatform: byPlatformContent.map((c) => ({ platform: c.platform, reach: c._sum.reach, engagements: c._sum.engagements, linkClicks: c._sum.linkClicks })),
    decisions: decisions.map((d) => ({ campaign: d.campaign.name, verdict: d.verdict, reasoning: d.reasoning, status: d.status, at: d.createdAt })),
    attribution, budget, messages: Object.fromEntries(msgs.map((m) => [m.status, m._count._all])),
    tracking: cc.tracking,
  };
}

type Report = Awaited<ReturnType<typeof buildReport>>;

const fmt = (v: unknown) => (v === null || v === undefined ? "غير متاح" : typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v));

/** Rows the CSV and the sheet share: [section, item, value, definition / source]. */
export function reportRows(r: Report): string[][] {
  const rows: string[][] = [["القسم", "البند", "القيمة", "التعريف / المصدر"]];
  rows.push(["التقرير", "الفترة", r.period.label, `${r.period.from.toISOString()} → ${r.period.to.toISOString()} (${r.period.timezone})`]);
  for (const [k, f] of Object.entries(r.figures)) {
    const def = KPI[f.kpi as keyof typeof KPI];
    rows.push(["المؤشرات", def?.ar ?? k, fmt(f.value), `${def?.formulaAr ?? ""} — ${f.source}${f.changePct !== null ? ` — التغير ${f.changePct}%` : ""}`]);
  }
  for (const pl of r.platforms) rows.push(["المنصات", PLATFORM[pl.platform]?.ar ?? pl.platform, fmt(pl.spend), `CTR ${fmt(pl.ctr)}% · CPC ${fmt(pl.cpc)} · CPM ${fmt(pl.cpm)}`]);
  for (const c of r.best) rows.push(["أفضل الحملات", c.name, fmt(c.score), c.scoreKpi]);
  for (const c of r.worst) rows.push(["أضعف الحملات", c.name, fmt(c.score), c.scoreKpi]);
  for (const c of r.contentByPlatform) rows.push(["المحتوى", PLATFORM[c.platform]?.ar ?? c.platform, fmt(c.engagements), `وصول ${fmt(c.reach)} · نقرات ${fmt(c.linkClicks)}`]);
  for (const p of r.posts.published) rows.push(["منشورات منشورة", p.post.title, PLATFORM[p.platform]?.ar ?? p.platform, p.externalUrl ?? (p.status === "MANUAL_DONE" ? "مؤكد يدوياً" : "")]);
  for (const p of r.posts.failed) rows.push(["منشورات فشلت", p.post.title, PLATFORM[p.platform]?.ar ?? p.platform, p.lastError ?? ""]);
  if (r.attribution) {
    for (const c of r.attribution.byCampaign) rows.push(["الإسناد", c.campaign?.name ?? c.campaignId, fmt(c.revenue), `طلبات ${fmt(c.orders)} · عملاء جدد ${fmt(c.newCustomers)} · ${r.attribution.model} ${r.attribution.windowDays} يوم`]);
    rows.push(["الإسناد", "غير منسوب", fmt(r.attribution.unattributed.revenue), `طلبات ${r.attribution.unattributed.orders}`]);
  }
  for (const d of r.decisions) rows.push(["التوصيات", d.campaign, VERDICT_LABELS[d.verdict as Verdict]?.ar ?? d.verdict, d.reasoning.replace(/\n/g, " ")]);
  for (const a of r.alerts) rows.push(["التنبيهات", a.title, a.severity, a.detail ?? ""]);
  if (r.budget) for (const l of r.budget.lines) rows.push(["الميزانية", l.scope === "TOTAL" ? "الكلية" : l.campaign?.name ?? l.scopeRef ?? l.scope, fmt(l.pacing.actual), `مخطط ${l.planned} · متبقٍ ${fmt(l.pacing.remaining)}`]);
  for (const [k, n] of Object.entries(r.messages)) rows.push(["رسائل واتساب", k, String(n), ""]);
  return rows;
}

export function toCsv(rows: string[][]): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s);
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

export async function toXlsx(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Hiqbah Smart Marketing";
  const ws = wb.addWorksheet("التقرير", { views: [{ rightToLeft: true }] });
  ws.columns = [{ width: 18 }, { width: 40 }, { width: 18 }, { width: 80 }];
  for (const row of reportRows(r)) ws.addRow(row.map((c) => (/^[=+\-@]/.test(c) ? `'${c}` : c)));
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function parseKind(v: string | null): ReportKind {
  if (v === "DAILY" || v === "WEEKLY" || v === "MONTHLY") return v;
  throw new MktError("نوع التقرير غير صالح.", "Invalid report kind.");
}
