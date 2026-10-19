"use client";

// The screens the dashboard layout draws before a route's shell is known (UI batch 2): the
// session check and the MFA-required enrolment. Direction 2.1 tokens (direction-2.1.css on the
// `.d21` root) and IBM Plex; no legacy cream, purple or Tajawal. Behaviour is the layout's.
import { useSyncExternalStore } from "react";
import { MfaEnrollment } from "@/components/auth/MfaEnrollment";
import { BrandMark } from "@/components/brand/BrandMark";
import "./direction-2.1.css";
import "./shell-states.css";

/** The document language the root layout set from the session cookie (`<html lang>`). */
function useDocLang(): "ar" | "en" {
  return useSyncExternalStore(
    () => () => {},
    () => (document.documentElement.lang === "en" ? "en" : "ar"),
    () => "ar",
  );
}

// Self-hosted IBM Plex, linked as the shell and the guest pages do (hoisted by `precedence`).
// eslint-disable-next-line @next/next/no-css-tags
const PLEX = <link rel="stylesheet" precedence="default" href="/fonts/ibm-plex.css" />;

export function ShellLoading() {
  const lang = useDocLang();
  const ar = lang === "ar";
  return (
    <div className="d21 d21-state" lang={lang} dir={ar ? "rtl" : "ltr"} data-testid="shell-loading">
      {PLEX}
      <div className="d21-state-load" role="status" aria-live="polite">
        <span className="d21-state-mark" aria-hidden><BrandMark /></span>
        <span className="d21-state-ring" aria-hidden />
        <span>{ar ? "جارٍ التحميل…" : "Loading…"}</span>
      </div>
    </div>
  );
}

export function MfaRequiredScreen({ lang }: { lang: "ar" | "en" }) {
  const ar = lang === "ar";
  return (
    <div className="d21 d21-state is-mfa" lang={lang} dir={ar ? "rtl" : "ltr"} data-hr-root="">
      {PLEX}
      <div className="d21-mfa" data-testid="mfa-required-screen">
        <div className="d21-mfa-brand">
          <span className="mark" aria-hidden><BrandMark /></span>
          <div><b>{ar ? "حِقبة" : "Hiqbah"}</b><span>{ar ? "أمان الحساب" : "Account security"}</span></div>
        </div>
        <div>
          <h1>{ar ? "فعّل التحقق بخطوتين للمتابعة" : "Turn on two-step verification to continue"}</h1>
        </div>
        <p>{ar ? "حسابك يحمل صلاحيات حساسة، فلا يفتح النظام قبل تفعيل التحقق بخطوتين." : "Your account holds sensitive duties, so the system opens only after two-step verification is on."}</p>
        <MfaEnrollment lang={lang} onEnrolled={() => window.location.reload()} />
        <button type="button" className="d21-mfa-out" onClick={async () => { await fetch("/api/auth/me", { method: "DELETE" }); window.location.href = "/login"; }}>
          {ar ? "تسجيل الخروج" : "Sign out"}
        </button>
      </div>
    </div>
  );
}
