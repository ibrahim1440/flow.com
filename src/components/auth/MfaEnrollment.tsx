"use client";

// Two-step verification (TOTP) for the signed-in account: status, enrollment with a QR code and
// a manual key, confirmation with a first code, and the ten recovery codes — shown ONCE.
import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, Check } from "lucide-react";
import "@/components/hr/hr.css";
import "./mfa.css";

type Status = { configured: boolean; mode: "enrolled" | "required"; enrolled: boolean; enrolledAt: string | null; pending: boolean; recoveryCodesRemaining: number; privileged: boolean; enrollmentRequired: boolean };

const T = {
  ar: {
    title: "التحقق بخطوتين", on: "مفعّل", off: "غير مفعّل", enrolledAt: "فُعّل في", remaining: "رموز الاسترداد المتبقية", required: "حسابك ذو صلاحيات حساسة: يجب تفعيل التحقق بخطوتين قبل المتابعة.",
    recommended: "حسابك ذو صلاحيات حساسة: فعّل التحقق بخطوتين لحمايته.", optional: "طبقة حماية إضافية عند الدخول وعند الإجراءات الحساسة.", notConfigured: "التحقق بخطوتين غير مهيأ على هذا الخادم.",
    start: "تفعيل التحقق بخطوتين", step1: "1. امسح الرمز بتطبيق مصادقة (مثل Google Authenticator أو Microsoft Authenticator).", manual: "أو أدخل المفتاح يدويًا:", step2: "2. أدخل الرمز المكوّن من 6 أرقام الظاهر في التطبيق.",
    confirm: "تأكيد التفعيل", codesTitle: "رموز الاسترداد", codesHint: "احفظ هذه الرموز في مكان آمن. تظهر مرة واحدة فقط، وكل رمز يُستخدم مرة واحدة إذا فقدت جهازك.", copy: "نسخ", copied: "نُسخت", saved: "حفظت الرموز في مكان آمن", done: "تم",
    lost: "فقدت جهازك ورموز الاسترداد؟ اطلب من محرر حسابات آخر إعادة تعيين التحقق بخطوتين؛ يتحقق شخص ثانٍ من هويتك.", failed: "تعذّر التنفيذ",
  },
  en: {
    title: "Two-step verification", on: "On", off: "Off", enrolledAt: "Enabled on", remaining: "Recovery codes left", required: "Your account has sensitive duties: set up two-step verification before you continue.",
    recommended: "Your account has sensitive duties: turn on two-step verification to protect it.", optional: "An extra layer of protection at sign-in and for sensitive actions.", notConfigured: "Two-step verification is not configured on this server.",
    start: "Set up two-step verification", step1: "1. Scan the code with an authenticator app (such as Google Authenticator or Microsoft Authenticator).", manual: "Or enter the key manually:", step2: "2. Enter the 6-digit code the app shows.",
    confirm: "Confirm", codesTitle: "Recovery codes", codesHint: "Keep these codes somewhere safe. They are shown only once; each works once if you lose your device.", copy: "Copy", copied: "Copied", saved: "I saved these codes somewhere safe", done: "Done",
    lost: "Lost your device and your recovery codes? Ask another account editor to reset two-step verification; a second person checks your identity.", failed: "Could not complete",
  },
} as const;

