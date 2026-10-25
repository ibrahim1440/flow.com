"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "./translations";
import type { LanguageSwitcher } from "./context";
import { applyDocumentLang, otherLang, persistLanguage, writeLangCookie } from "./language-switch";

/**
 * The quick switch for a screen that owns the signed-in person's language in client state
 * (the dashboard layout's `user`, the station shell's personal session).
 *
 * Optimistic: the screen re-renders in the other language at once (`setLang`), <html lang/dir>
 * flip with it; then the choice is saved through PATCH /api/profile — the profile form's own
 * endpoint, which re-signs the current session's token — and `router.refresh()` re-renders the
 * server parts (the root layout's <html>) from the new token. The URL, its query (open filters)
 * and the scroll position are untouched: nothing navigates. A refused or failed save puts the
 * previous language back and reports `failed`.
 */
export function useLanguageSwitcher(lang: Lang, setLang: (l: Lang) => void): LanguageSwitcher {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);

  const apply = useCallback((l: Lang) => {
    applyDocumentLang(l);
    writeLangCookie(l);
    setLang(l);
    router.refresh();
  }, [router, setLang]);

  const toggle = useCallback(async () => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setFailed(false);
    const prev = lang;
    const next = otherLang(prev);
    applyDocumentLang(next);
    setLang(next);
    const ok = await persistLanguage(next);
    if (ok) {
      writeLangCookie(next);
      router.refresh();
    } else {
      applyDocumentLang(prev);
      setLang(prev);
      setFailed(true);
    }
    busy.current = false;
    setPending(false);
    return ok;
  }, [lang, router, setLang]);

  return useMemo(() => ({ toggle, apply, pending, failed }), [toggle, apply, pending, failed]);
}
