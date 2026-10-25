"use client";

import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react";
import { tr, type Lang, type TranslationKey } from "./translations";

/**
 * The quick language switch (./language-switch.ts, ./use-language-switcher.ts). Present only
 * where the screen's owner can change the language in place: the ERP shell and a personal
 * station session. Absent elsewhere (a shared station device, the guest cupping page, a print
 * page), so the header toggle draws nothing there.
 */
export type LanguageSwitcher = {
  /** One tap: the other language, at once; saved to the profile; rolled back if the save fails. */
  toggle: () => Promise<boolean>;
  /** Apply a language that is ALREADY saved (the profile form saved it) without saving again. */
  apply: (l: Lang) => void;
  /** A save is in flight (the toggle ignores further taps until it answers). */
  pending: boolean;
  /** The last tap could not be saved (the language was put back). Cleared by the next tap. */
  failed: boolean;
};

type I18nContext = {
  lang: Lang;
  dir: "ltr" | "rtl";
  t: (key: TranslationKey) => string;
  switcher?: LanguageSwitcher;
};

const I18nCtx = createContext<I18nContext>({
  lang: "ar",
  dir: "rtl",
  t: (key) => tr(key, "ar"),
});

export function LanguageProvider({ lang, switcher, children }: { lang: Lang; switcher?: LanguageSwitcher; children: ReactNode }) {
  const dir = lang === "ar" ? "rtl" : "ltr";
  const t = useCallback((key: TranslationKey) => tr(key, lang), [lang]);
  const value = useMemo(() => ({ lang, dir, t, switcher }) as I18nContext, [lang, dir, t, switcher]);
  return <I18nCtx value={value}>{children}</I18nCtx>;
}

export function useI18n() {
  return useContext(I18nCtx);
}
