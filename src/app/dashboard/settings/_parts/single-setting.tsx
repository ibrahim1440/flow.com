"use client";
// One stored figure with its built-in default (Settings › Inventory, Settings › Invoicing & tax):
// the input, «حفظ», «الافتراضي» (clears it back to the built-in value), the unsaved state and the
// message. GET / PUT on the section's route; the admin role writes after a step-up (the
// dashboard's fetch wrapper asks for it and retries once).
import { useState, type ReactNode } from "react";
import { Btn, Field } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";
import { useUnsavedGuard } from "../../_components/useUnsavedGuard";

export function SingleSetting({
  url, field, stored, effective, isDefault, canEdit, label, help, unit, onSaved, testId, savedText,
}: {
  url: string;
  /** The request key («lowStockGreenKg», «defaultVatPercent»). */
  field: string;
  stored: string | null;
  effective: string;
  isDefault: boolean;
  canEdit: boolean;
  label: string;
  help: ReactNode;
  unit: string;
  onSaved: (body: Record<string, unknown>) => void;
  testId: string;
  savedText: (body: Record<string, unknown>) => string;
}) {
  const { lang } = useI18n();
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const [value, setValue] = useState(stored ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // A new stored value (after a save) replaces the input — adjusted during render, not in an effect.
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) { setSeen(stored); setValue(stored ?? ""); }
  const dirty = value.trim() !== (stored ?? "");
  useUnsavedGuard(dirty, L("لديك تغيير غير محفوظ.", "You have an unsaved change."));

  async function save(v: string) {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [field]: v.trim() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: (ar ? j.error : j.errorEn ?? j.error) ?? L("تعذّر الحفظ. لم يتغير شيء.", "Could not save. Nothing was changed.") }); return; }
      onSaved(j);
      setMsg({ ok: true, text: savedText(j) });
    } catch {
      setMsg({ ok: false, text: L("تعذّر الحفظ. لم يتغير شيء.", "Could not save. Nothing was changed.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {dirty && canEdit ? (
        <div className="ss-unsaved" role="status" data-testid={`${testId}-unsaved`}>
          <span className="ss-dotw" aria-hidden />
          <span className="ss-unsaved-text">{L("تغيير واحد غير محفوظ", "1 unsaved change")} · <bdi className="hr-num">{stored ?? effective}</bdi> ← <bdi className="hr-num">{value.trim() || effective}</bdi> {unit}</span>
          <span className="ss-unsaved-acts"><Btn size="sm" variant="ghost" onClick={() => setValue(stored ?? "")}>{L("تجاهل", "Discard")}</Btn></span>
        </div>
      ) : null}
      <form className="ss-setrow" noValidate onSubmit={(e) => { e.preventDefault(); void save(value); }}>
        <Field label={label} help={help}>
          <span className="ss-unitin">
            <input className="hr-input ss-numin" dir="ltr" inputMode="decimal" value={value} placeholder={effective} disabled={!canEdit}
              onChange={(e) => setValue(e.target.value)} aria-describedby={`${testId}-state`} data-testid={`${testId}-input`} />
            <span aria-hidden>{unit}</span>
          </span>
        </Field>
        {canEdit ? (
          <div className="tl-acts" style={{ paddingBottom: 22 }}>
            <Btn type="submit" variant="primary" busy={busy} disabled={!dirty} data-testid={`${testId}-save`}>{L("حفظ", "Save")}</Btn>
            {!isDefault ? <Btn variant="ghost" disabled={busy} onClick={() => { setValue(""); void save(""); }} data-testid={`${testId}-reset`}>{L("العودة إلى الافتراضي", "Back to the default")}</Btn> : null}
          </div>
        ) : null}
      </form>
      <p className="tl-foot" id={`${testId}-state`} data-testid={`${testId}-state`}>
        {isDefault ? L("المعمول به الآن: القيمة الافتراضية", "In force now: the default") : L("المعمول به الآن: القيمة المحفوظة", "In force now: the saved value")} · <bdi className="hr-num">{effective}</bdi> {unit}
      </p>
      {msg ? <div role={msg.ok ? "status" : "alert"} className={`hr-notice tone-${msg.ok ? "success" : "danger"}`} data-testid={`${testId}-msg`}>{msg.text}</div> : null}
    </>
  );
}
