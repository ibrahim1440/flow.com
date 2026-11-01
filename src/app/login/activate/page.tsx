"use client";

// «رابط تفعيل الحساب» (owner decision, 1 Nov 2026): the page a one-time WhatsApp link opens. The person sees whose
// account it is (name, username), chooses their own password twice, and is sent to the sign-in screen. Arabic first;
// the sign-in screen's look (Direction 2.1). The token is read from ?t= and sent only to /api/auth/activation.
import { Fragment, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/brand/BrandMark";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/password-policy";
import { taglineLines } from "@/lib/login-tagline";
import "@/components/shell/direction-2.1.css";
import "../login.css";
import { LoginLangContext, LoginTaglineContext } from "../lang-context";

type Info = { name: string; username: string; expiresAt: string };

export default function ActivatePage() {
  const router = useRouter();
  const savedLang = useContext(LoginLangContext);
  const tagline = useContext(LoginTaglineContext);
  const lang = savedLang === "en" ? "en" : "ar";
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  // Read once on the client (never rendered, so the server's null does not differ on hydration).
  const [token] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("t")));
  const [info, setInfo] = useState<Info | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    // The token leaves the address bar (and the browser history) as soon as it is read. A missing token is answered
    // by the server like any invalid one.
    window.history.replaceState(null, "", "/login/activate");
    fetch(`/api/auth/activation?t=${encodeURIComponent(token ?? "")}`, { cache: "no-store" }).then(async (r) => {
      const b = await r.json().catch(() => ({}));
      if (r.ok) setInfo(b as Info); else setBad(lang === "ar" ? b.error : b.errorEn || b.error);
    }).catch(() => setBad(L("تعذّر الاتصال بالخادم.", "Could not reach the server.")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setErr(null);
    if (pw.length < PASSWORD_MIN) return setErr(L(`كلمة المرور ${PASSWORD_MIN} أحرف على الأقل.`, `At least ${PASSWORD_MIN} characters.`));
    if (pw !== pw2) return setErr(L("كلمتا المرور غير متطابقتين.", "The two passwords do not match."));
    setBusy(true);
    try {
      const r = await fetch("/api/auth/activation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password: pw }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(lang === "ar" ? b.error : b.errorEn || b.error); return; }
      setDone(b.username);
    } catch {
      setErr(L("تعذّر الاتصال بالخادم.", "Could not reach the server."));
    } finally { setBusy(false); }
  };

  return (
    <div dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} className="d21 d21-login" data-testid="activate-root">
      <link rel="stylesheet" precedence="default" href="/fonts/ibm-plex.css" />
      <link rel="stylesheet" precedence="default" href="/fonts/amiri.css" />
      <aside className="lg-brand" aria-label={L("حِقبة", "Hiqbah")}>
        <div className="lg-panel">
          <span className="lg-ring r1" aria-hidden /><span className="lg-ring r2" aria-hidden /><span className="lg-node" aria-hidden />
          <span className="lg-mark"><BrandMark tone="olive" alt={L("حِقبة", "Hiqbah")} /></span>
          <div className="lg-moment">
            <p className="q">{taglineLines(tagline[lang]).map((line, i) => <Fragment key={i}>{i > 0 ? <br /> : null}{line}</Fragment>)}</p>
          </div>
        </div>
      </aside>
      <main className="lg-col">
        <div className="lg-form">
          {done ? (
            <>
              <div className="lg-head"><h1>{L("تم تفعيل حسابك", "Your account is ready")}</h1><p>{L(`ادخل الحين باسم المستخدم ${done} وكلمة المرور اللي اخترتها.`, `Sign in now as ${done} with the password you chose.`)}</p></div>
              <button type="button" className="lg-btn" onClick={() => router.push("/login")} data-testid="activate-go-login">{L("تسجيل الدخول", "Sign in")}</button>
            </>
          ) : bad ? (
            <>
              <div className="lg-head"><h1>{L("الرابط غير صالح", "This link is not valid")}</h1></div>
              <div role="alert" className="lg-note tone-danger" data-testid="activate-bad"><div className="lg-note-txt">{bad}</div></div>
              <button type="button" className="lg-sbtn" onClick={() => router.push("/login")}>{L("صفحة الدخول", "Sign-in page")}</button>
            </>
          ) : !info ? (
            <p role="status">{L("جارٍ التحقق من الرابط…", "Checking the link…")}</p>
          ) : (
            <>
              <div className="lg-head">
                <h1>{L(`أهلًا ${info.name}`, `Welcome, ${info.name}`)}</h1>
                <p>{L("اختر كلمة مرور لحسابك. ما أحد غيرك يعرفها.", "Choose a password for your account. Nobody else will know it.")}</p>
              </div>
              {err ? <div role="alert" className="lg-note tone-danger" data-testid="activate-error"><div className="lg-note-txt">{err}</div></div> : null}
              <div className="lg-fields">
                <div className="lg-field">
                  <label htmlFor="act-user">{L("اسم المستخدم", "Username")}</label>
                  <div className="lg-input"><input id="act-user" dir="ltr" value={info.username} readOnly autoComplete="username" /></div>
                </div>
                <div className="lg-field">
                  <label htmlFor="act-pw">{L("كلمة المرور الجديدة", "New password")}</label>
                  <div className="lg-input"><input id="act-pw" dir="ltr" type={show ? "text" : "password"} value={pw} maxLength={PASSWORD_MAX} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus data-testid="activate-pw" /></div>
                </div>
                <div className="lg-field">
                  <label htmlFor="act-pw2">{L("أعد كتابتها", "Type it again")}</label>
                  <div className="lg-input"><input id="act-pw2" dir="ltr" type={show ? "text" : "password"} value={pw2} maxLength={PASSWORD_MAX} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoComplete="new-password" data-testid="activate-pw2" /></div>
                </div>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> {L("إظهار كلمة المرور", "Show password")}</label>
                <p style={{ fontSize: 13, margin: 0, opacity: 0.75 }}>{L(`${PASSWORD_MIN} أحرف على الأقل، ولا تكون نفس اسم المستخدم.`, `At least ${PASSWORD_MIN} characters, not your username.`)}</p>
              </div>
              <button type="button" className="lg-btn" disabled={busy || !pw || !pw2} onClick={submit} data-testid="activate-submit">{busy ? L("جارٍ الحفظ…", "Saving…") : L("تفعيل الحساب", "Activate my account")}</button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
