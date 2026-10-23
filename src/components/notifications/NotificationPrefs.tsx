"use client";

// «ملفي» › «التنبيهات» (feat/notifications): per category, in-app is always on and the e-mail is the
// person's choice (saved at once). The default — e-mail on for «شؤوني» and «النظام», off for the work
// categories — is shown as the starting position. The address is the company e-mail.
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { OpsError, OpsLoading } from "@/components/ops/ui";
import { Ico } from "@/components/shell/icons";
import { CATEGORY_LABEL, type Category } from "@/lib/notifications/catalog";
import { CATEGORY_ICON } from "./shared";
import "./notifications.css";

type Pref = { category: Category; email: boolean; default: boolean; inApp: true };

export function NotificationPrefs() {
  const { lang } = useI18n();
  const ar = lang === "ar";
  const [prefs, setPrefs] = useState<Pref[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<Category | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch("/api/notifications/preferences", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((d: { categories: Pref[] }) => { setErr(null); setPrefs(d.categories); }, () => setErr(ar ? "تعذّر تحميل إعدادات التنبيهات." : "Could not load the notification settings."));
  }, [ar]);
  useEffect(() => { load(); }, [load]);
  const toggle = async (c: Category, email: boolean) => {
    setSaving(c); setSaved(null);
    const prev = prefs;
    // At once on screen; put back if the save fails.
    setPrefs((ps) => ps?.map((x) => (x.category === c ? { ...x, email } : x)) ?? ps);
    try {
      const r = await fetch("/api/notifications/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: { [c]: email } }) });
      if (!r.ok) throw new Error(String(r.status));
      setPrefs(((await r.json()) as { categories: Pref[] }).categories);
      setSaved(ar ? "حُفظ." : "Saved.");
    } catch {
      setPrefs(prev);
      setErr(ar ? "تعذّر الحفظ. لم يتغير شيء." : "Could not save. Nothing was changed.");
    } finally {
      setSaving(null);
    }
  };
  return (
    <div className="pf-tabbody" data-testid="pf-notifications">
      <section className="pf-block" aria-labelledby="nf-prefs-h">
        <div className="pf-bhead">
          <h2 id="nf-prefs-h">{ar ? "التنبيهات" : "Notifications"}</h2>
          <span className="pf-bcap" role="status">{saved ?? (ar ? "داخل النظام دائمًا · البريد باختيارك" : "Always in the app · e-mail is your choice")}</span>
        </div>
        <p className="hr-caption" style={{ margin: "0 0 12px" }}>
          {ar ? "يصلك كل تنبيه في الجرس داخل النظام. فعّل البريد للفئات التي تريد أن تصلك على بريد الشركة أيضًا." : "Every notification reaches the bell in the app. Turn e-mail on for the categories you also want at your company e-mail."}
        </p>
        {err ? <OpsError message={err} onRetry={load} /> : !prefs ? <OpsLoading rows={4} /> : (
          <ul className="nf-prefs">
            {prefs.map((p) => (
              <li key={p.category} className="nf-pref" data-testid={`nf-pref-${p.category}`}>
                <span className="nf-ic" aria-hidden><Ico name={CATEGORY_ICON[p.category]} small /></span>
                <span className="nf-txt">
                  <span className="t">{ar ? CATEGORY_LABEL[p.category].ar : CATEGORY_LABEL[p.category].en}</span>
                  <span className="b">{ar ? CATEGORY_LABEL[p.category].hintAr : CATEGORY_LABEL[p.category].hintEn}</span>
                </span>
                <span className="nf-ctrl">
                  <span className="nf-inapp">{ar ? "داخل النظام: دائمًا" : "In app: always"}</span>
                  <label className="nf-switch">
                    <input type="checkbox" checked={p.email} aria-busy={saving === p.category || undefined} onChange={(e) => void toggle(p.category, e.target.checked)} data-testid={`nf-email-${p.category}`} />
                    {ar ? "البريد" : "E-mail"}
                  </label>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
