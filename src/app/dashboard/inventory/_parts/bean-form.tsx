"use client";
// The green-coffee lot form (add / edit), unchanged in fields and API (POST /api/green-beans, PUT /api/green-beans/:id).
// Moved out of the inventory page so the smart «إضافة صنف» flow (./add-item.tsx) mounts the same form.
import { useState } from "react";
import { Languages } from "lucide-react";
import { Btn, Field, Notice, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { useI18n } from "@/lib/i18n/context";

export type FormState = {
  serialNumber: string; beanType: string; beanTypeAr: string;
  country: string; countryAr: string; region: string; regionAr: string;
  variety: string; process: string; processAr: string;
  altitude: string; location: string; quantityKg: number;
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
  title, initial, onSave, onClose, saving, error,
}: {
  title: string;
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
          <Btn variant="primary" type="submit" form="bean-form" disabled={saving}>{saving ? t("saving") : t("save")}</Btn>
          <Btn onClick={onClose}>{t("cancel")}</Btn>
        </>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <form id="bean-form" onSubmit={handleSubmit} className="hr-form">
        <Field label={t("serialNumber")} help={L("يُولَّد تلقائيًا", "Auto-generated")}>
          <input className="hr-input hr-id" dir="ltr" value={form.serialNumber} onChange={(e) => set("serialNumber", e.target.value)} placeholder="GB-20260511-142" />
        </Field>
        <Field label={`${t("quantityKg")} *`}>
          <input className="hr-input" type="number" step="0.01" min="0" value={form.quantityKg} required
            onChange={(e) => set("quantityKg", parseFloat(e.target.value) || 0)} />
        </Field>
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
      </form>
    </Dialog>
  );
}

