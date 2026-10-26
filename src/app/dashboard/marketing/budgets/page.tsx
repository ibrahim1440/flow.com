"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, useLoad, useMkt, usePageTitle, api, fmt, fmtDate, platformName, Modal, Field, TextInput, Select, Alert } from "../_components/ui";
import { PLATFORMS } from "@/lib/marketing/platforms";

/**
 * «الميزانيات» — planned vs actual, remaining, the forecast at the current run rate, daily caps and
 * the ceiling for any automatic increase. Actual spend is what the platforms (or a documented manual
 * entry) reported, plus WhatsApp costs billed — a line with no reported spend shows «غير متاح».
 */

type Line = { id: string; scope: string; scopeRef: string | null; campaign: { id: string; name: string } | null; planned: number; dailyCap: number | null; maxAutoIncreasePct: number | null; note: string | null; pacing: { actual: number | null; remaining: number | null; forecast: number | null; forecastVariance: number | null; usedPct: number | null; expectedToDate: number; daysElapsed: number; daysTotal: number; status: string } };
type Data = { period: string; lines: Line[]; actual: { ads: number | null; messaging: number | null; total: number | null }; lastUpdated: string | null; sources: string[]; allocation: { total: number | null; allocated: number; unallocated: number | null; overAllocated: boolean } };

const STATUS: Record<string, { ar: string; en: string; tone?: "good" | "warn" | "bad" | "info" }> = { NO_DATA: { ar: "لا بيانات إنفاق", en: "No spend data" }, UNDER: { ar: "أبطأ من الخطة", en: "Behind plan", tone: "info" }, ON_TRACK: { ar: "ضمن الخطة", en: "On track", tone: "good" }, OVER_PACE: { ar: "أسرع من الخطة", en: "Ahead of plan", tone: "warn" }, EXCEEDED: { ar: "تجاوز الميزانية", en: "Over budget", tone: "bad" } };

