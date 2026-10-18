"use client";

// Two-step verification (TOTP) for the signed-in account: status, enrollment with a QR code and
// a manual key, confirmation with a first code, and the ten recovery codes — shown ONCE.
import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ShieldCheck, ShieldAlert, Copy, Check } from "lucide-react";

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
  return (
    <section className="rounded-2xl border border-border bg-white p-5" data-testid="mfa-section" aria-labelledby="mfa-title">
      <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
        <h2 id="mfa-title" className="font-bold text-charcoal flex items-center gap-2">{status.enrolled ? <ShieldCheck size={18} className="text-success" /> : <ShieldAlert size={18} className="text-orange" />}{t.title}</h2>
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${status.enrolled ? "bg-success-bg text-success" : "bg-cream text-brown"}`} data-testid="mfa-status">{status.enrolled ? t.on : t.off}</span>
      </div>

      {codes ? (
        <div data-testid="mfa-recovery-codes">
          <h3 className="font-bold text-charcoal mb-1">{t.codesTitle}</h3>
          <p className="text-sm text-brown/70 mb-3">{t.codesHint}</p>
          <ol dir="ltr" className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2 font-mono text-sm mb-3">
            {codes.map((c) => <li key={c} className="px-3 py-2 bg-cream rounded-lg text-center tracking-wider">{c}</li>)}
          </ol>
          <button type="button" onClick={() => { navigator.clipboard?.writeText(codes.join("\n")).then(() => setCopied(true)).catch(() => {}); }} className="inline-flex items-center gap-1.5 text-sm font-semibold text-charcoal border-2 border-border rounded-xl px-3 py-2 mb-3">{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? t.copied : t.copy}</button>
          <label className="flex items-center gap-2 text-sm text-charcoal mb-3"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="mfa-codes-saved" />{t.saved}</label>
          <button type="button" disabled={!saved} onClick={finish} className="px-5 py-2.5 bg-orange text-white font-bold rounded-xl disabled:opacity-40" data-testid="mfa-codes-done">{t.done}</button>
        </div>
      ) : status.enrolled ? (
        <div className="text-sm text-brown/80 space-y-1">
          {status.enrolledAt && <p>{t.enrolledAt}: <bdi dir="ltr">{new Date(status.enrolledAt).toLocaleDateString(lang === "ar" ? "ar-SA-u-nu-latn" : "en-GB")}</bdi></p>}
          <p>{t.remaining}: <b>{status.recoveryCodesRemaining}</b></p>
          <p className="text-xs text-brown/60 pt-2">{t.lost}</p>
        </div>
      ) : !status.configured ? (
        <p className="text-sm text-brown/70">{t.notConfigured}</p>
      ) : setup ? (
        <div data-testid="mfa-setup">
          <p className="text-sm text-charcoal mb-3">{t.step1}</p>
          <div className="flex flex-col sm:flex-row gap-4 items-start mb-4">
            <div className="p-3 bg-white border border-border rounded-xl" data-testid="mfa-qr"><QRCodeSVG value={setup.otpauth} size={168} /></div>
            <div className="min-w-0">
              <p className="text-xs text-brown/70 mb-1">{t.manual}</p>
              <code dir="ltr" className="block font-mono text-sm bg-cream rounded-lg px-3 py-2 break-all select-all" data-testid="mfa-manual-key">{groups}</code>
            </div>
          </div>
          <p className="text-sm text-charcoal mb-2">{t.step2}</p>
          <div className="flex gap-2 flex-wrap">
            <input dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirm()} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" className="w-40 px-3 py-2.5 border-2 border-border rounded-xl text-center tracking-[3px] focus:border-orange outline-none" data-testid="mfa-confirm-code" />
            <button type="button" onClick={confirm} disabled={busy || !code.trim()} className="px-5 py-2.5 bg-orange text-white font-bold rounded-xl disabled:opacity-40" data-testid="mfa-confirm">{t.confirm}</button>
          </div>
        </div>
      ) : (
        <div>
          <p className="text-sm text-brown/80 mb-3">{status.enrollmentRequired ? t.required : status.privileged ? t.recommended : t.optional}</p>
          <button type="button" onClick={start} disabled={busy} className="px-5 py-2.5 bg-orange text-white font-bold rounded-xl disabled:opacity-40" data-testid="mfa-start">{t.start}</button>
        </div>
      )}
      {error && <div role="alert" className="bg-danger-bg text-danger px-3 py-2 rounded-xl text-sm font-semibold mt-3">{error}</div>}
    </section>
  );
}
