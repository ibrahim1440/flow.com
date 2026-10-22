"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { WifiOff } from "lucide-react";

import { PIN_LENGTH } from "@/lib/pin-policy";
import { cameForExpiredSession, SESSION_EXPIRED_AR, SESSION_EXPIRED_EN } from "@/lib/session-expired";
import { DesktopRecommendedNotice } from "@/components/shell/DesktopRecommendedNotice";
import { SHOW_PIN_SIGN_IN } from "@/lib/simple-mode";
import { BrandMark } from "@/components/brand/BrandMark";
import "@/components/shell/direction-2.1.css";
import "./login.css";

// Owner security decision (16 Oct, Option A). Three ways in:
//   · "pin"           — PIN alone: operational accounts only (a privileged account is refused
//                       with the same answer as a wrong PIN);
//   · "username_pin"  — username + PIN on the same keypad: privileged accounts;
//   · "password"      — username + password.
// An account with two-step verification then gets a code step ("mfa") before any session.
//
// Presentation: Direction 2.1 sign-in, Figma 1JbZgpMqmPkUVne8ms9Ozz AU-01 517:2745 (1440),
// 517:2806 (1024), M-01 519:3063 (390), with the approved states AU-01b / AU-10 / AU-11 /
// AU-01s / AU-01p and the TD-13b PIN pad (555:4495). The requests, their bodies and the
// redirect are unchanged; only how the screen is drawn changed.
type Mode = "pin" | "username_pin" | "password";
type Lang = "ar" | "en";
type Attempt = { url: string; body: Record<string, unknown>; step: Mode | "mfa" };
type Note = { tone: "danger" | "warning" | "info"; title: string; body?: string; kind: "invalid" | "paused" | "offline" | "other" };

const PIN_AUTO_SUBMIT_LENGTH = PIN_LENGTH;
const PIN_MAX_LENGTH = PIN_LENGTH;

const T = {
  ar: {
    title: "تسجيل الدخول",
    subPassword: "ادخل باسم المستخدم وكلمة المرور الخاصين بك.",
    subUserPin: "ادخل باسم المستخدم ورمزك الخاص.",
    subPin: "ادخل رمزك على لوحة الأرقام.",
    enterPin: "أدخل رمزك", username: "اسم المستخدم", usernamePh: "مثال: ahmed", password: "كلمة المرور",
    show: "إظهار", hide: "إخفاء", showAria: "إظهار كلمة المرور", hideAria: "إخفاء كلمة المرور",
    signIn: "دخول", verifying: "جارٍ التحقق…", retry: "إعادة المحاولة",
    modes: "طريقة الدخول", modePin: "رمز فقط", modeUserPin: "اسم المستخدم والرمز", modePassword: "كلمة المرور",
    del: "حذف", digits: (n: number) => `${n} من ${PIN_LENGTH} أرقام`,
    privNote: "الحسابات ذات الصلاحيات الحساسة (الرواتب، المالية، إدارة الحسابات) تدخل باسم المستخدم مع الرمز.",
    forgot: "نسيت كلمة المرور؟", recoverTitle: "استعادة الدخول", recoverBody: "يعيد مسؤول النظام في منشأتك تفعيل حسابك. تواصل معه شخصيًا أو عبر مديرك المباشر.",
    mfaTitle: "التحقق بخطوتين", mfaHint: "أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة، أو أحد رموز الاسترداد.", mfaCode: "رمز التحقق", verify: "تحقق", back: "رجوع",
    invalidPassword: "اسم المستخدم أو كلمة المرور غير صحيحة.", invalidUserPin: "اسم المستخدم أو الرمز غير صحيح.", invalidPin: "الرمز غير صحيح.",
    hintPassword: "تحقّق من لغة لوحة المفاتيح ومفتاح الأحرف الكبيرة، ثم أعد المحاولة.", hintPin: "تحقّق من الرمز ثم أعد المحاولة.",
    pausedTitle: "توقفت محاولات الدخول مؤقتًا.", pausedBody: "تكررت المحاولات غير الناجحة. حاول مجددًا لاحقًا، أو اطلب من مسؤول النظام إعادة تعيين بيانات الدخول.",
    offlineTitle: "لا يوجد اتصال بالشبكة.", offlineBody: "لم تُرسل بيانات الدخول. تحقّق من اتصال الجهاز ثم أعد المحاولة.",
    failed: "تعذّر الدخول", lang: "English", system: "نظام إدارة حقبة",
  },
  en: {
    title: "Sign in",
    subPassword: "Enter your username and password.",
    subUserPin: "Enter your username and your PIN.",
    subPin: "Enter your PIN on the keypad.",
    enterPin: "Enter your PIN", username: "Username", usernamePh: "e.g. ahmed", password: "Password",
    show: "Show", hide: "Hide", showAria: "Show password", hideAria: "Hide password",
    signIn: "Sign in", verifying: "Verifying…", retry: "Try again",
    modes: "Sign-in method", modePin: "PIN only", modeUserPin: "Username + PIN", modePassword: "Password",
    del: "Delete", digits: (n: number) => `${n} of ${PIN_LENGTH} digits`,
    privNote: "Accounts with sensitive duties (payroll, finance, account administration) sign in with their username and PIN.",
    forgot: "Forgot your password?", recoverTitle: "Recovering access", recoverBody: "Your system administrator re-activates your account. Contact them in person or through your line manager.",
    mfaTitle: "Two-step verification", mfaHint: "Enter the 6-digit code from your authenticator app, or one of your recovery codes.", mfaCode: "Verification code", verify: "Verify", back: "Back",
    invalidPassword: "The username or password is incorrect.", invalidUserPin: "The username or PIN is incorrect.", invalidPin: "The PIN is incorrect.",
    hintPassword: "Check the keyboard language and Caps Lock, then try again.", hintPin: "Check the PIN, then try again.",
    pausedTitle: "Sign-in attempts are paused.", pausedBody: "There were too many unsuccessful attempts. Try again later, or ask your system administrator to reset your sign-in.",
    offlineTitle: "No network connection.", offlineBody: "Your sign-in details were not sent. Check the device's connection, then try again.",
    failed: "Sign-in failed", lang: "العربية", system: "Hiqbah management system",
  },
} as const;

