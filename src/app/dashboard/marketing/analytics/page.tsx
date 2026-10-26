"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, useLoad, useMkt, usePageTitle, api, fmt, fmtDate, platformName, RangePicker, useRange, Modal, Field, TextInput, Select, Alert } from "../_components/ui";
import { KPI_DICTIONARY } from "@/lib/marketing/kpi";
import { PLATFORMS } from "@/lib/marketing/platforms";
import { localizeApiError } from "@/lib/i18n/api-errors";

/**
 * «التحليلات والمؤشرات» — the unified performance store and the KPI dictionary. Phase 1 fills the
 * store from ad-manager exports (IMPORT) and documented manual entries (MANUAL); the platform APIs
 * (API) come in Phase 3. An empty cell stays «غير متاح».
 */

type Snap = { id: string; day: string; platform: string; level: string; externalId: string; kind: string; spend: string | null; impressions: number | null; reach: number | null; clicks: number | null; linkClicks: number | null; purchases: number | null; conversionValue: string | null; source: string; fetchedAt: string; campaign: { id: string; name: string } | null };
type K = { spend: number | null; impressions: number | null; reach: number | null; ctr: number | null; linkCtr: number | null; cpc: number | null; cpm: number | null; frequency: number | null; engagementRate: number | null; followerGrowth: number | null; videoViews: number | null; leads: number | null; purchases: number | null; platformRoas: number | null; lastUpdated: string | null; sources: string[]; partial?: string[] };

