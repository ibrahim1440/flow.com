"use client";
// The green-coffee lot form (add / edit), unchanged in fields and API (POST /api/green-beans, PUT /api/green-beans/:id).
// Moved out of the inventory page so the smart «إضافة صنف» flow (./add-item.tsx) mounts the same form.
import { useState } from "react";
import { Languages } from "lucide-react";
import { Btn, Field, Notice, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { useI18n } from "@/lib/i18n/context";
import { OpeningSiteField } from "./locations";

export type FormState = {
  serialNumber: string; beanType: string; beanTypeAr: string;
  country: string; countryAr: string; region: string; regionAr: string;
  variety: string; process: string; processAr: string;
  altitude: string; location: string; quantityKg: number;
  /** The sacks it came in (per-sack labels «كيس 3 من 15»): optional, as typed. */
  sackCount?: string; sackWeightKg?: string;
  /** Phase 3: where the opening quantity is received ("" / absent = the default receiving site). */
  locationId?: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function generateSerial() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.floor(Math.random() * 900 + 100);
  return `GB-${ymd}-${rand}`;
}

export function emptyForm(): FormState {
  return {
    serialNumber: generateSerial(), beanType: "", beanTypeAr: "",
    country: "", countryAr: "", region: "", regionAr: "",
    variety: "", process: "", processAr: "", altitude: "", location: "", quantityKg: 0,
  };
}

async function callTranslate(text: string, target: "ar" | "en"): Promise<string | null> {
  if (!text.trim()) return null;
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.translated ?? null;
}

// ─── BeanForm (Add / Edit) ───────────────────────────────────────────────────

export function BeanForm({
  title, initial, onSave, onClose, saving, error, hideQuantity, saveLabel, openingSite,
}: {
  /** A new lot with a starting quantity: offer «موقع الرصيد الافتتاحي» (the add flow; never the edit form). */
  openingSite?: boolean;
  title: string;
  /** The purchase invoice's «لوط جديد»: the quantity is the invoice line's, not the form's. */
  hideQuantity?: boolean;
  saveLabel?: string;
  /** A refusal of the save, shown inside the dialog (the smart add flow). */
  error?: string;
  initial: FormState;
  onSave: (f: FormState) => Promise<void>;
  onClose: () => void;
  saving: boolean;
}) {
  const { t } = useI18n();
  const L = useL();
  const [form, setForm] = useState<FormState>(initial);
  const [translating, setTranslating] = useState<Record<string, boolean>>({});

  const set = (key: keyof FormState, val: string | number) =>
    setForm((p) => ({ ...p, [key]: val }));

  async function translate(
    sourceKey: keyof FormState,
    targetKey: keyof FormState,
    targetLang: "ar" | "en",
  ) {
    const text = form[sourceKey] as string;
    if (!text.trim()) return;
    setTranslating((p) => ({ ...p, [targetKey]: true }));
    const result = await callTranslate(text, targetLang);
    setTranslating((p) => ({ ...p, [targetKey]: false }));
    if (result) set(targetKey, result);
  }

  const bilingualFields: {
    enKey: keyof FormState; arKey: keyof FormState;
    labelEn: string; labelAr: string; required?: boolean;
  }[] = [
    { enKey: "beanType", arKey: "beanTypeAr", labelEn: `${t("beanType")} (EN)`, labelAr: `${t("beanType")} (AR)`, required: true },
    { enKey: "country",  arKey: "countryAr",  labelEn: `${t("country")} (EN)`,  labelAr: `${t("country")} (AR)`,  required: true },
    { enKey: "region",   arKey: "regionAr",   labelEn: `${t("region")} (EN)`,   labelAr: `${t("region")} (AR)` },
    { enKey: "process",  arKey: "processAr",  labelEn: `${t("process")} (EN)`,  labelAr: `${t("process")} (AR)` },
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSave(form);
  }

  function TranslateBtn({ sourceKey, targetKey, targetLang }: { sourceKey: keyof FormState; targetKey: keyof FormState; targetLang: "ar" | "en" }) {
    const busy = translating[targetKey];
    const hasSource = !!(form[sourceKey] as string)?.trim();
    const label = targetLang === "ar" ? t("translateToAr") : L("ترجمة إلى الإنجليزية", "Translate to English");
    return (
      <Btn size="sm" variant="ghost" className="hr-iconbtn" title={label} aria-label={label}
        onClick={() => translate(sourceKey, targetKey, targetLang)} disabled={busy || !hasSource}>
        {busy ? "…" : <Languages size={16} />}
      </Btn>
    );
  }

  return (
    <Dialog
      open
      title={title}
      className="stk-wide"
      onClose={onClose}
      actions={
        <>
          <Btn variant="primary" type="submit" form="bean-form" disabled={saving}>{saving ? t("saving") : saveLabel ?? t("save")}</Btn>
          <Btn onClick={onClose}>{t("cancel")}</Btn>
        </>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <form id="bean-form" onSubmit={handleSubmit} className="hr-form">
        <Field label={t("serialNumber")} help={L("يُولَّد تلقائيًا", "Auto-generated")}>
          <input className="hr-input hr-id" dir="ltr" value={form.serialNumber} onChange={(e) => set("serialNumber", e.target.value)} placeholder="GB-20260511-142" />
        </Field>
        {hideQuantity ? null : (
          <Field label={`${t("quantityKg")} *`}>
            <input className="hr-input" type="number" step="0.01" min="0" value={form.quantityKg} required
              onChange={(e) => set("quantityKg", parseFloat(e.target.value) || 0)} />
          </Field>
        )}
        {openingSite && !hideQuantity ? <OpeningSiteField qty={form.quantityKg} value={form.locationId ?? ""} onChange={(v) => set("locationId", v)} /> : null}
        {bilingualFields.map(({ enKey, arKey, labelEn, labelAr, required }) => (
          <div key={enKey} style={{ display: "contents" }}>
            <Field label={`${labelEn}${required ? " *" : ""}`}>
              <span className="stk-pair">
                <input className="hr-input" dir="ltr" value={form[enKey] as string} onChange={(e) => set(enKey, e.target.value)} required={required} />
                <TranslateBtn sourceKey={arKey} targetKey={enKey} targetLang="en" />
              </span>
            </Field>
            <Field label={labelAr}>
              <span className="stk-pair">
                <input className="hr-input" dir="rtl" placeholder={L("اختياري", "Optional")} value={form[arKey] as string} onChange={(e) => set(arKey, e.target.value)} />
                <TranslateBtn sourceKey={enKey} targetKey={arKey} targetLang="ar" />
              </span>
            </Field>
          </div>
        ))}
        {([
          { key: "variety", label: t("variety") },
          { key: "altitude", label: t("altitude") },
          { key: "location", label: t("storageLocation") },
        ] as const).map(({ key, label }) => (
          <Field key={key} label={label}>
            <input className="hr-input" value={form[key] as string} onChange={(e) => set(key, e.target.value)} />
          </Field>
        ))}
        <SackFields form={form} set={set} hideQuantity={hideQuantity} />
      </form>
    </Dialog>
  );
}


/** «الأكياس»: how many sacks and the weight of one — for one numbered label per sack. Optional. */
function SackFields({ form, set, hideQuantity }: { form: FormState; set: (k: keyof FormState, v: string | number) => void; hideQuantity?: boolean }) {
  const L = useL();
  const n = Number(form.sackCount), w = Number(form.sackWeightKg);
  const total = Number.isInteger(n) && n > 0 && w > 0 ? Math.round(n * w * 1000) / 1000 : null;
  const off = total !== null && !hideQuantity && form.quantityKg > 0 && Math.abs(total - form.quantityKg) > 0.001;
  return (
    <>
      <Field label={L("عدد الأكياس", "Number of sacks")} help={L("اختياري: يُطبع ملصق مرقّم لكل كيس «كيس 3 من 15».", "Optional: one numbered label per sack, «Sack 3 of 15».")}>
        <input className="hr-input" inputMode="numeric" type="number" min={1} max={999} step={1} data-testid="bean-sack-count"
          value={form.sackCount ?? ""} onChange={(e) => set("sackCount", e.target.value)} placeholder="15" />
      </Field>
      <Field label={L("وزن الكيس · كغ", "Sack weight · kg")}
        help={total !== null ? (off ? L(`${n} × ${w} = ${total} كغ — لا يطابق الكمية ${form.quantityKg} كغ`, `${n} × ${w} = ${total} kg — not the quantity ${form.quantityKg} kg`) : L(`${n} × ${w} = ${total} كغ`, `${n} × ${w} = ${total} kg`)) : L("اختياري", "Optional")}>
        <input className="hr-input" inputMode="decimal" type="number" min={0} max={1000} step="0.01" data-testid="bean-sack-weight"
          value={form.sackWeightKg ?? ""} onChange={(e) => set("sackWeightKg", e.target.value)} placeholder="60" />
      </Field>
    </>
  );
}
