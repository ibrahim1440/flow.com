"use client";

import { useState } from "react";
import { Modal, Button, Field, TextInput, Select, TextArea, Alert, api, useLoad, useLang } from "../_components/ui";
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
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
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
    if (!r.ok) return setErr(r.data.error ?? L("تعذر الحفظ.", "Could not save."));
    onSaved();
  }

  const preview = f.landingUrl && (existing?.utmCampaign || f.utmCampaign) ? buildUtmUrl(f.landingUrl, { source: "instagram", medium: "paid_social", campaign: existing?.utmCampaign ?? f.utmCampaign }) : null;

  return (
    <Modal title={existing ? L("تعديل الحملة", "Edit campaign") : L("حملة جديدة", "New campaign")} onClose={onClose} wide testId="campaign-form" footer={<><Button variant="secondary" onClick={onClose}>{L("إلغاء", "Cancel")}</Button><Button onClick={save} disabled={busy} testId="save-campaign">{L("حفظ الحملة", "Save campaign")}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <div className="mkt-grid-2">
        <Field id="c-name" label={L("اسم الحملة", "Campaign name")} required><TextInput id="c-name" value={f.name} onChange={set("name")} /></Field>
        <Field id="c-obj" label={L("الهدف", "Objective")}><Select id="c-obj" value={f.objective} onChange={set("objective")}>{Object.entries(OBJECTIVES).map(([k, v]) => <option key={k} value={k}>{lang === "ar" ? v.ar : v.en}</option>)}</Select></Field>
        <Field id="c-prod" label={L("المنتج", "Product")}><Select id="c-prod" value={f.productId} onChange={set("productId")}><option value="">{L("— بلا منتج —", "— No product —")}</option>{products.data?.rows.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        {!existing ? <Field id="c-utm" label={L("رمز التتبع utm_campaign", "Tracking code utm_campaign")} hint={L("اتركه فارغاً ليُقترح تلقائياً. حروف إنجليزية صغيرة وأرقام وشرطات.", "Leave empty to have one suggested. Lowercase English letters, digits and hyphens.")}><TextInput id="c-utm" value={f.utmCampaign} onChange={set("utmCampaign")} placeholder="ramadan-offer-202611" /></Field> : <Field id="c-utm2" label={L("رمز التتبع", "Tracking code")}><TextInput id="c-utm2" value={existing.utmCampaign} onChange={() => undefined} disabled /></Field>}
        <Field id="c-land" label={L("صفحة الهبوط", "Landing page")}><TextInput id="c-land" value={f.landingUrl} onChange={set("landingUrl")} placeholder="https://" /></Field>
        <Field id="c-budget" label={L("الميزانية المخططة (ر.س)", "Planned budget (SAR)")}><TextInput id="c-budget" value={f.plannedBudget} onChange={set("plannedBudget")} inputMode="decimal" /></Field>
        <Field id="c-start" label={L("البداية", "Start")}><TextInput id="c-start" type="date" value={f.startAt} onChange={set("startAt")} /></Field>
        <Field id="c-end" label={L("النهاية", "End")}><TextInput id="c-end" type="date" value={f.endAt} onChange={set("endAt")} /></Field>
      </div>
      <fieldset>
        <legend className="text-xs font-bold text-oo-text-secondary mb-2">{L("القنوات", "Channels")}</legend>
        <div className="mkt-toolbar">{PLATFORMS.filter((p) => p.kind === "social" || p.kind === "ads" || p.kind === "messaging").map((p) => (
          <label key={p.key} className="mkt-chip"><input type="checkbox" checked={f.channels.includes(p.key)} onChange={() => toggle(p.key)} /> {lang === "ar" ? p.ar : p.en}</label>
        ))}</div>
      </fieldset>
      <Field id="c-aud" label={L("الجمهور المستهدف", "Target audience")}><TextArea id="c-aud" value={f.audience} onChange={set("audience")} rows={2} /></Field>
      <Field id="c-offer" label={L("العرض", "Offer")}><TextArea id="c-offer" value={f.offer} onChange={set("offer")} rows={2} /></Field>
      <h3 className="font-bold text-sm">{L("أهداف الحكم على الأداء (من اقتصاديات المنتج، لا أرقام عامة)", "Performance targets (from the product's economics, not generic figures)")}</h3>
      <div className="mkt-grid-2">
        <Field id="c-cac" label={L("هدف تكلفة اكتساب العميل (CAC) · ر.س", "Target customer acquisition cost (CAC) · SAR")} hint={L("فارغ = هدف المنتج في الإعدادات.", "Empty = the product's target in settings.")}><TextInput id="c-cac" value={f.targetCac} onChange={set("targetCac")} inputMode="decimal" /></Field>
        <Field id="c-roas" label={L("هدف العائد (ROAS)", "Target ROAS")} hint={L("فارغ = نقطة التعادل من هامش المنتج.", "Empty = the break-even point from the product margin.")}><TextInput id="c-roas" value={f.targetRoas} onChange={set("targetRoas")} inputMode="decimal" /></Field>
        <Field id="c-minspend" label={L("أدنى إنفاق قبل الحكم (ر.س)", "Minimum spend before judging (SAR)")} hint={L("فارغ = ضعف هدف تكلفة الاكتساب.", "Empty = twice the target acquisition cost.")}><TextInput id="c-minspend" value={f.minSpendForDecision} onChange={set("minSpendForDecision")} inputMode="decimal" /></Field>
        <Field id="c-minconv" label={L("أدنى عدد طلبات قبل الحكم", "Minimum orders before judging")}><TextInput id="c-minconv" value={f.minConversionsForDecision} onChange={set("minConversionsForDecision")} inputMode="numeric" /></Field>
      </div>
      <Field id="c-notes" label={L("ملاحظات", "Notes")}><TextArea id="c-notes" value={f.notes} onChange={set("notes")} rows={2} /></Field>
      {preview?.ok ? <p className="mkt-muted">{L("مثال رابط متتبَّع:", "Example tracked link:")} <bdi className="break-all">{preview.url}</bdi></p> : null}
    </Modal>
  );
}