export default function AnalyticsPage() {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
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
    if (!res.ok) return setErr(localizeApiError(b, lang) ?? "");
    setMsg(L(`صفوف ${b.rows} · حُفظ ${b.saved}${b.errors?.length ? ` · أخطاء: ${b.errors.slice(0, 5).map((e) => `سطر ${e.row}: ${e.reason}`).join("؛ ")}` : ""}`,
      `Rows ${b.rows} · saved ${b.saved}${b.errors?.length ? ` · errors: ${b.errors.slice(0, 5).map((e) => `row ${e.row}: ${e.reason}`).join("; ")}` : ""}`));
    reload();
  }
  const block = (title: string, k: K | undefined) => k ? (
    <Sec title={title} caption={L(`المصدر: ${k.sources.join("، ") || "لا بيانات"} · آخر تحديث ${fmtDate(k.lastUpdated, true)}`, `Source: ${k.sources.join(", ") || "no data"} · updated ${fmtDate(k.lastUpdated, true)}`)}>
      <div className="mkt-grid">{([["spend", "SAR"], ["impressions", "count"], ["reach", "count"], ["frequency", "x"], ["ctr", "pct"], ["linkCtr", "pct"], ["cpc", "SAR"], ["cpm", "SAR"], ["engagementRate", "pct"], ["videoViews", "count"], ["followerGrowth", "count"], ["leads", "count"], ["purchases", "count"], ["platformRoas", "x"]] as const).map(([key, unit]) => {
        const def = KPI_DICTIONARY.find((d) => d.key === key)!;
        return <div key={key} className="mkt-kpi" title={L(def.formulaAr, def.formulaEn)}><span className={`v ${k[key] === null ? "na" : ""}`}><bdi>{fmt(k[key], { unit, lang })}</bdi></span><span className="l">{L(def.ar, def.en)}</span></div>;
      })}</div>
      {k.partial?.length ? <p className="mkt-muted" data-testid="partial-note">{(() => { const names = k.partial.map((f) => { const d = KPI_DICTIONARY.find((x) => x.key === f); return d ? L(d.ar, d.en) : f; }).join(L("، ", ", ")); return L(`بعض المنصات لم تُبلغ عن: ${names}. يظهر مجموعها كما وصل، ولا تُحسب منها النسب (مثل تكلفة النقرة) حتى لا تُقسم تكلفة منصة على نقرات منصة أخرى.`, `Some platforms did not report: ${names}. Their total shows as it arrived, and no ratio (such as cost per click) is computed from it, so one platform's cost is never divided by another platform's clicks.`); })()}</p> : null}
    </Sec>
  ) : null;

  return (
    <div className="mkt" data-testid="mkt-analytics">
      <PageHeader title={L("التحليلات والمؤشرات", "Analytics & KPIs")} subtitle={L("مستودع أداء موحد؛ «عائد المنصة (Platform ROAS)» هو رقم المنصة نفسها ولا يُجمع بين المنصات.", "One performance store; “Platform ROAS” is the platform's own figure and is never summed across platforms.")} actions={<>
        <RangePicker r={r} />
        {can("campaigns_manage") ? <label className="mkt-chip" style={{ cursor: "pointer" }}>{L("استيراد تقرير CSV", "Import CSV report")}<input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} data-testid="import-metrics" /></label> : null}
        {can("campaigns_manage") || can("budget_manage") ? <Button variant="secondary" onClick={() => setEntry(true)} testId="manual-entry">{L("إدخال يدوي", "Manual entry")}</Button> : null}
      </>} />
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {loading && !data ? <Spinner /> : data ? <>
        {block(L("الإعلانات المدفوعة", "Paid ads"), data.paid)}
        {block(L("المحتوى العضوي", "Organic content"), data.organic)}
        <Sec title={L("السجلات اليومية", "Daily records")} caption={L("صف لكل يوم وعنصر ومصدر. عند تعدد المصادر لنفس العنصر يُعتمد API ثم الاستيراد ثم الإدخال اليدوي.", "One row per day, item and source. When one item has several sources, API wins, then import, then manual entry.")}>
          {data.snapshots.length === 0 ? <p className="mkt-muted">{L("لا سجلات في الفترة.", "No records in this period.")}</p> : <div className="mkt-scroll"><table className="mkt-table" data-testid="snapshots">
            <thead><tr><th>{L("اليوم", "Day")}</th><th>{L("المنصة", "Platform")}</th><th>{L("المستوى", "Level")}</th><th>{L("الحملة", "Campaign")}</th><th className="n">{L("الإنفاق", "Spend")}</th><th className="n">{L("الظهور", "Impressions")}</th><th className="n">{L("نقرات الرابط", "Link clicks")}</th><th className="n">{L("مشتريات (المنصة)", "Purchases (platform)")}</th><th>{L("المصدر", "Source")}</th></tr></thead>
            <tbody>{data.snapshots.map((s) => <tr key={s.id}><td><bdi>{s.day.slice(0, 10)}</bdi></td><td>{platformName(s.platform)}</td><td>{s.level}{s.kind === "ORGANIC" ? L(" · عضوي", " · organic") : ""}</td><td>{s.campaign?.name ?? <bdi>{s.externalId}</bdi>}</td><td className="n">{fmt(s.spend === null ? null : Number(s.spend), { unit: "SAR" })}</td><td className="n">{fmt(s.impressions, { unit: "count" })}</td><td className="n">{fmt(s.linkClicks, { unit: "count" })}</td><td className="n">{fmt(s.purchases, { unit: "count" })}</td><td className="mkt-muted">{s.source}</td></tr>)}</tbody>
          </table></div>}
        </Sec>
      </> : null}
      <Sec title={L("قاموس المؤشرات", "KPI dictionary")} caption={L("اسم كل مؤشر وتعريفه وصيغته ومصدره وقيوده.", "Each KPI's name, definition, formula, source and limits.")} testId="kpi-dictionary">
        <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>{L("المؤشر", "KPI")}</th><th>{L("الصيغة", "Formula")}</th><th>{L("المصدر", "Source")}</th><th>{L("القيود", "Limits")}</th></tr></thead><tbody>{KPI_DICTIONARY.map((d) => <tr key={d.key}><td><strong>{L(d.ar, d.en)}</strong></td><td>{L(d.formulaAr, d.formulaEn)}</td><td className="mkt-muted">{L(d.sourceAr, d.sourceEn)}</td><td className="mkt-muted">{(lang === "ar" ? d.caveatAr : d.caveatEn) ?? "—"}</td></tr>)}</tbody></table></div>
      </Sec>
      <Sec title={L("صيغة ملف الاستيراد", "Import file format")}>
        <p className="mkt-muted">{L("رؤوس الأعمدة:", "Column headers:")} <bdi dir="ltr">day, platform, level, external_id, campaign, kind, spend, impressions, reach, clicks, link_clicks, landing_page_views, video_views, engagements, followers_delta, leads, purchases, conversion_value, currency</bdi>. {L("الخانة الفارغة = غير مبلّغ، لا صفر. campaign = رمز utm_campaign.", "An empty cell = not reported, not zero. campaign = the utm_campaign code.")}</p>
      </Sec>
      {entry ? <ManualEntry onClose={() => setEntry(false)} onDone={() => { setEntry(false); reload(); }} /> : null}
    </div>
  );
}

