"use client";

import { createContext, useContext, useCallback, type ReactNode } from "react";
import { tr, type Lang, type TranslationKey } from "./translations";

type I18nContext = {
  lang: Lang;
  dir: "ltr" | "rtl";
  t: (key: TranslationKey) => string;
};

const I18nCtx = createContext<I18nContext>({
  lang: "ar",
  dir: "rtl",
  t: (key) => tr(key, "ar"),
});

export function LanguageProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const dir = lang === "ar" ? "rtl" : "ltr";
  const t = useCallback((key: TranslationKey) => tr(key, lang), [lang]);
  return <I18nCtx value={{ lang, dir, t }}>{children}</I18nCtx>;
}

export function useI18n() {
  return useContext(I18nCtx);
}
