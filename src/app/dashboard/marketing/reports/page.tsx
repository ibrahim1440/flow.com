"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Banner, Sec, Chip, useLoad, usePageTitle, fmt, fmtDate, platformName, TextInput, type Figure } from "../_components/ui";
import { KPI, type KpiKey } from "@/lib/marketing/kpi";
import { VERDICT_LABELS, type Verdict } from "@/lib/marketing/decision";
import { PRINT_PHASE1_NOTE_ID, PrintPhase1Notice, usePrintDocuments } from "@/components/print/Certification";

/**
 * «التقارير» — daily (yesterday), weekly (last 7 days) and monthly (previous calendar month) reports
 * from the same figures as the command center, with CSV / Excel export and a print view (the
 * browser's «حفظ PDF» produces the PDF with correct Arabic shaping).
 */

type Report = {
  kind: string; period: { label: string; from: string; to: string; timezone: string }; generatedAt: string; showMoney: boolean;
  figures: Record<string, Figure>; platforms: { platform: string; spend: number | null; ctr: number | null; cpc: number | null }[];
  best: { name: string; score: number | null; scoreKpi: string }[]; worst: { name: string; score: number | null; scoreKpi: string }[];
  alerts: { title: string; severity: string }[]; posts: { published: { platform: string; externalUrl: string | null; post: { title: string } }[]; failed: { platform: string; lastError: string | null; post: { title: string } }[] };
  contentByPlatform: { platform: string; reach: number | null; engagements: number | null; linkClicks: number | null }[];
  decisions: { campaign: string; verdict: Verdict; reasoning: string; status: string }[];
  attribution: { byCampaign: { campaign: { name: string } | null; campaignId: string; revenue: number; orders: number; newCustomers: number }[]; unattributed: { revenue: number; orders: number } } | null;
  budget: { lines: { scope: string; planned: number; pacing: { actual: number | null; remaining: number | null } }[] } | null;
  messages: Record<string, number>;
};

