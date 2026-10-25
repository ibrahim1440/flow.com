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

const STATUS: Record<string, { ar: string; tone?: "good" | "warn" | "bad" | "info" }> = { NO_DATA: { ar: "لا بيانات إنفاق" }, UNDER: { ar: "أبطأ من الخطة", tone: "info" }, ON_TRACK: { ar: "ضمن الخطة", tone: "good" }, OVER_PACE: { ar: "أسرع من الخطة", tone: "warn" }, EXCEEDED: { ar: "تجاوز الميزانية", tone: "bad" } };

export default function BudgetsPage() {
  const lang = useLang();
  usePageTitle("الميزانيات", "Budgets", lang);
  const { can } = useMkt();
  const now = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date()).slice(0, 7);
  const [period, setPeriod] = useState(now);
  const { data, error, loading, reload } = useLoad<Data>(`/api/marketing/budgets?period=${period}`);
  const [editing, setEditing] = useState<Line | "new" | null>(null);
  const [err, setErr] = useState("");

  async function remove(l: Line) {
    if (!confirm("حذف هذا البند؟")) return;
    const r = await api(`/api/marketing/budgets/${l.id}`, { method: "DELETE" });
    if (!r.ok) return setErr(r.data.error ?? "");
    reload();
  }
  const label = (l: Line) => (l.scope === "TOTAL" ? "الميزانية الكلية" : l.scope === "PLATFORM" ? platformName(l.scopeRef ?? "") : l.scope === "CAMPAIGN" ? `حملة: ${l.campaign?.name}` : `منتج`);

  return (
    <div className="mkt" data-testid="mkt-budgets">
      <PageHeader title="الميزانية والتحكم في الإنفاق" subtitle="لا تُنفّذ زيادة أو إيقاف تلقائياً إلا بقاعدة مفعّلة وحد أقصى معتمد مسبقاً." actions={<>
        <TextInput id="period" value={period} onChange={setPeriod} placeholder="2026-11 أو 2026-Q4" />
        {can("budget_manage") ? <Button onClick={() => setEditing("new")} testId="new-budget">بند ميزانية</Button> : null}
      </>} />
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {loading && !data ? <Spinner /> : data ? (
        <>
          <div className="mkt-toolbar">
            <Chip>إنفاق الإعلانات: {fmt(data.actual.ads, { unit: "SAR" })}</Chip>
            <Chip>تكلفة الرسائل: {fmt(data.actual.messaging, { unit: "SAR" })}</Chip>
            <Chip>الإجمالي: {fmt(data.actual.total, { unit: "SAR" })}</Chip>
            {data.allocation.total !== null ? <Chip tone={data.allocation.overAllocated ? "bad" : undefined}>موزع {fmt(data.allocation.allocated, { unit: "SAR" })} من {fmt(data.allocation.total, { unit: "SAR" })}{data.allocation.overAllocated ? " — يتجاوز الكلية" : ""}</Chip> : <Chip tone="warn">لا ميزانية كلية للفترة</Chip>}
            <span className="mkt-muted">المصدر: {data.sources.join("، ") || "—"} · آخر تحديث {fmtDate(data.lastUpdated, true)}</span>
          </div>
          <Sec title={`بنود ${data.period}`}>
            {data.lines.length === 0 ? <p className="mkt-muted">لا بنود لهذه الفترة.</p> : <div className="mkt-scroll"><table className="mkt-table" data-testid="budget-table">
              <thead><tr><th>البند</th><th className="n">المخطط</th><th className="n">الفعلي</th><th className="n">المتبقي</th><th className="n">المتوقع حتى النهاية</th><th className="n">المستخدم</th><th>الوتيرة</th><th className="n">الحد اليومي</th><th className="n">أقصى زيادة آلية</th><th /></tr></thead>
              <tbody>{data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{label(l)}{l.note ? <div className="mkt-muted">{l.note}</div> : null}</td>
                  <td className="n">{fmt(l.planned, { unit: "SAR" })}</td><td className="n">{fmt(l.pacing.actual, { unit: "SAR" })}</td><td className="n">{fmt(l.pacing.remaining, { unit: "SAR" })}</td>
                  <td className="n">{fmt(l.pacing.forecast, { unit: "SAR" })}</td><td className="n">{fmt(l.pacing.usedPct, { unit: "pct" })}</td>
                  <td><Chip tone={STATUS[l.pacing.status].tone}>{STATUS[l.pacing.status].ar}</Chip><div className="mkt-muted">يوم {l.pacing.daysElapsed} من {l.pacing.daysTotal}</div></td>
                  <td className="n">{fmt(l.dailyCap, { unit: "SAR" })}</td><td className="n">{l.maxAutoIncreasePct === null ? "غير مسموح" : fmt(l.maxAutoIncreasePct * 100, { unit: "pct" })}</td>
                  <td>{can("budget_manage") ? <span className="mkt-toolbar"><button type="button" className="mkt-chip" onClick={() => setEditing(l)}>تعديل</button><button type="button" className="mkt-chip" data-tone="bad" onClick={() => remove(l)}>حذف</button></span> : null}</td>
                </tr>
              ))}</tbody>
            </table></div>}
          </Sec>
          <p className="mkt-muted">الإنفاق حسب المنتج غير متاح من المنصات مباشرة؛ يُقاس من حملات المنتج. الزيادة التلقائية لا تُنفّذ في هذا الإصدار إلا عبر محرك القرار وبموافقة (الربط الإعلاني في المرحلة الثالثة).</p>
        </>
      ) : null}
      {editing ? <BudgetForm period={period} existing={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} /> : null}
    </div>
  );
}

