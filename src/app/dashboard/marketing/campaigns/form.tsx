"use client";

import { useState } from "react";
import { Modal, Button, Field, TextInput, Select, TextArea, Alert, api, useLoad } from "../_components/ui";
import { OBJECTIVES } from "../_components/ui";
import { PLATFORMS } from "@/lib/marketing/platforms";
import { buildUtmUrl } from "@/lib/marketing/utm";

export type CampaignRow = {
  id: string; name: string; objective: string; status: string; channels: string[]; productId: string | null; product: { id: string; name: string } | null;
  audience: string | null; offer: string | null; landingUrl: string | null; utmCampaign: string; startAt: string | null; endAt: string | null;
  plannedBudget: number | null; targetCac: number | null; targetRoas: number | null; minSpendForDecision: number | null; minConversionsForDecision: number | null; notes: string | null;
};

const day = (d: string | null) => (d ? d.slice(0, 10) : "");

export function CampaignForm({ existing, onClose, onSaved }: { existing: CampaignRow | null; onClose: () => void; onSaved: () => void }) {
  const products = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/products");
  const [f, setF] = useState({
    name: existing?.name ?? "", objective: existing?.objective ?? "SALES", channels: existing?.channels ?? [], productId: existing?.productId ?? "",
    audience: existing?.audience ?? "", offer: existing?.offer ?? "", landingUrl: existing?.landingUrl ?? "", utmCampaign: existing?.utmCampaign ?? "",
    startAt: day(existing?.startAt ?? null), endAt: day(existing?.endAt ?? null), plannedBudget: existing?.plannedBudget?.toString() ?? "",
    targetCac: existing?.targetCac?.toString() ?? "", targetRoas: existing?.targetRoas?.toString() ?? "", minSpendForDecision: existing?.minSpendForDecision?.toString() ?? "",
    minConversionsForDecision: existing?.minConversionsForDecision?.toString() ?? "", notes: existing?.notes ?? "",
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const toggle = (ch: string) => setF((s) => ({ ...s, channels: s.channels.includes(ch) ? s.channels.filter((c) => c !== ch) : [...s.channels, ch] }));

  async function save() {
    setBusy(true);
    setErr("");
    const body = {
      ...f, productId: f.productId || null, startAt: f.startAt ? `${f.startAt}T00:00:00+03:00` : null, endAt: f.endAt ? `${f.endAt}T23:59:59+03:00` : null,
      utmCampaign: existing ? undefined : f.utmCampaign || undefined,
    };
    const r = await api(existing ? `/api/marketing/campaigns/${existing.id}` : "/api/marketing/campaigns", { method: existing ? "PATCH" : "POST", body });
    setBusy(false);
    if (!r.ok) return setErr(r.data.error ?? "تعذر الحفظ.");
    onSaved();
  }

  const preview = f.landingUrl && (existing?.utmCampaign || f.utmCampaign) ? buildUtmUrl(f.landingUrl, { source: "instagram", medium: "paid_social", campaign: existing?.utmCampaign ?? f.utmCampaign }) : null;

  return (
    <Modal title={existing ? "تعديل الحملة" : "حملة جديدة"} onClose={onClose} wide testId="campaign-form" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} disabled={busy} testId="save-campaign">حفظ الحملة</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <div className="mkt-grid-2">
        <Field id="c-name" label="اسم الحملة" required><TextInput id="c-name" value={f.name} onChange={set("name")} /></Field>
        <Field id="c-obj" label="الهدف"><Select id="c-obj" value={f.objective} onChange={set("objective")}>{Object.entries(OBJECTIVES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field id="c-prod" label="المنتج"><Select id="c-prod" value={f.productId} onChange={set("productId")}><option value="">— بلا منتج —</option>{products.data?.rows.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        {!existing ? <Field id="c-utm" label="رمز التتبع utm_campaign" hint="اتركه فارغاً ليُقترح تلقائياً. حروف إنجليزية صغيرة وأرقام وشرطات."><TextInput id="c-utm" value={f.utmCampaign} onChange={set("utmCampaign")} placeholder="ramadan-offer-202611" /></Field> : <Field id="c-utm2" label="رمز التتبع"><TextInput id="c-utm2" value={existing.utmCampaign} onChange={() => undefined} disabled /></Field>}
        <Field id="c-land" label="صفحة الهبوط"><TextInput id="c-land" value={f.landingUrl} onChange={set("landingUrl")} placeholder="https://" /></Field>
        <Field id="c-budget" label="الميزانية المخططة (ر.س)"><TextInput id="c-budget" value={f.plannedBudget} onChange={set("plannedBudget")} inputMode="decimal" /></Field>
        <Field id="c-start" label="البداية"><TextInput id="c-start" type="date" value={f.startAt} onChange={set("startAt")} /></Field>
        <Field id="c-end" label="النهاية"><TextInput id="c-end" type="date" value={f.endAt} onChange={set("endAt")} /></Field>
      </div>
      <fieldset>
        <legend className="text-xs font-bold text-oo-text-secondary mb-2">القنوات</legend>
        <div className="mkt-toolbar">{PLATFORMS.filter((p) => p.kind === "social" || p.kind === "ads" || p.kind === "messaging").map((p) => (
          <label key={p.key} className="mkt-chip"><input type="checkbox" checked={f.channels.includes(p.key)} onChange={() => toggle(p.key)} /> {p.ar}</label>
        ))}</div>
      </fieldset>
      <Field id="c-aud" label="الجمهور المستهدف"><TextArea id="c-aud" value={f.audience} onChange={set("audience")} rows={2} /></Field>
      <Field id="c-offer" label="العرض"><TextArea id="c-offer" value={f.offer} onChange={set("offer")} rows={2} /></Field>
      <h3 className="font-bold text-sm">أهداف الحكم على الأداء (من اقتصاديات المنتج، لا أرقام عامة)</h3>
      <div className="mkt-grid-2">
        <Field id="c-cac" label="هدف تكلفة اكتساب العميل (ر.س)" hint="فارغ = هدف المنتج في الإعدادات."><TextInput id="c-cac" value={f.targetCac} onChange={set("targetCac")} inputMode="decimal" /></Field>
        <Field id="c-roas" label="هدف العائد ROAS" hint="فارغ = نقطة التعادل من هامش المنتج."><TextInput id="c-roas" value={f.targetRoas} onChange={set("targetRoas")} inputMode="decimal" /></Field>
        <Field id="c-minspend" label="أدنى إنفاق قبل الحكم (ر.س)" hint="فارغ = ضعف هدف تكلفة الاكتساب."><TextInput id="c-minspend" value={f.minSpendForDecision} onChange={set("minSpendForDecision")} inputMode="decimal" /></Field>
        <Field id="c-minconv" label="أدنى عدد طلبات قبل الحكم"><TextInput id="c-minconv" value={f.minConversionsForDecision} onChange={set("minConversionsForDecision")} inputMode="numeric" /></Field>
      </div>
      <Field id="c-notes" label="ملاحظات"><TextArea id="c-notes" value={f.notes} onChange={set("notes")} rows={2} /></Field>
      {preview?.ok ? <p className="mkt-muted">مثال رابط متتبَّع: <bdi className="break-all">{preview.url}</bdi></p> : null}
    </Modal>
  );
}
