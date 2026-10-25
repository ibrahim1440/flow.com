"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, useLoad, useMkt, usePageTitle, api, fmt, fmtDate, platformName, RangePicker, useRange, Modal, Field, TextInput, Select, Alert } from "../_components/ui";
import { KPI_DICTIONARY } from "@/lib/marketing/kpi";
import { PLATFORMS } from "@/lib/marketing/platforms";

/**
 * «التحليلات والمؤشرات» — the unified performance store and the KPI dictionary. Phase 1 fills the
 * store from ad-manager exports (IMPORT) and documented manual entries (MANUAL); the platform APIs
 * (API) come in Phase 3. An empty cell stays «غير متاح».
 */

type Snap = { id: string; day: string; platform: string; level: string; externalId: string; kind: string; spend: string | null; impressions: number | null; reach: number | null; clicks: number | null; linkClicks: number | null; purchases: number | null; conversionValue: string | null; source: string; fetchedAt: string; campaign: { id: string; name: string } | null };
type K = { spend: number | null; impressions: number | null; reach: number | null; ctr: number | null; linkCtr: number | null; cpc: number | null; cpm: number | null; frequency: number | null; engagementRate: number | null; followerGrowth: number | null; videoViews: number | null; leads: number | null; purchases: number | null; platformRoas: number | null; lastUpdated: string | null; sources: string[]; partial?: string[] };

export default function AnalyticsPage() {
  const lang = useLang();
  usePageTitle("التحليلات والمؤشرات", "Analytics & KPIs", lang);
  const { can } = useMkt();
  const r = useRange(30);
  const { data, error, loading, reload } = useLoad<{ snapshots: Snap[]; paid: K; organic: K }>(`/api/marketing/metrics?${r.qs}`);
  const [entry, setEntry] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function importCsv(file: File) {
    const res = await fetch("/api/marketing/metrics/import", { method: "POST", body: await file.text(), headers: { "Content-Type": "text/csv" } });
    const b = (await res.json().catch(() => ({}))) as { error?: string; rows?: number; saved?: number; errors?: { row: number; reason: string }[] };
    if (!res.ok) return setErr(b.error ?? "");
    setMsg(`صفوف ${b.rows} · حُفظ ${b.saved}${b.errors?.length ? ` · أخطاء: ${b.errors.slice(0, 5).map((e) => `سطر ${e.row}: ${e.reason}`).join("؛ ")}` : ""}`);
    reload();
  }
  const block = (title: string, k: K | undefined) => k ? (
    <Sec title={title} caption={`المصدر: ${k.sources.join("، ") || "لا بيانات"} · آخر تحديث ${fmtDate(k.lastUpdated, true)}`}>
      <div className="mkt-grid">{([["spend", "SAR"], ["impressions", "count"], ["reach", "count"], ["frequency", "x"], ["ctr", "pct"], ["linkCtr", "pct"], ["cpc", "SAR"], ["cpm", "SAR"], ["engagementRate", "pct"], ["videoViews", "count"], ["followerGrowth", "count"], ["leads", "count"], ["purchases", "count"], ["platformRoas", "x"]] as const).map(([key, unit]) => {
        const def = KPI_DICTIONARY.find((d) => d.key === key)!;
        return <div key={key} className="mkt-kpi" title={def.formulaAr}><span className={`v ${k[key] === null ? "na" : ""}`}><bdi>{fmt(k[key], { unit })}</bdi></span><span className="l">{def.ar}</span></div>;
      })}</div>
      {k.partial?.length ? <p className="mkt-muted" data-testid="partial-note">بعض المنصات لم تُبلغ عن: {k.partial.map((f) => KPI_DICTIONARY.find((d) => d.key === f)?.ar ?? f).join("، ")}. يظهر مجموعها كما وصل، ولا تُحسب منها النسب (مثل تكلفة النقرة) حتى لا تُقسم تكلفة منصة على نقرات منصة أخرى.</p> : null}
    </Sec>
  ) : null;

  return (
    <div className="mkt" data-testid="mkt-analytics">
      <PageHeader title="التحليلات والمؤشرات" subtitle="مستودع أداء موحد؛ «عائد المنصة» هو رقم المنصة نفسها ولا يُجمع بين المنصات." actions={<>
        <RangePicker r={r} />
        {can("campaigns_manage") ? <label className="mkt-chip" style={{ cursor: "pointer" }}>استيراد تقرير CSV<input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} data-testid="import-metrics" /></label> : null}
        {can("campaigns_manage") || can("budget_manage") ? <Button variant="secondary" onClick={() => setEntry(true)} testId="manual-entry">إدخال يدوي</Button> : null}
      </>} />
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {loading && !data ? <Spinner /> : data ? <>
        {block("الإعلانات المدفوعة", data.paid)}
        {block("المحتوى العضوي", data.organic)}
        <Sec title="السجلات اليومية" caption="صف لكل يوم وعنصر ومصدر. عند تعدد المصادر لنفس العنصر يُعتمد API ثم الاستيراد ثم الإدخال اليدوي.">
          {data.snapshots.length === 0 ? <p className="mkt-muted">لا سجلات في الفترة.</p> : <div className="mkt-scroll"><table className="mkt-table" data-testid="snapshots">
            <thead><tr><th>اليوم</th><th>المنصة</th><th>المستوى</th><th>الحملة</th><th className="n">الإنفاق</th><th className="n">الظهور</th><th className="n">نقرات الرابط</th><th className="n">مشتريات (المنصة)</th><th>المصدر</th></tr></thead>
            <tbody>{data.snapshots.map((s) => <tr key={s.id}><td><bdi>{s.day.slice(0, 10)}</bdi></td><td>{platformName(s.platform)}</td><td>{s.level}{s.kind === "ORGANIC" ? " · عضوي" : ""}</td><td>{s.campaign?.name ?? <bdi>{s.externalId}</bdi>}</td><td className="n">{fmt(s.spend === null ? null : Number(s.spend), { unit: "SAR" })}</td><td className="n">{fmt(s.impressions, { unit: "count" })}</td><td className="n">{fmt(s.linkClicks, { unit: "count" })}</td><td className="n">{fmt(s.purchases, { unit: "count" })}</td><td className="mkt-muted">{s.source}</td></tr>)}</tbody>
          </table></div>}
        </Sec>
      </> : null}
      <Sec title="قاموس المؤشرات" caption="اسم كل مؤشر وتعريفه وصيغته ومصدره وقيوده." testId="kpi-dictionary">
        <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>المؤشر</th><th>الصيغة</th><th>المصدر</th><th>القيود</th></tr></thead><tbody>{KPI_DICTIONARY.map((d) => <tr key={d.key}><td><strong>{d.ar}</strong><div className="mkt-muted"><bdi>{d.en}</bdi></div></td><td>{d.formulaAr}</td><td className="mkt-muted">{d.sourceAr}</td><td className="mkt-muted">{d.caveatAr ?? "—"}</td></tr>)}</tbody></table></div>
      </Sec>
      <Sec title="صيغة ملف الاستيراد">
        <p className="mkt-muted">رؤوس الأعمدة: <bdi dir="ltr">day, platform, level, external_id, campaign, kind, spend, impressions, reach, clicks, link_clicks, landing_page_views, video_views, engagements, followers_delta, leads, purchases, conversion_value, currency</bdi>. الخانة الفارغة = غير مبلّغ، لا صفر. campaign = رمز utm_campaign.</p>
      </Sec>
      {entry ? <ManualEntry onClose={() => setEntry(false)} onDone={() => { setEntry(false); reload(); }} /> : null}
    </div>
  );
}