function ManualEntry({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
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
    <Modal title={L("إدخال أداء يدوي", "Manual performance entry")} onClose={onClose} wide testId="metric-form" footer={<><Button variant="secondary" onClick={onClose}>{L("إلغاء", "Cancel")}</Button><Button onClick={save} testId="save-metric">{L("حفظ", "Save")}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <p className="mkt-muted">{L("انسخ الأرقام من مدير الإعلانات كما هي. اترك الحقل فارغاً إذا لم تبلّغ المنصة عنه. يُسجل الإدخال باسمك ومصدره «يدوي».", "Copy the figures from the ads manager as they are. Leave a field empty if the platform did not report it. The entry is recorded under your name with the source “manual”.")}</p>
      <div className="mkt-grid-2">
        <Field id="m-d" label={L("اليوم", "Day")}><TextInput id="m-d" type="date" value={f.day} onChange={set("day")} /></Field>
        <Field id="m-p" label={L("المنصة", "Platform")}><Select id="m-p" value={f.platform} onChange={set("platform")}>{PLATFORMS.filter((p) => p.kind === "ads" || p.kind === "social").map((p) => <option key={p.key} value={p.key}>{L(p.ar, p.en)}</option>)}</Select></Field>
        <Field id="m-k" label={L("النوع", "Type")}><Select id="m-k" value={f.kind} onChange={set("kind")}><option value="PAID">{L("مدفوع", "Paid")}</option><option value="ORGANIC">{L("عضوي", "Organic")}</option></Select></Field>
        <Field id="m-l" label={L("المستوى", "Level")}><Select id="m-l" value={f.level} onChange={set("level")}><option value="CAMPAIGN">{L("حملة", "Campaign")}</option><option value="ACCOUNT">{L("الحساب", "Account")}</option><option value="POST">{L("منشور", "Post")}</option></Select></Field>
        <Field id="m-c" label={L("الحملة", "Campaign")}><Select id="m-c" value={f.campaignId} onChange={set("campaignId")}><option value="">—</option>{campaigns.data?.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field id="m-e" label={L("معرف العنصر في المنصة", "Item ID on the platform")}><TextInput id="m-e" value={f.externalId} onChange={set("externalId")} /></Field>
        {(["spend", "impressions", "reach", "clicks", "linkClicks", "purchases", "conversionValue"] as const).map((k) => <Field key={k} id={`m-${k}`} label={(lang === "ar" ? { spend: "الإنفاق", impressions: "الظهور", reach: "الوصول", clicks: "كل النقرات", linkClicks: "نقرات الرابط", purchases: "مشتريات (حسب المنصة)", conversionValue: "قيمة التحويل (حسب المنصة)" } : { spend: "Spend", impressions: "Impressions", reach: "Reach", clicks: "All clicks", linkClicks: "Link clicks", purchases: "Purchases (per platform)", conversionValue: "Conversion value (per platform)" })[k]}><TextInput id={`m-${k}`} value={f[k]} onChange={set(k)} inputMode="decimal" /></Field>)}
      </div>
    </Modal>
  );
}