/**
 * Workstations W1: a station page sends an unsigned visitor here with ?next=/station/…, and the
 * sign-in returns there. Only a /station/ path is honoured (never another origin or ERP route), so
 * the parameter cannot become an open redirect.
 */
function stationReturn(search: string): string | null {
  const next = new URLSearchParams(search).get("next");
  return next && /^\/station\/[a-z-]+$/.test(next) ? next : null;
}

export default function LoginPage() {
  const [lang, setLang] = useState<Lang>("ar");
  // SIMPLE MODE: username + password is the only method shown, and the default (SHOW_PIN_SIGN_IN).
  const [mode, setMode] = useState<Mode>(SHOW_PIN_SIGN_IN ? "pin" : "password");
  const [pin, setPin] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [note, setNote] = useState<Note | null>(null);
  const [recover, setRecover] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastAttempt, setLastAttempt] = useState<Attempt | null>(null);
  const router = useRouter();
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const [refocusPassword, setRefocusPassword] = useState(0);
  const t = T[lang];

  // Reached because a session ended (idle 4 h, absolute 12 h, logout elsewhere, revocation).
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    // A station that signed itself out after 5 idle minutes (Workstations W1, D3) shows the same notice.
    if (cameForExpiredSession(window.location.search) || new URLSearchParams(window.location.search).get("reason") === "station_idle") setExpired(true); // eslint-disable-line react-hooks/set-state-in-effect -- the query string exists only in the browser
  }, []);

  useEffect(() => {
    try { const l = localStorage.getItem("login-lang"); if (l === "en" || l === "ar") setLang(l); /* eslint-disable-line react-hooks/set-state-in-effect -- the saved choice exists only in the browser */ } catch { /* storage unavailable */ }
  }, []);
  function toggleLang() {
    const next: Lang = lang === "ar" ? "en" : "ar";
    setLang(next);
    setNote(null);
    try { localStorage.setItem("login-lang", next); } catch { /* storage unavailable */ }
  }

  async function safeJson(res: Response) {
    try { return await res.json(); } catch { return null; }
  }

  /** The approved notice for a refused attempt: wrong details (AU-01b), paused (AU-10), or the server's own words. */
  const noteFor = useCallback((status: number, data: { error?: string; errorAr?: string } | null, step: Mode | "mfa"): Note => {
    const server = (lang === "ar" ? data?.errorAr ?? data?.error : data?.error) ?? t.failed;
    if (status === 429) return { tone: "warning", title: t.pausedTitle, body: t.pausedBody, kind: "paused" };
    if (status === 401 && step !== "mfa" && data?.error === "Invalid credentials") {
      const title = step === "password" ? t.invalidPassword : step === "username_pin" ? t.invalidUserPin : t.invalidPin;
      return { tone: "danger", title, body: step === "password" ? t.hintPassword : t.hintPin, kind: "invalid" };
    }
    return { tone: "danger", title: server, kind: "other" };
  }, [lang, t]);

  // "refused": the server answered no; "offline": nothing reached it (the attempt is kept for «إعادة المحاولة»).
  const post = useCallback(async ({ url, body, step }: Attempt): Promise<"ok" | "refused" | "offline"> => {
    setNote(null);
    setLoading(true);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await safeJson(res);
      if (!res.ok) { setNote(noteFor(res.status, data, step)); return "refused"; }
      if (data?.mfaRequired && data.challenge) { setChallenge(data.challenge); setCode(""); return "ok"; }
      router.push(stationReturn(window.location.search) ?? data?.redirectTo ?? "/dashboard");
      return "ok";
    } catch {
      // AU-11: nothing reached the server.
      setNote({ tone: "danger", title: t.offlineTitle, body: t.offlineBody, kind: "offline" });
      setLastAttempt({ url, body, step });
      return "offline";
    } finally {
      setLoading(false);
    }
  }, [noteFor, router, t.offlineTitle, t.offlineBody]);

  const submitPin = useCallback(async (pinValue: string) => {
    if (!pinValue || loading) return;
    if (mode === "username_pin") {
      if (!username.trim()) return;
      const r = await post({ url: "/api/auth/login", body: { method: "username_pin", username: username.trim(), pin: pinValue }, step: "username_pin" });
      if (r === "refused") setPin("");
      return;
    }
    const r = await post({ url: "/api/auth/login", body: { method: "pin", pin: pinValue }, step: "pin" });
    if (r === "refused") setPin("");
  }, [loading, mode, username, post]);

  const submitPassword = useCallback(async () => {
    if (!username.trim() || !password || loading) return;
    // AU-01b: the refused password is cleared and focused again (the frame's focus ring); the username stays.
    const r = await post({ url: "/api/auth/login", body: { method: "password", username: username.trim(), password }, step: "password" });
    if (r === "refused") { setPassword(""); setRefocusPassword((n) => n + 1); }
  }, [username, password, loading, post]);

  const submitCode = useCallback(async () => {
    if (!challenge || !code.trim() || loading) return;
    const r = await post({ url: "/api/auth/mfa/login", body: { challenge, code: code.trim() }, step: "mfa" });
    if (r === "refused") setCode("");
  }, [challenge, code, loading, post]);

  useEffect(() => { if (refocusPassword) passwordRef.current?.focus(); }, [refocusPassword]);

  /** AU-11 «إعادة المحاولة»: the same request again, exactly as it was not sent. */
  async function retryLast() {
    if (!lastAttempt || loading) return;
    const r = await post(lastAttempt);
    if (r === "refused") { if (lastAttempt.step === "mfa") setCode(""); else if (lastAttempt.step !== "password") setPin(""); }
  }

  // Auto-submit on the last digit (PIN only, or username + PIN once a username is typed).
  useEffect(() => {
    if (challenge || mode === "password" || pin.length !== PIN_AUTO_SUBMIT_LENGTH) return;
    if (mode === "username_pin" && !username.trim()) return;
    const tm = setTimeout(() => submitPin(pin), 300);
    return () => clearTimeout(tm);
  }, [pin, mode, username, challenge, submitPin]);

  function pressKey(key: string) {
    if (loading) return;
    if (key === "backspace") { setPin((p) => p.slice(0, -1)); setNote(null); }
    else if (pin.length < PIN_MAX_LENGTH) setPin((p) => p + key);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setPin("");
    setPassword("");
    setNote(null);
  }

  const noteBox = note ? (
    <div role="alert" data-testid="login-error" data-kind={note.kind} className={`lg-note tone-${note.tone}${note.kind === "offline" ? " has-icon" : ""}`}>
      {note.kind === "offline" ? <WifiOff aria-hidden className="lg-note-ico" /> : null}
      <div className="lg-note-txt">
        <b>{note.title}</b>
        {note.body ? <span>{note.body}</span> : null}
      </div>
    </div>
  ) : null;

  // AU-01p: while a request is in flight the button turns neutral and the Sukun spinner sits beside it.
  const primary = (label: string, onClick: () => void, disabled: boolean, testId: string) => {
    const offline = note?.kind === "offline" && lastAttempt;
    const btn = (
      <button type="button" className="lg-btn" data-testid={testId} disabled={disabled || loading} aria-busy={loading || undefined}
        onClick={offline ? retryLast : onClick}>
        {loading ? t.verifying : offline ? t.retry : label}
      </button>
    );
    return loading ? <div className="lg-busyrow">{btn}<span className="lg-sukun" aria-hidden /></div> : btn;
  };

  const sub = mode === "password" ? t.subPassword : mode === "username_pin" ? t.subUserPin : t.subPin;
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "gap", "0", "backspace"];

  return (
    <div dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} className="d21 d21-login" data-testid="login-root">
      {/* IBM Plex and the Amiri brand face, self-hosted (public/fonts); no third-party font host. */}
      <link rel="stylesheet" precedence="default" href="/fonts/ibm-plex.css" />
      <link rel="stylesheet" precedence="default" href="/fonts/amiri.css" />

      <aside className="lg-brand" aria-label={t.system}>
        <div className="lg-panel">
          <span className="lg-ring r1" aria-hidden />
          <span className="lg-ring r2" aria-hidden />
          <span className="lg-node" aria-hidden />
          {/* The brand mark on the olive panel: the beige «ح» with the clay stroke (guideline v003). */}
          <span className="lg-mark"><BrandMark tone="olive" alt={lang === "ar" ? "حِقبة" : "Hiqbah"} /></span>
          <div className="lg-moment">
            <p className="q" lang="ar" dir="rtl">كل عملية بوضوح.<br />كل تفصيل بإتقان.</p>
            <i aria-hidden />
            <span>{t.system}</span>
          </div>
        </div>
      </aside>

      <div className="lg-langbar">
        <button type="button" onClick={toggleLang} data-testid="login-lang" className="lg-sbtn" lang={lang === "ar" ? "en" : "ar"}>{t.lang}</button>
      </div>

      {/* D-P1-7: the sign-in form is the page's main landmark. */}
      <main className="lg-col">
        {/* Both languages at once: whoever is in front of the screen reads it, whatever the toggle. */}
        {expired ? (
          <div role="status" data-testid="login-session-expired" className="lg-note tone-warning">
            <div className="lg-note-txt">
              <b lang="ar" dir="rtl">{SESSION_EXPIRED_AR}</b>
              <span lang="en" dir="ltr">{SESSION_EXPIRED_EN}</span>
            </div>
          </div>
        ) : null}
        {/* Phase 1 is desktop-first: below 1280 px only, in flow above the form (never over it). */}
        <DesktopRecommendedNotice lang={lang} />
        {challenge ? (
          <div className="lg-form" data-testid="login-mfa">
            <div className="lg-head">
              <h1>{t.mfaTitle}</h1>
              <p>{t.mfaHint}</p>
            </div>
            {noteBox}
            <div className="lg-fields">
              <div className="lg-field">
                <label htmlFor="mfa-code">{t.mfaCode}</label>
                <div className="lg-input">
                  <input id="mfa-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitCode()} inputMode="text" autoComplete="one-time-code" autoFocus placeholder="123456" />
                </div>
              </div>
            </div>
            {primary(t.verify, submitCode, !code.trim(), "login-submit")}
            <button type="button" className="lg-sbtn" onClick={() => { setChallenge(null); setCode(""); setPin(""); setNote(null); }}>{t.back}</button>
          </div>
        ) : (
          <div className="lg-form">
            <div className="lg-head">
              <h1>{t.title}</h1>
              <p>{sub}</p>
            </div>
            {noteBox}

            {/* SIMPLE MODE: the PIN methods' tabs are not rendered (code kept; see SHOW_PIN_SIGN_IN). */}
            {SHOW_PIN_SIGN_IN ? (
              <div role="tablist" aria-label={t.modes} className="lg-seg">
                {([["pin", t.modePin], ["username_pin", t.modeUserPin], ["password", t.modePassword]] as [Mode, string][]).map(([m, label]) => (
                  <button key={m} role="tab" aria-selected={mode === m} data-testid={`login-mode-${m}`} type="button" onClick={() => switchMode(m)} title={label}>{label}</button>
                ))}
              </div>
            ) : null}

            {mode !== "pin" ? (
              <div className="lg-fields">
                <div className="lg-field">
                  <label htmlFor="login-username">{t.username}</label>
                  <div className="lg-input">
                    <input id="login-username" dir="ltr" type="text" value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === "Enter" && mode === "password" && submitPassword()} placeholder={t.usernamePh} autoCapitalize="none" autoComplete="username" />
                  </div>
                </div>
                {mode === "password" ? (
                  <div className="lg-field">
                    <label htmlFor="login-password">{t.password}</label>
                    <div className="lg-input">
                      <input ref={passwordRef} id="login-password" dir="ltr" type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitPassword()} autoComplete="current-password" />
                      <button type="button" className="lg-show" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? t.hideAria : t.showAria} aria-pressed={showPassword} aria-controls="login-password">
                        {showPassword ? t.hide : t.show}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {mode === "password" ? (
              primary(t.signIn, submitPassword, false, "login-submit")
            ) : (
              <>
                <div className="lg-pin">
                  <span className="lg-pinlabel" id="pin-label">{t.enterPin}</span>
                  <div className="lg-dots" dir="ltr" data-testid="pin-dots" role="status" aria-labelledby="pin-label" aria-label={t.digits(pin.length)}>
                    {Array.from({ length: PIN_LENGTH }).map((_, i) => <i key={i} className={i < pin.length ? "on" : undefined} />)}
                  </div>
                  <div dir="ltr" className="lg-keypad grid">
                    {keys.map((key) => {
                      if (key === "gap") return <span key="gap" className="lg-key-gap" aria-hidden />;
                      if (key === "backspace") {
                        return (
                          <button key="backspace" type="button" className="lg-key is-text" aria-label={t.del} onClick={() => pressKey("backspace")} disabled={pin.length === 0 || loading}>
                            <span dir={lang === "ar" ? "rtl" : "ltr"}>{t.del}</span>
                          </button>
                        );
                      }
                      return <button key={key} type="button" className="lg-key" onClick={() => pressKey(key)} disabled={loading}>{key}</button>;
                    })}
                  </div>
                </div>
                {primary(t.signIn, () => submitPin(pin), pin.length < PIN_LENGTH || (mode === "username_pin" && !username.trim()), "login-submit")}
              </>
            )}

            <button type="button" className="lg-sbtn" aria-expanded={recover} aria-controls="login-recover" onClick={() => setRecover((v) => !v)}>{t.forgot}</button>
            {recover ? (
              <div id="login-recover" className="lg-note tone-info" data-testid="login-recover">
                <b>{t.recoverTitle}</b>
                <span>{t.recoverBody}</span>
              </div>
            ) : null}
          </div>
        )}
        {/* SIMPLE MODE: no "privileged accounts use username + PIN" note while the PIN methods are hidden. */}
        {SHOW_PIN_SIGN_IN ? <p className="lg-foot">{t.privNote}</p> : null}
      </main>
    </div>
  );
}