function ManualEntry({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const campaigns = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/campaigns");
  const [f, setF] = useState<Record<string, string>>(() => ({ day: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date(Date.now() - 86_400_000)), platform: "META_ADS", level: "CAMPAIGN", kind: "PAID", campaignId: "", externalId: "", spend: "", impressions: "", reach: "", clicks: "", linkClicks: "", purchases: "", conversionValue: "" }));
  const [err, setErr] = useState("");
  const set = (k: string) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  async function save() {
    const r = await api("/api/marketing/metrics", { method: "POST", body: { ...f, campaignId: f.campaignId || null, externalId: f.externalId || f.campaignId || "account" } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onDone();
  }
  return (
    <Modal title="إدخال أداء يدوي" onClose={onClose} wide testId="metric-form" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} testId="save-metric">حفظ</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <p className="mkt-muted">انسخ الأرقام من مدير الإعلانات كما هي. اترك الحقل فارغاً إذا لم تبلّغ المنصة عنه. يُسجل الإدخال باسمك ومصدره «يدوي».</p>
      <div className="mkt-grid-2">
        <Field id="m-d" label="اليوم"><TextInput id="m-d" type="date" value={f.day} onChange={set("day")} /></Field>
        <Field id="m-p" label="المنصة"><Select id="m-p" value={f.platform} onChange={set("platform")}>{PLATFORMS.filter((p) => p.kind === "ads" || p.kind === "social").map((p) => <option key={p.key} value={p.key}>{p.ar}</option>)}</Select></Field>
        <Field id="m-k" label="النوع"><Select id="m-k" value={f.kind} onChange={set("kind")}><option value="PAID">مدفوع</option><option value="ORGANIC">عضوي</option></Select></Field>
        <Field id="m-l" label="المستوى"><Select id="m-l" value={f.level} onChange={set("level")}><option value="CAMPAIGN">حملة</option><option value="ACCOUNT">الحساب</option><option value="POST">منشور</option></Select></Field>
        <Field id="m-c" label="الحملة"><Select id="m-c" value={f.campaignId} onChange={set("campaignId")}><option value="">—</option>{campaigns.data?.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field id="m-e" label="معرف العنصر في المنصة"><TextInput id="m-e" value={f.externalId} onChange={set("externalId")} /></Field>
        {(["spend", "impressions", "reach", "clicks", "linkClicks", "purchases", "conversionValue"] as const).map((k) => <Field key={k} id={`m-${k}`} label={{ spend: "الإنفاق", impressions: "الظهور", reach: "الوصول", clicks: "كل النقرات", linkClicks: "نقرات الرابط", purchases: "مشتريات (حسب المنصة)", conversionValue: "قيمة التحويل (حسب المنصة)" }[k]}><TextInput id={`m-${k}`} value={f[k]} onChange={set(k)} inputMode="decimal" /></Field>)}
      </div>
    </Modal>
  );
}
