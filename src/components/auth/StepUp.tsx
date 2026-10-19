"use client";

// Owner security decision (16 Oct) — step-up. Sensitive actions (payroll approve / record
// payment / cancel after approval, permission and credential decisions, identity decisions,
// MFA resets) answer 401 REAUTH_REQUIRED when the session's last strong authentication is
// older than 10 minutes. This provider catches that answer for every fetch in the dashboard,
// asks the user to confirm (username for privileged accounts, PIN or password, and the
// verification code when two-step verification is on), then retries the request ONCE.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Delete, ShieldCheck } from "lucide-react";
import { PIN_LENGTH } from "@/lib/pin-policy";
import { SHOW_PIN_SIGN_IN } from "@/lib/simple-mode";
import { isEndedSession, SESSION_EXPIRED_LOGIN } from "@/lib/session-expired";

const T = {
  ar: { title: "تأكيد الهوية", hint: "هذا الإجراء حساس. أكّد هويتك للمتابعة.", username: "اسم المستخدم", pin: "الرمز", password: "كلمة المرور", usePassword: "استخدم كلمة المرور", usePin: "استخدم الرمز", code: "رمز التحقق (6 أرقام أو رمز استرداد)", confirm: "تأكيد", cancel: "إلغاء", failed: "بيانات التأكيد غير صحيحة.", busy: "جارٍ التأكيد…" },
  en: { title: "Confirm it's you", hint: "This action is sensitive. Confirm your identity to continue.", username: "Username", pin: "PIN", password: "Password", usePassword: "Use password", usePin: "Use PIN", code: "Verification code (6 digits or a recovery code)", confirm: "Confirm", cancel: "Cancel", failed: "The confirmation is not valid.", busy: "Confirming…" },
} as const;

type Pending = { resolve: (ok: boolean) => void };
const Ctx = createContext<{ requestStepUp: (opts?: { pinOnly?: boolean }) => Promise<boolean> }>({ requestStepUp: async () => false });
export const useStepUp = () => useContext(Ctx);

export function StepUpProvider({ lang, privileged, children }: { lang: "ar" | "en"; privileged: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mfa, setMfa] = useState(false);
  // Owner decision 4: a privileged stock change answers `factor: "PIN"` — only a PIN step-up counts.
  const [pinOnly, setPinOnly] = useState(false);
  const pending = useRef<Pending[]>([]);
  const inflight = useRef<Promise<boolean> | null>(null);

  const requestStepUp = useCallback((opts?: { pinOnly?: boolean }) => {
    if (inflight.current) return inflight.current;
    setPinOnly(!!opts?.pinOnly);
    const p = new Promise<boolean>((resolve) => {
      pending.current.push({ resolve });
      fetch("/api/auth/mfa").then((r) => (r.ok ? r.json() : null)).then((s) => setMfa(!!s?.enrolled)).catch(() => setMfa(false)).finally(() => setOpen(true));
    });
    inflight.current = p.finally(() => { inflight.current = null; });
    return inflight.current;
  }, []);

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    const list = pending.current;
    pending.current = [];
    list.forEach((x) => x.resolve(ok));
  }, []);

  // One wrapper around window.fetch for the dashboard: a 401 REAUTH_REQUIRED from our own API
  // opens the dialog and, once confirmed, the same request is sent again.
  useEffect(() => {
    const original = window.fetch;
    const wrapped: typeof fetch = async (input, init) => {
      const res = await original(input, init);
      if (res.status !== 401) return res;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = await res.clone().json().catch(() => null);
      // The session itself ended (idle, absolute deadline, logout, revocation): leave for the
      // sign-in screen, which says so in both languages. Full navigation: no page state survives.
      if (isEndedSession(res.status, url, body, window.location.origin)) {
        window.location.replace(SESSION_EXPIRED_LOGIN);
        return res;
      }
      if (url.includes("/api/auth/")) return res;
      if (body?.code !== "REAUTH_REQUIRED") return res;
      const ok = await requestStepUp({ pinOnly: body?.factor === "PIN" });
      return ok ? original(input, init) : res;
    };
    window.fetch = wrapped;
    return () => { if (window.fetch === wrapped) window.fetch = original; };
  }, [requestStepUp]);

  return (
    <Ctx value={{ requestStepUp }}>
      {children}
      {open && <StepUpDialog lang={lang} privileged={privileged} mfa={mfa} pinOnly={pinOnly} onDone={finish} />}
    </Ctx>
  );
}