export function MfaEnrollment({ lang, onEnrolled }: { lang: "ar" | "en"; onEnrolled?: () => void }) {
  const t = T[lang];
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => fetch("/api/auth/mfa").then((r) => (r.ok ? r.json() : null)).then(setStatus).catch(() => setStatus(null)), []);
  useEffect(() => { load(); }, [load]);
  const err = (d: { error?: string; errorEn?: string } | null) => setError((lang === "ar" ? d?.error : d?.errorEn ?? d?.error) ?? t.failed);

  async function start() {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/auth/mfa/enroll", { method: "POST" });
      const d = await r.json().catch(() => null);
      if (!r.ok) return err(d);
      setSetup(d); setCode("");
    } finally { setBusy(false); }
  }
  async function confirm() {
    if (!code.trim()) return;
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/auth/mfa/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim() }) });
      const d = await r.json().catch(() => null);
      if (!r.ok) return err(d);
      setCodes(d.recoveryCodes); setSetup(null);
    } finally { setBusy(false); }
  }
  function finish() {
    setCodes(null); setSaved(false); load(); onEnrolled?.();
  }

  if (!status) return null;
  const groups = setup ? setup.secret.match(/.{1,4}/g)?.join(" ") : "";
  // Direction 2.1 (UI batch 2): drawn with the shared HR kit classes, so it needs a
  // `[data-hr-root]` ancestor inside a `.d21` root — the profile page (HrRoot in the shell) and
  // the MFA-required screen of the dashboard layout both provide one. Same requests, same states.
  return (
    <section className="mfa-card" data-testid="mfa-section" aria-labelledby="mfa-title">
      <div className="mfa-head">
        <h2 id="mfa-title" className="hr-section">{t.title}</h2>
        <span className={`hr-dot tone-${status.enrolled ? "success" : "neutral"}`} data-testid="mfa-status"><span>{status.enrolled ? t.on : t.off}</span></span>
      </div>

      {codes ? (
        <div className="hr-stack" data-testid="mfa-recovery-codes">
          <h3 className="mfa-sub">{t.codesTitle}</h3>
          <p className="hr-caption" style={{ margin: 0 }}>{t.codesHint}</p>
          <ol dir="ltr" className="mfa-codes">
            {codes.map((c) => <li key={c}>{c}</li>)}
          </ol>
          <div>
            <button type="button" onClick={() => { navigator.clipboard?.writeText(codes.join("\n")).then(() => setCopied(true)).catch(() => {}); }} className="hr-btn is-sm">{copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? t.copied : t.copy}</button>
          </div>
          <label className="mfa-check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="mfa-codes-saved" />{t.saved}</label>
          <div>
            <button type="button" disabled={!saved} onClick={finish} className="hr-btn is-primary" data-testid="mfa-codes-done">{t.done}</button>
          </div>
        </div>
      ) : status.enrolled ? (
        <div className="hr-stack">
        <dl className="hr-kv">
          {status.enrolledAt && <div><dt>{t.enrolledAt}</dt><dd><bdi dir="ltr" className="hr-num">{new Date(status.enrolledAt).toLocaleDateString(lang === "ar" ? "ar-SA-u-nu-latn" : "en-GB")}</bdi></dd></div>}
          <div><dt>{t.remaining}</dt><dd className="hr-num">{status.recoveryCodesRemaining}</dd></div>
        </dl>
          <p className="hr-caption" style={{ margin: 0 }}>{t.lost}</p>
        </div>
      ) : !status.configured ? (
        <p className="hr-caption" style={{ margin: 0 }}>{t.notConfigured}</p>
      ) : setup ? (
        <div className="hr-stack" data-testid="mfa-setup">
          <p style={{ margin: 0 }}>{t.step1}</p>
          <div className="mfa-qrrow">
            <div className="mfa-qr" data-testid="mfa-qr"><QRCodeSVG value={setup.otpauth} size={168} /></div>
            <div style={{ minWidth: 0 }}>
              <p className="hr-caption" style={{ margin: "0 0 4px" }}>{t.manual}</p>
              <code dir="ltr" className="mfa-key" data-testid="mfa-manual-key">{groups}</code>
            </div>
          </div>
          <p style={{ margin: 0 }}>{t.step2}</p>
          <div className="mfa-confirm">
            <input dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirm()} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" className="hr-input mfa-code" aria-label={t.step2} data-testid="mfa-confirm-code" />
            <button type="button" onClick={confirm} disabled={busy || !code.trim()} className="hr-btn is-primary" data-testid="mfa-confirm">{t.confirm}</button>
          </div>
        </div>
      ) : (
        <div className="hr-stack">
          <p className={status.enrollmentRequired || status.privileged ? undefined : "hr-caption"} style={{ margin: 0 }}>{status.enrollmentRequired ? t.required : status.privileged ? t.recommended : t.optional}</p>
          <div>
            <button type="button" onClick={start} disabled={busy} className="hr-btn is-primary" data-testid="mfa-start">{t.start}</button>
          </div>
        </div>
      )}
      {error && <div role="alert" className="hr-notice tone-danger">{error}</div>}
    </section>
  );
}
