"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { langFromNavigator } from "@/lib/i18n/browser-lang";
import type { GuestLang } from "./GuestShell";

/**
 * The guest's browser language as the server read it from `Accept-Language` (owner language
 * decision 2); null when the request carried none. Provided by the guest layouts.
 */
export const GuestLangContext = createContext<GuestLang | null>(null);

/**
 * The language of a guest page: the browser's language at first (Arabic when it is Arabic, otherwise
 * English), then whatever the page's own toggle chooses.
 */
export function useGuestLang(): [GuestLang, (l: GuestLang) => void] {
  const fromServer = useContext(GuestLangContext);
  const [lang, setLang] = useState<GuestLang>(fromServer ?? "ar");
  useEffect(() => {
    if (fromServer) return;
    // No Accept-Language reached the server: ask the browser itself.
    const l = langFromNavigator(typeof navigator === "undefined" ? null : navigator.languages, typeof navigator === "undefined" ? null : navigator.language);
    if (l) setLang(l); // eslint-disable-line react-hooks/set-state-in-effect -- the browser's language exists only in the browser
  }, [fromServer]);
  return [lang, setLang];
}
