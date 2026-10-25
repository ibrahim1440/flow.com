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
  usePageTitle("التقارير", "Reports", lang);
  const [kind, setKind] = useState<"DAILY" | "WEEKLY" | "MONTHLY">("WEEKLY");
  const [anchor, setAnchor] = useState(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date()));
  const qs = `kind=${kind}&anchor=${anchor}`;
  const { data, error, loading } = useLoad<Report>(`/api/marketing/reports?${qs}`);
  // Document printing follows PRINT_DOCUMENTS_ENABLED like every other printable page (Phase 1: off).
  const printing = usePrintDocuments();
  return (
    <div className="mkt" data-testid="mkt-reports">
      <PageHeader title="التقارير الإدارية" subtitle="اليومي: أمس · الأسبوعي: آخر 7 أيام · الشهري: الشهر الكامل السابق. بتوقيت الرياض." actions={<>
        <div className="mkt-seg" role="group">{(["DAILY", "WEEKLY", "MONTHLY"] as const).map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{{ DAILY: "يومي", WEEKLY: "أسبوعي", MONTHLY: "شهري" }[k]}</button>)}</div>
        <TextInput id="anchor" type="date" value={anchor} onChange={setAnchor} />
        <a className="mkt-chip" href={`/api/marketing/reports?${qs}&format=csv`} data-testid="csv">CSV</a>
        <a className="mkt-chip" href={`/api/marketing/reports?${qs}&format=xlsx`} data-testid="xlsx">Excel</a>
        <button type="button" className="mkt-chip" disabled={printing !== true} aria-describedby={printing === true ? undefined : PRINT_PHASE1_NOTE_ID} onClick={() => { if (printing === true) window.print(); }}>طباعة / PDF</button>
      </>} />
      {printing === false ? <PrintPhase1Notice /> : null}
      <Banner>{error}</Banner>
      {loading && !data ? <Spinner /> : data ? <>
        <p className="mkt-muted">الفترة: <bdi>{data.period.label}</bdi> ({fmtDate(data.period.from, true)} → {fmtDate(data.period.to, true)}) · أُعد {fmtDate(data.generatedAt, true)}</p>
        <Sec title="المؤشرات">
          <table className="mkt-table"><thead><tr><th>المؤشر</th><th className="n">القيمة</th><th className="n">التغير</th><th>المصدر</th></tr></thead><tbody>{Object.entries(data.figures).map(([k, f]) => { const d = KPI[f.kpi as KpiKey]; return <tr key={k}><td>{d?.ar ?? k}</td><td className="n">{fmt(f.value, { unit: d?.unit })}</td><td className="n">{f.changePct === null ? "—" : `${f.changePct}%`}</td><td className="mkt-muted">{f.source}</td></tr>; })}</tbody></table>
        </Sec>
        <div className="mkt-grid-2">
          <Sec title="المنصات">{data.platforms.length ? <table className="mkt-table"><tbody>{data.platforms.map((p) => <tr key={p.platform}><td>{platformName(p.platform)}</td><td className="n">{fmt(p.spend, { unit: "SAR" })}</td><td className="n">CTR {fmt(p.ctr, { unit: "pct" })}</td></tr>)}</tbody></table> : <p className="mkt-muted">لا بيانات.</p>}</Sec>
          <Sec title="المحتوى حسب المنصة">{data.contentByPlatform.length ? <table className="mkt-table"><tbody>{data.contentByPlatform.map((p) => <tr key={p.platform}><td>{platformName(p.platform)}</td><td className="n">وصول {fmt(p.reach, { unit: "count" })}</td><td className="n">تفاعل {fmt(p.engagements, { unit: "count" })}</td></tr>)}</tbody></table> : <p className="mkt-muted">لا بيانات.</p>}</Sec>
          <Sec title="أفضل وأضعف الحملات">{[...data.best.map((c) => ["أفضل", c] as const), ...data.worst.map((c) => ["أضعف", c] as const)].map(([t, c], i) => <div key={i} className="mkt-item"><span>{t}: {c.name}</span><Chip>{c.scoreKpi === "roas" ? fmt(c.score, { unit: "x" }) : fmt(c.score, { unit: "pct" })}</Chip></div>)}{!data.best.length ? <p className="mkt-muted">لا بيانات كافية.</p> : null}</Sec>
          <Sec title="المنشورات">{data.posts.published.length} منشور · فشل {data.posts.failed.length}{data.posts.failed.map((p, i) => <div key={i} className="mkt-muted">{p.post.title} · {platformName(p.platform)}: {p.lastError}</div>)}</Sec>
        </div>
        {data.attribution ? <Sec title="الإسناد والمبيعات"><table className="mkt-table"><tbody>{data.attribution.byCampaign.map((c) => <tr key={c.campaignId}><td>{c.campaign?.name ?? c.campaignId}</td><td className="n">{fmt(c.revenue, { unit: "SAR" })}</td><td className="n">{fmt(c.orders)} طلب</td></tr>)}<tr><td>غير منسوب</td><td className="n">{fmt(data.attribution.unattributed.revenue, { unit: "SAR" })}</td><td className="n">{data.attribution.unattributed.orders} طلب</td></tr></tbody></table></Sec> : null}
        <Sec title="التوصيات والأولويات">{data.decisions.length ? data.decisions.map((d, i) => <div key={i} className="mkt-item"><div><div className="t">{d.campaign}</div><div className="s">{d.reasoning}</div></div><Chip>{VERDICT_LABELS[d.verdict]?.ar}</Chip></div>) : <p className="mkt-muted">لم تُقيّم حملات في الفترة.</p>}</Sec>
        <Sec title="التنبيهات">{data.alerts.length ? data.alerts.map((a, i) => <div key={i}>• {a.title}</div>) : <p className="mkt-muted">لا تنبيهات.</p>}</Sec>
        {data.budget ? <Sec title="الميزانية">{data.budget.lines.map((l, i) => <div key={i}>{l.scope}: مخطط {fmt(l.planned, { unit: "SAR" })} · فعلي {fmt(l.pacing.actual, { unit: "SAR" })}</div>)}</Sec> : null}
        <Sec title="رسائل واتساب">{Object.entries(data.messages).map(([k, n]) => <Chip key={k}>{k}: {n}</Chip>)}</Sec>
        <p className="mkt-muted">إرسال التقارير بالبريد للمستخدمين المصرح لهم: المرحلة الثانية (يعتمد على مزود البريد المضبوط في النظام).</p>
      </> : null}
    </div>
  );
}