function BudgetForm({ period, existing, onClose, onSaved }: { period: string; existing: Line | null; onClose: () => void; onSaved: () => void }) {
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
    <Modal title={existing ? "تعديل بند" : "بند ميزانية"} onClose={onClose} testId="budget-form" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} testId="save-budget">حفظ</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <Field id="b-p" label="الفترة"><TextInput id="b-p" value={f.period} onChange={set("period")} /></Field>
      <Field id="b-s" label="النطاق"><Select id="b-s" value={f.scope} onChange={set("scope")}><option value="TOTAL">كلية</option><option value="PLATFORM">منصة</option><option value="CAMPAIGN">حملة</option><option value="PRODUCT">منتج</option></Select></Field>
      {f.scope === "PLATFORM" ? <Field id="b-r" label="المنصة"><Select id="b-r" value={f.scopeRef} onChange={set("scopeRef")}><option value="">—</option>{PLATFORMS.filter((p) => p.kind === "ads" || p.kind === "messaging").map((p) => <option key={p.key} value={p.key}>{p.ar}</option>)}</Select></Field> : null}
      {f.scope === "PRODUCT" ? <Field id="b-pr" label="المنتج"><Select id="b-pr" value={f.scopeRef} onChange={set("scopeRef")}><option value="">—</option>{products.data?.rows.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field> : null}
      {f.scope === "CAMPAIGN" ? <Field id="b-c" label="الحملة"><Select id="b-c" value={f.campaignId} onChange={set("campaignId")}><option value="">—</option>{campaigns.data?.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field> : null}
      <Field id="b-pl" label="المبلغ المخطط (ر.س)" required><TextInput id="b-pl" value={f.planned} onChange={set("planned")} inputMode="decimal" /></Field>
      <Field id="b-d" label="الحد اليومي (ر.س)"><TextInput id="b-d" value={f.dailyCap} onChange={set("dailyCap")} inputMode="decimal" /></Field>
      <Field id="b-m" label="أقصى زيادة تلقائية في الخطوة الواحدة %" hint="فارغ = لا زيادة تلقائية أبداً."><TextInput id="b-m" value={f.maxAutoIncreasePct} onChange={set("maxAutoIncreasePct")} inputMode="decimal" /></Field>
      <Field id="b-n" label="ملاحظة"><TextInput id="b-n" value={f.note} onChange={set("note")} /></Field>
    </Modal>
  );
}