export default function BudgetsPage() {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  usePageTitle("الميزانيات", "Budgets", lang);
  const { can } = useMkt();
  const now = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date()).slice(0, 7);
  const [period, setPeriod] = useState(now);
  const { data, error, loading, reload } = useLoad<Data>(`/api/marketing/budgets?period=${period}`);
  const [editing, setEditing] = useState<Line | "new" | null>(null);
  const [err, setErr] = useState("");

  async function remove(l: Line) {
    if (!confirm(L("حذف هذا البند؟", "Delete this line?"))) return;
    const r = await api(`/api/marketing/budgets/${l.id}`, { method: "DELETE" });
    if (!r.ok) return setErr(r.data.error ?? "");
    reload();
  }
  const label = (l: Line) => (l.scope === "TOTAL" ? L("الميزانية الكلية", "Total budget") : l.scope === "PLATFORM" ? platformName(l.scopeRef ?? "", lang) : l.scope === "CAMPAIGN" ? L(`حملة: ${l.campaign?.name}`, `Campaign: ${l.campaign?.name}`) : L("منتج", "Product"));

  return (
    <div className="mkt" data-testid="mkt-budgets">
      <PageHeader title={L("الميزانية والتحكم في الإنفاق", "Budget & spend control")} subtitle={L("لا تُنفّذ زيادة أو إيقاف تلقائياً إلا بقاعدة مفعّلة وحد أقصى معتمد مسبقاً.", "No automatic increase or pause runs without an active rule and a pre-approved ceiling.")} actions={<>
        <TextInput id="period" value={period} onChange={setPeriod} placeholder={L("2026-11 أو 2026-Q4", "2026-11 or 2026-Q4")} />
        {can("budget_manage") ? <Button onClick={() => setEditing("new")} testId="new-budget">{L("بند ميزانية", "Budget line")}</Button> : null}
      </>} />
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {loading && !data ? <Spinner /> : data ? (
        <>
          <div className="mkt-toolbar">
            <Chip>{L("إنفاق الإعلانات:", "Ad spend:")} {fmt(data.actual.ads, { unit: "SAR", lang })}</Chip>
            <Chip>{L("تكلفة الرسائل:", "Messaging cost:")} {fmt(data.actual.messaging, { unit: "SAR", lang })}</Chip>
            <Chip>{L("الإجمالي:", "Total:")} {fmt(data.actual.total, { unit: "SAR", lang })}</Chip>
            {data.allocation.total !== null ? <Chip tone={data.allocation.overAllocated ? "bad" : undefined}>{L(`موزع ${fmt(data.allocation.allocated, { unit: "SAR", lang })} من ${fmt(data.allocation.total, { unit: "SAR", lang })}`, `Allocated ${fmt(data.allocation.allocated, { unit: "SAR", lang })} of ${fmt(data.allocation.total, { unit: "SAR", lang })}`)}{data.allocation.overAllocated ? L(" — يتجاوز الكلية", " — exceeds the total") : ""}</Chip> : <Chip tone="warn">{L("لا ميزانية كلية للفترة", "No total budget for the period")}</Chip>}
            <span className="mkt-muted">{L("المصدر:", "Source:")} {data.sources.join(L("، ", ", ")) || "—"} · {L("آخر تحديث", "Updated")} {fmtDate(data.lastUpdated, true)}</span>
          </div>
          <Sec title={L(`بنود ${data.period}`, `Lines for ${data.period}`)}>
            {data.lines.length === 0 ? <p className="mkt-muted">{L("لا بنود لهذه الفترة.", "No lines for this period.")}</p> : <div className="mkt-scroll"><table className="mkt-table" data-testid="budget-table">
              <thead><tr><th>{L("البند", "Line")}</th><th className="n">{L("المخطط", "Planned")}</th><th className="n">{L("الفعلي", "Actual")}</th><th className="n">{L("المتبقي", "Remaining")}</th><th className="n">{L("المتوقع حتى النهاية", "Forecast to end")}</th><th className="n">{L("المستخدم", "Used")}</th><th>{L("الوتيرة", "Pace")}</th><th className="n">{L("الحد اليومي", "Daily cap")}</th><th className="n">{L("أقصى زيادة آلية", "Max automatic increase")}</th><th /></tr></thead>
              <tbody>{data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{label(l)}{l.note ? <div className="mkt-muted">{l.note}</div> : null}</td>
                  <td className="n">{fmt(l.planned, { unit: "SAR" })}</td><td className="n">{fmt(l.pacing.actual, { unit: "SAR" })}</td><td className="n">{fmt(l.pacing.remaining, { unit: "SAR" })}</td>
                  <td className="n">{fmt(l.pacing.forecast, { unit: "SAR" })}</td><td className="n">{fmt(l.pacing.usedPct, { unit: "pct" })}</td>
                  <td><Chip tone={STATUS[l.pacing.status].tone}>{L(STATUS[l.pacing.status].ar, STATUS[l.pacing.status].en)}</Chip><div className="mkt-muted">{L(`يوم ${l.pacing.daysElapsed} من ${l.pacing.daysTotal}`, `Day ${l.pacing.daysElapsed} of ${l.pacing.daysTotal}`)}</div></td>
                  <td className="n">{fmt(l.dailyCap, { unit: "SAR" })}</td><td className="n">{l.maxAutoIncreasePct === null ? L("غير مسموح", "Not allowed") : fmt(l.maxAutoIncreasePct * 100, { unit: "pct" })}</td>
                  <td>{can("budget_manage") ? <span className="mkt-toolbar"><button type="button" className="mkt-chip" onClick={() => setEditing(l)}>{L("تعديل", "Edit")}</button><button type="button" className="mkt-chip" data-tone="bad" onClick={() => remove(l)}>{L("حذف", "Delete")}</button></span> : null}</td>
                </tr>
              ))}</tbody>
            </table></div>}
          </Sec>
          <p className="mkt-muted">{L("الإنفاق حسب المنتج غير متاح من المنصات مباشرة؛ يُقاس من حملات المنتج. الزيادة التلقائية لا تُنفّذ في هذا الإصدار إلا عبر محرك القرار وبموافقة (الربط الإعلاني في المرحلة الثالثة).", "Spend per product is not available from the platforms directly; it is measured from the product's campaigns. In this release an automatic increase runs only through the decision engine and with an approval (ad-account integration comes in phase 3).")}</p>
        </>
      ) : null}
      {editing ? <BudgetForm period={period} existing={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} /> : null}
    </div>
  );
}