function StepUpDialog({ lang, privileged, mfa, pinOnly, onDone }: { lang: "ar" | "en"; privileged: boolean; mfa: boolean; pinOnly: boolean; onDone: (ok: boolean) => void }) {
  const t = T[lang];
  const [username, setUsername] = useState("");
  // SIMPLE MODE: with the PIN sign-in methods hidden, the step-up asks for the password first.
  const [usePassword, setUsePassword] = useState(!SHOW_PIN_SIGN_IN && !pinOnly);
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  const ready = (!privileged || username.trim()) && (usePassword ? !!password : pin.length === PIN_LENGTH) && (!mfa || code.trim());
  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/reauth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(privileged ? { username: username.trim() } : {}), ...(usePassword ? { password } : { pin }), ...(mfa ? { code: code.trim() } : {}) }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError((lang === "ar" ? data?.error : data?.errorEn ?? data?.error) ?? t.failed); setPin(""); setCode(""); return; }
      onDone(true);
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange outline-none text-sm";
  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-charcoal/50 p-0 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="stepup-title" data-testid="step-up-dialog" dir={lang === "ar" ? "rtl" : "ltr"}>
      <div className="w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck size={20} className="text-orange" />
          <h2 id="stepup-title" className="font-bold text-charcoal">{t.title}</h2>
        </div>
        <p className="text-sm text-brown/70 mb-4">{t.hint}</p>
        {privileged && (
          <label className="block mb-3">
            <span className="block text-xs font-bold text-brown mb-1">{t.username}</span>
            <input dir="ltr" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoComplete="username" className={input} data-testid="step-up-username" />
          </label>
        )}
        {usePassword ? (
          <label className="block mb-3">
            <span className="block text-xs font-bold text-brown mb-1">{t.password}</span>
            <input dir="ltr" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoComplete="current-password" className={input} />
          </label>
        ) : (
          <div className="mb-3">
            <span className="block text-xs font-bold text-brown mb-1">{t.pin}</span>
            <div className="flex items-center justify-center gap-3 py-3 bg-cream rounded-xl border-2 border-border mb-2 min-h-[48px]" data-testid="step-up-dots">
              {Array.from({ length: pin.length }).map((_, i) => <span key={i} className="w-3 h-3 rounded-full bg-charcoal" />)}
            </div>
            <div dir="ltr" className="grid grid-cols-3 gap-2 place-items-center">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"].map((k, i) =>
                k === "" ? <span key={i} /> : k === "del" ? (
                  <button key={i} type="button" aria-label="Backspace" onClick={() => setPin((p) => p.slice(0, -1))} className="w-12 h-12 rounded-full flex items-center justify-center text-charcoal hover:bg-cream"><Delete size={18} /></button>
                ) : (
                  <button key={i} type="button" onClick={() => setPin((p) => (p.length < PIN_LENGTH ? p + k : p))} className="w-12 h-12 rounded-full border-2 border-border text-lg font-bold text-charcoal active:bg-cream">{k}</button>
                ),
              )}
            </div>
          </div>
        )}
        {!pinOnly && <button type="button" onClick={() => { setUsePassword((v) => !v); setError(""); }} className="text-xs text-brown/60 hover:text-orange mb-3">{usePassword ? t.usePin : t.usePassword}</button>}
        {mfa && (
          <label className="block mb-3">
            <span className="block text-xs font-bold text-brown mb-1">{t.code}</span>
            <input dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoComplete="one-time-code" className={`${input} text-center tracking-[3px]`} data-testid="step-up-code" />
          </label>
        )}
        {error && <div role="alert" className="bg-danger-bg text-danger px-3 py-2 rounded-xl text-sm font-semibold mb-3">{error}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={submit} disabled={!ready || busy} className="flex-1 py-2.5 bg-orange text-white font-bold rounded-xl disabled:opacity-40" data-testid="step-up-confirm">{busy ? t.busy : t.confirm}</button>
          <button type="button" onClick={() => onDone(false)} className="px-4 py-2.5 border-2 border-border rounded-xl text-sm font-semibold text-charcoal">{t.cancel}</button>
        </div>
      </div>
    </div>
  );
}
