"use client";

import { useEffect, useState } from "react";
import { Languages } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { toggleAriaLabel, toggleLabel } from "@/lib/i18n/language-switch";

/**
 * The one-tap language switch (owner, 25 Oct 2026). It shows the language it switches TO
 * («EN» in Arabic, «عربي» in English), changes the whole screen in place and saves the choice to
 * the profile (useLanguageSwitcher). Draws nothing where the screen cannot switch in place
 * (no `switcher` in the i18n context).
 *
 *   variant "bar"  — the header button: the desktop top bar, the phone header, the station bar;
 *   variant "menu" — a row of the account menu (sidebar user block);
 *   variant "row"  — a row of the phone «المزيد» sheet.
 */
export function LanguageToggle({ variant = "bar", className, onDone, testId }: { variant?: "bar" | "menu" | "row"; className?: string; onDone?: () => void; testId?: string }) {
  const { lang, switcher } = useI18n();
  const [showError, setShowError] = useState(false);
  const failed = !!switcher?.failed;
  useEffect(() => {
    if (!failed) return;
    setShowError(true); // eslint-disable-line react-hooks/set-state-in-effect -- a transient notice for a failed save
    const id = window.setTimeout(() => setShowError(false), 4000);
    return () => window.clearTimeout(id);
  }, [failed]);
  if (!switcher) return null;

  const label = toggleLabel(lang);
  const aria = toggleAriaLabel(lang);
  const onClick = () => { onDone?.(); void switcher.toggle(); };
  const errorText = lang === "ar" ? "تعذّر حفظ اللغة. حاول مرة أخرى." : "Could not save the language. Try again.";

  if (variant === "menu") {
    return (
      <button role="menuitem" type="button" className={className} onClick={onClick} aria-label={aria} disabled={switcher.pending} data-testid={testId ?? "lang-toggle-menu"}>
        <Languages aria-hidden className="d21-lang-ico" />
        <span lang={label.lang} dir={label.lang === "ar" ? "rtl" : "ltr"}>{label.name}</span>
      </button>
    );
  }
  if (variant === "row") {
    return (
      <button type="button" className={className ?? "d21-more-row"} onClick={onClick} aria-label={aria} disabled={switcher.pending} data-testid={testId ?? "lang-toggle-more"}>
        <Languages aria-hidden />
        <span lang={label.lang} dir={label.lang === "ar" ? "rtl" : "ltr"}>{label.name}</span>
      </button>
    );
  }
  return (
    <span className={`d21-lang${className ? " " + className : ""}`}>
      <button type="button" className="d21-ib d21-lang-btn" onClick={onClick} aria-label={aria} title={label.name}
        aria-busy={switcher.pending || undefined} data-pending={switcher.pending ? "true" : undefined} data-testid={testId ?? "lang-toggle"}>
        <span lang={label.lang} dir={label.lang === "ar" ? "rtl" : "ltr"} aria-hidden>{label.text}</span>
      </button>
      <span className="d21-lang-err" role="status" aria-live="polite" data-show={showError ? "true" : undefined}>{showError ? errorText : ""}</span>
    </span>
  );
}
