"use client";
// The generic error screen (owner language decision 5, 26 Oct 2026): what a person sees when a page
// fails unexpectedly. In the page's language with the other language beneath it, «حاول مرة أخرى»
// (re-renders the failed segment) and a way home. It never shows the error's message, stack or any
// detail of what failed — only the short reference (digest) Next.js gives a server error, so it can
// be matched to the server log.
import { useSyncExternalStore } from "react";

type Lang = "ar" | "en";

const TEXT = {
  ar: { title: "حدث خطأ غير متوقع.", body: "تعذّر عرض هذه الصفحة. لم يتغير شيء بسبب هذا الخطأ. حاول مرة أخرى، أو عد إلى الرئيسية.", retry: "حاول مرة أخرى", home: "العودة إلى الرئيسية", ref: "رقم المرجع" },
  en: { title: "Something went wrong.", body: "This page could not be shown. Nothing was changed by this error. Try again, or go back home.", retry: "Try again", home: "Back to home", ref: "Reference" },
} as const;

const subscribe = () => () => {};
/** The language <html> carries (the root layout sets it from the account or the sign-in choice). */
const readLang = (): Lang => (typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "ar");

/** A Next.js digest is a short opaque id; anything else is not shown. */
export function safeDigest(d: unknown): string | null {
  return typeof d === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(d) ? d : null;
}

export function ErrorScreen({ digest, onRetry, homeHref = "/dashboard", lang: forced }: { digest?: string; onRetry: () => void; homeHref?: string; /** Tests and previews only; the page reads <html lang>. */ lang?: Lang }) {
  const docLang = useSyncExternalStore(subscribe, readLang, () => "ar" as Lang);
  const lang = forced ?? docLang;
  const other: Lang = lang === "ar" ? "en" : "ar";
  const t = TEXT[lang], o = TEXT[other];
  const ref = safeDigest(digest);
  return (
    <main
      data-testid="error-screen"
      lang={lang}
      dir={lang === "ar" ? "rtl" : "ltr"}
      style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "system-ui, sans-serif", background: "#faf8f3", color: "#2b2a26" }}
    >
      <div role="alert" style={{ maxWidth: 520, width: "100%", textAlign: "center" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>{t.title}</h1>
        <p style={{ fontSize: 15, lineHeight: 1.6, margin: "0 0 20px" }}>{t.body}</p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginBottom: 24 }}>
          <button type="button" onClick={onRetry} data-testid="error-retry"
            style={{ appearance: "none", border: 0, borderRadius: 8, padding: "10px 18px", font: "600 14px system-ui, sans-serif", background: "#4d5a2b", color: "#fff", cursor: "pointer" }}>
            {t.retry}
          </button>
          {/* A full navigation: the failed tree is left behind entirely. */}
          <a href={homeHref} data-testid="error-home"
            style={{ borderRadius: 8, padding: "10px 18px", font: "600 14px system-ui, sans-serif", border: "1px solid #c9c3b4", color: "#2b2a26", textDecoration: "none" }}>
            {t.home}
          </a>
        </div>
        <div lang={other} dir={other === "ar" ? "rtl" : "ltr"} data-testid="error-other-lang" style={{ borderTop: "1px solid #e4dfd3", paddingTop: 16, color: "#6b675d" }}>
          <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px" }}>{o.title}</p>
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>{o.body}</p>
        </div>
        {ref ? (
          <p style={{ fontSize: 12, color: "#8a8579", marginTop: 16 }} data-testid="error-ref">
            {t.ref}: <bdi dir="ltr" style={{ fontFamily: "ui-monospace, monospace" }}>{ref}</bdi>
          </p>
        ) : null}
      </div>
    </main>
  );
}