function BudgetForm({ period, existing, onClose, onSaved }: { period: string; existing: Line | null; onClose: () => void; onSaved: () => void }) {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const campaigns = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/campaigns");
  const products = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/products");
  const [f, setF] = useState({ period, scope: existing?.scope ?? "TOTAL", scopeRef: existing?.scopeRef ?? "", campaignId: existing?.campaign?.id ?? "", planned: existing?.planned?.toString() ?? "", dailyCap: existing?.dailyCap?.toString() ?? "", maxAutoIncreasePct: existing?.maxAutoIncreasePct !== null && existing?.maxAutoIncreasePct !== undefined ? String(existing.maxAutoIncreasePct * 100) : "", note: existing?.note ?? "" });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  async function save() {
    const r = await api(existing ? `/api/marketing/budgets/${existing.id}` : "/api/marketing/budgets", { method: existing ? "PATCH" : "POST", body: { ...f, scopeRef: f.scopeRef || null, campaignId: f.campaignId || null } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onSaved();
  }
  return (
    <Modal title={existing ? L("تعديل بند", "Edit line") : L("بند ميزانية", "Budget line")} onClose={onClose} testId="budget-form" footer={<><Button variant="secondary" onClick={onClose}>{L("إلغاء", "Cancel")}</Button><Button onClick={save} testId="save-budget">{L("حفظ", "Save")}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <Field id="b-p" label={L("الفترة", "Period")}><TextInput id="b-p" value={f.period} onChange={set("period")} /></Field>
      <Field id="b-s" label={L("النطاق", "Scope")}><Select id="b-s" value={f.scope} onChange={set("scope")}><option value="TOTAL">{L("كلية", "Total")}</option><option value="PLATFORM">{L("منصة", "Platform")}</option><option value="CAMPAIGN">{L("حملة", "Campaign")}</option><option value="PRODUCT">{L("منتج", "Product")}</option></Select></Field>
      {f.scope === "PLATFORM" ? <Field id="b-r" label={L("المنصة", "Platform")}><Select id="b-r" value={f.scopeRef} onChange={set("scopeRef")}><option value="">—</option>{PLATFORMS.filter((p) => p.kind === "ads" || p.kind === "messaging").map((p) => <option key={p.key} value={p.key}>{L(p.ar, p.en)}</option>)}</Select></Field> : null}
      {f.scope === "PRODUCT" ? <Field id="b-pr" label={L("المنتج", "Product")}><Select id="b-pr" value={f.scopeRef} onChange={set("scopeRef")}><option value="">—</option>{products.data?.rows.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field> : null}
      {f.scope === "CAMPAIGN" ? <Field id="b-c" label={L("الحملة", "Campaign")}><Select id="b-c" value={f.campaignId} onChange={set("campaignId")}><option value="">—</option>{campaigns.data?.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field> : null}
      <Field id="b-pl" label={L("المبلغ المخطط (ر.س)", "Planned amount (SAR)")} required><TextInput id="b-pl" value={f.planned} onChange={set("planned")} inputMode="decimal" /></Field>
      <Field id="b-d" label={L("الحد اليومي (ر.س)", "Daily cap (SAR)")}><TextInput id="b-d" value={f.dailyCap} onChange={set("dailyCap")} inputMode="decimal" /></Field>
      <Field id="b-m" label={L("أقصى زيادة تلقائية في الخطوة الواحدة %", "Max automatic increase per step %")} hint={L("فارغ = لا زيادة تلقائية أبداً.", "Empty = never increase automatically.")}><TextInput id="b-m" value={f.maxAutoIncreasePct} onChange={set("maxAutoIncreasePct")} inputMode="decimal" /></Field>
      <Field id="b-n" label={L("ملاحظة", "Note")}><TextInput id="b-n" value={f.note} onChange={set("note")} /></Field>
    </Modal>
  );
}
