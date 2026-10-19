"use client";

// The screens the dashboard layout draws before a route's shell is known (UI batch 2): the
// session check and the MFA-required enrolment. Direction 2.1 tokens (direction-2.1.css on the
// `.d21` root) and IBM Plex; no legacy cream, purple or Tajawal. Behaviour is the layout's.
import { useState, useSyncExternalStore } from "react";
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

/**
 * A temporary password (Figma UR-03e «ستغيّرها عند أول دخول», UR-04): until the person sets their
 * own, every request of the account is refused (403 PASSWORD_CHANGE_REQUIRED) except this change —
 * the same pattern as the two-step verification screen above.
 */
export function PasswordChangeRequiredScreen({ lang }: { lang: "ar" | "en" }) {
  const ar = lang === "ar";
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mismatch = !!again && again !== next;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch || next.length < 8) return;
    setBusy(true); setErr(null);
    const r = await fetch("/api/profile/password", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: cur, newPassword: next }) });
    const b = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { window.location.reload(); return; }
    setErr((ar ? b.error : b.errorEn ?? b.error) ?? (ar ? "تعذّر الحفظ." : "Could not save."));
  }
  return (
    <div className="d21 d21-state is-mfa" lang={lang} dir={ar ? "rtl" : "ltr"} data-hr-root="">
      {PLEX}
      <div className="d21-mfa" data-testid="password-change-required">
        <div className="d21-mfa-brand">
          <span className="mark" aria-hidden><BrandMark /></span>
          <div><b>{ar ? "حِقبة" : "Hiqbah"}</b><span>{ar ? "أمان الحساب" : "Account security"}</span></div>
        </div>
        <div><h1>{ar ? "غيّر كلمة المرور المؤقتة للمتابعة" : "Change the temporary password to continue"}</h1></div>
        <p>{ar ? "دخلت بكلمة مرور مؤقتة أعطاك إياها مسؤول النظام. عيّن كلمة مرورك الخاصة؛ لا يراها أحد غيرك." : "You signed in with a temporary password from the administrator. Set your own; nobody else sees it."}</p>
        <form onSubmit={save} className="hr-form" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="hr-field"><span className="hr-label">{ar ? "كلمة المرور المؤقتة" : "Temporary password"}</span><input className="hr-input" type="password" autoComplete="current-password" dir="ltr" value={cur} onChange={(e) => setCur(e.target.value)} data-testid="pcr-current" /></label>
          <label className="hr-field"><span className="hr-label">{ar ? "كلمة المرور الجديدة" : "New password"}</span><input className="hr-input" type="password" autoComplete="new-password" dir="ltr" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} data-testid="pcr-new" /><span className="hr-help">{ar ? "8 أحرف على الأقل." : "At least 8 characters."}</span></label>
          <label className="hr-field"><span className="hr-label">{ar ? "تأكيد كلمة المرور" : "Confirm password"}</span><input className="hr-input" type="password" autoComplete="new-password" dir="ltr" value={again} onChange={(e) => setAgain(e.target.value)} data-testid="pcr-again" />{mismatch ? <span className="hr-err">{ar ? "غير متطابقة." : "Does not match."}</span> : null}</label>
          {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
          <button type="submit" className="hr-btn is-primary" disabled={busy || !cur || next.length < 8 || mismatch} data-testid="pcr-save">{busy ? "…" : ar ? "حفظ كلمة المرور" : "Save password"}</button>
        </form>
        <button type="button" className="d21-mfa-out" onClick={async () => { await fetch("/api/auth/me", { method: "DELETE" }); window.location.href = "/login"; }}>
          {ar ? "تسجيل الخروج" : "Sign out"}
        </button>
      </div>
    </div>
  );
}