export default function ReportsPage() {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  usePageTitle("التقارير", "Reports", lang);
  const [kind, setKind] = useState<"DAILY" | "WEEKLY" | "MONTHLY">("WEEKLY");
  const [anchor, setAnchor] = useState(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date()));
  const qs = `kind=${kind}&anchor=${anchor}`;
  const { data, error, loading } = useLoad<Report>(`/api/marketing/reports?${qs}`);
  // Document printing follows PRINT_DOCUMENTS_ENABLED like every other printable page (Phase 1: off).
  const printing = usePrintDocuments();
  return (
    <div className="mkt" data-testid="mkt-reports">
      <PageHeader title={L("التقارير الإدارية", "Management reports")} subtitle={L("اليومي: أمس · الأسبوعي: آخر 7 أيام · الشهري: الشهر الكامل السابق. بتوقيت الرياض.", "Daily: yesterday · weekly: the last 7 days · monthly: the previous full month. Riyadh time.")} actions={<>
        <div className="mkt-seg" role="group">{(["DAILY", "WEEKLY", "MONTHLY"] as const).map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{(lang === "ar" ? { DAILY: "يومي", WEEKLY: "أسبوعي", MONTHLY: "شهري" } : { DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly" })[k]}</button>)}</div>
        <TextInput id="anchor" type="date" value={anchor} onChange={setAnchor} />
        <a className="mkt-chip" href={`/api/marketing/reports?${qs}&format=csv`} data-testid="csv">CSV</a>
        <a className="mkt-chip" href={`/api/marketing/reports?${qs}&format=xlsx`} data-testid="xlsx">Excel</a>
        <button type="button" className="mkt-chip" disabled={printing !== true} aria-describedby={printing === true ? undefined : PRINT_PHASE1_NOTE_ID} onClick={() => { if (printing === true) window.print(); }}>{L("طباعة / PDF", "Print / PDF")}</button>
      </>} />
      {printing === false ? <PrintPhase1Notice /> : null}
      <Banner>{error}</Banner>
      {loading && !data ? <Spinner /> : data ? <>
        <p className="mkt-muted">{L("الفترة:", "Period:")} <bdi>{data.period.label}</bdi> ({fmtDate(data.period.from, true)} → {fmtDate(data.period.to, true)}) · {L("أُعد", "Prepared")} {fmtDate(data.generatedAt, true)}</p>
        <Sec title={L("المؤشرات", "KPIs")}>
          <table className="mkt-table"><thead><tr><th>{L("المؤشر", "KPI")}</th><th className="n">{L("القيمة", "Value")}</th><th className="n">{L("التغير", "Change")}</th><th>{L("المصدر", "Source")}</th></tr></thead><tbody>{Object.entries(data.figures).map(([k, f]) => { const d = KPI[f.kpi as KpiKey]; return <tr key={k}><td>{d ? L(d.ar, d.en) : k}</td><td className="n">{fmt(f.value, { unit: d?.unit, lang })}</td><td className="n">{f.changePct === null ? "—" : `${f.changePct}%`}</td><td className="mkt-muted">{lang === "ar" ? f.source : f.sourceEn ?? f.source}</td></tr>; })}</tbody></table>
        </Sec>
        <div className="mkt-grid-2">
          <Sec title={L("المنصات", "Platforms")}>{data.platforms.length ? <table className="mkt-table"><tbody>{data.platforms.map((p) => <tr key={p.platform}><td>{platformName(p.platform, lang)}</td><td className="n">{fmt(p.spend, { unit: "SAR", lang })}</td><td className="n">{L("نسبة النقر (CTR)", "CTR")} {fmt(p.ctr, { unit: "pct", lang })}</td></tr>)}</tbody></table> : <p className="mkt-muted">{L("لا بيانات.", "No data.")}</p>}</Sec>
          <Sec title={L("المحتوى حسب المنصة", "Content by platform")}>{data.contentByPlatform.length ? <table className="mkt-table"><tbody>{data.contentByPlatform.map((p) => <tr key={p.platform}><td>{platformName(p.platform, lang)}</td><td className="n">{L("وصول", "Reach")} {fmt(p.reach, { unit: "count", lang })}</td><td className="n">{L("تفاعل", "Engagements")} {fmt(p.engagements, { unit: "count", lang })}</td></tr>)}</tbody></table> : <p className="mkt-muted">{L("لا بيانات.", "No data.")}</p>}</Sec>
          <Sec title={L("أفضل وأضعف الحملات", "Best and weakest campaigns")}>{[...data.best.map((c) => [L("أفضل", "Best"), c] as const), ...data.worst.map((c) => [L("أضعف", "Weakest"), c] as const)].map(([t, c], i) => <div key={i} className="mkt-item"><span>{t}: {c.name}</span><Chip>{c.scoreKpi === "roas" ? fmt(c.score, { unit: "x", lang }) : fmt(c.score, { unit: "pct", lang })}</Chip></div>)}{!data.best.length ? <p className="mkt-muted">{L("لا بيانات كافية.", "Not enough data.")}</p> : null}</Sec>
          <Sec title={L("المنشورات", "Posts")}>{L(`${data.posts.published.length} منشور · فشل ${data.posts.failed.length}`, `${data.posts.published.length} published · ${data.posts.failed.length} failed`)}{data.posts.failed.map((p, i) => <div key={i} className="mkt-muted">{p.post.title} · {platformName(p.platform, lang)}: {p.lastError}</div>)}</Sec>
        </div>
        {data.attribution ? <Sec title={L("الإسناد والمبيعات", "Attribution & sales")}><table className="mkt-table"><tbody>{data.attribution.byCampaign.map((c) => <tr key={c.campaignId}><td>{c.campaign?.name ?? c.campaignId}</td><td className="n">{fmt(c.revenue, { unit: "SAR", lang })}</td><td className="n">{L(`${fmt(c.orders, { lang })} طلب`, `${fmt(c.orders, { lang })} orders`)}</td></tr>)}<tr><td>{L("غير منسوب", "Unattributed")}</td><td className="n">{fmt(data.attribution.unattributed.revenue, { unit: "SAR", lang })}</td><td className="n">{L(`${data.attribution.unattributed.orders} طلب`, `${data.attribution.unattributed.orders} orders`)}</td></tr></tbody></table></Sec> : null}
        <Sec title={L("التوصيات والأولويات", "Recommendations & priorities")}>{data.decisions.length ? data.decisions.map((d, i) => <div key={i} className="mkt-item"><div><div className="t">{d.campaign}</div><div className="s">{d.reasoning}</div></div><Chip>{VERDICT_LABELS[d.verdict] ? L(VERDICT_LABELS[d.verdict].ar, VERDICT_LABELS[d.verdict].en) : d.verdict}</Chip></div>) : <p className="mkt-muted">{L("لم تُقيّم حملات في الفترة.", "No campaigns were evaluated in this period.")}</p>}</Sec>
        <Sec title={L("التنبيهات", "Alerts")}>{data.alerts.length ? data.alerts.map((a, i) => <div key={i}>• {a.title}</div>) : <p className="mkt-muted">{L("لا تنبيهات.", "No alerts.")}</p>}</Sec>
        {data.budget ? <Sec title={L("الميزانية", "Budget")}>{data.budget.lines.map((l, i) => <div key={i}>{l.scope}: {L("مخطط", "planned")} {fmt(l.planned, { unit: "SAR", lang })} · {L("فعلي", "actual")} {fmt(l.pacing.actual, { unit: "SAR", lang })}</div>)}</Sec> : null}
        <Sec title={L("رسائل واتساب", "WhatsApp messages")}>{Object.entries(data.messages).map(([k, n]) => <Chip key={k}>{k}: {n}</Chip>)}</Sec>
        <p className="mkt-muted">{L("إرسال التقارير بالبريد للمستخدمين المصرح لهم: المرحلة الثانية (يعتمد على مزود البريد المضبوط في النظام).", "Emailing reports to authorised users: phase 2 (depends on the email provider configured in the system).")}</p>
      </> : null}
    </div>
  );
}
