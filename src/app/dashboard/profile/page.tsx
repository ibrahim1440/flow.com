"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "@/app/dashboard/user-context";
import { PIN_LENGTH } from "@/lib/pin-policy";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/password-policy";
import { MfaEnrollment } from "@/components/auth/MfaEnrollment";
import { ROLE_LABELS, ROLE_LABELS_AR } from "@/lib/auth-shared";
import { Btn, Dot, Field, Notice, OpsRoot, Tabs, OpsError, OpsLoading, useL, type Tone } from "@/components/ops/ui";
import { NotificationPrefs } from "@/components/notifications/NotificationPrefs";
import { Dialog } from "@/components/hr/ui";
import { useD21Title } from "@/components/shell/page-context";
import type { DeviceInfo } from "@/lib/auth/device";
import "./profile.css";

/**
 * «ملفي الشخصي» — the signed-in account's own page. Direction 2.1, UI batch 3, built on the
 * approved Figma frames for an account's profile and security (file 1JbZgpMqmPkUVne8ms9Ozz):
 *   · UR-02 «ملف المستخدم — نظرة عامة» (597:759; 390: 613:7053) — identity header (avatar, name,
 *     username · status · role), the underline tabs, the account facts;
 *   · UR-02d «الأجهزة والجلسات» (598:966) — «الجلسات النشطة» with «إنهاء الجلسة» per row and
 *     «إنهاء كل الجلسات» in the block header, and its footnote;
 *   · TD-11 «أجهزتي» (1440: 556:4350, 390: 551:3547) — the signed-in user's OWN devices table
 *     (الجهاز · الفئة · المنصة · آخر دخول ناجح · آخر نشاط · الدخول السريع · الحالة), «هذا الجهاز»,
 *     the header actions «سجل نشاط الدخول» / danger outline, and «النشاط الأخير»;
 *   · TD-12b «تأكيد إلغاء الثقة» (390: 552:3429, 1180: 555:4176) — the confirmation of an end action.
 * Data: GET /api/profile/security; DELETE /api/profile/sessions[/ref]; PUT /api/profile/password;
 * and the existing PATCH / PUT /api/profile (phone and language, PIN) and MFA enrolment.
 */

type Session = { ref: string; current: boolean; method: string; mfa: boolean; createdAt: string; lastSeenAt: string; expiresAt: string; device: DeviceInfo };
type Device = { ref: string; current: boolean; device: DeviceInfo; firstSeenAt: string; lastSignInAt: string | null; lastSignInMethod: string | null; lastSeenAt: string; liveSessions: number };
type Activity = { at: string; action: string; result: string; reasonCode: string | null; device: DeviceInfo };
type SignIn = { at: string; method: string; device: DeviceInfo } | null;
type Security = {
  account: { name: string; username: string | null; role: string; createdAt: string; hasPassword: boolean; passwordChangedAt: string | null; pinChangedAt: string | null; mfaEnrolledAt: string | null; phoneNumber: string; preferredLanguage: "ar" | "en"; whatsappLanguage?: "ar" | "en" | null; pinResetRequired?: boolean };
  currentSignIn: SignIn; previousSignIn: SignIn;
  sessions: Session[]; devices: Device[]; activity: Activity[]; activityMore: boolean;
};
type TabKey = "overview" | "security" | "devices" | "activity" | "notifications";
const TABS: TabKey[] = ["overview", "security", "devices", "activity", "notifications"];
type Msg = { ok: boolean; text: string } | null;

/** «اليوم 10:42», «أمس 08:02», «5 أكتوبر 18:55», «20/09/2026» — the frames' date forms, Latin digits. */
function useWhen() {
  const { lang } = useI18n();
  return useCallback((iso: string | null | undefined, opts: { time?: boolean } = {}) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const ar = lang === "ar";
    const loc = ar ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB";
    const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    const time = opts.time !== false;
    const today = new Date();
    const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
    const yest = new Date(today.getTime() - 86400000);
    if (day(d) === day(today)) return time ? `${ar ? "اليوم" : "Today"} ${hm}` : ar ? "اليوم" : "Today";
    if (day(d) === day(yest)) return time ? `${ar ? "أمس" : "Yesterday"} ${hm}` : ar ? "أمس" : "Yesterday";
    if (d.getFullYear() === today.getFullYear()) {
      const dm = d.toLocaleDateString(loc, { day: "numeric", month: "long" });
      return time ? `${dm} ${hm}` : dm;
    }
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
  }, [lang]);
}

export default function ProfilePage() {
  const { t, lang, switcher } = useI18n();
  const L = useL();
  const ar = lang === "ar";
  const user = useUser();
  const when = useWhen();
  const router = useRouter();
  const params = useSearchParams();
  const tabParam = params.get("tab") as TabKey | null;
  const [tab, setTabState] = useState<TabKey>(tabParam && TABS.includes(tabParam) ? tabParam : "overview");
  const setTab = (k: TabKey) => {
    setTabState(k);
    router.replace(k === "overview" ? "/dashboard/profile" : `/dashboard/profile?tab=${k}`, { scroll: false });
  };

  const [data, setData] = useState<Security | null>(null);
  const [loadError, setLoadError] = useState(false);
  const activityN = tab === "activity" ? 50 : 6;

  // ── Preferences (phone, language): same request and messages as before ───────────────────
  const [phoneNumber, setPhoneNumber] = useState("");
  const [preferredLanguage, setPreferredLanguage] = useState<"ar" | "en">(ar ? "ar" : "en");
  // Owner language decision 3: the language automation WhatsApp messages reach me in.
  const [waLang, setWaLang] = useState<"system" | "ar" | "en">("system");
  const prefsLoaded = useRef(false);
  const [infoSaving, setInfoSaving] = useState(false);
  const [infoMsg, setInfoMsg] = useState<Msg>(null);

  const load = useCallback(() => {
    return fetch(`/api/profile/security?activity=${activityN}`, { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<Security>; })
      .then((d) => {
        setData(d);
        setLoadError(false);
        // The form starts from the saved values once; a later reload never overwrites typing.
        if (!prefsLoaded.current) {
          prefsLoaded.current = true;
          setPhoneNumber(d.account.phoneNumber ?? "");
          setPreferredLanguage(d.account.preferredLanguage);
          setWaLang(d.account.whatsappLanguage ?? "system");
        }
      })
      .catch(() => setLoadError(true));
  }, [activityN]);
  useEffect(() => { void load(); }, [load]);
  // The header's quick switch changed the saved language while this form was open: the form
  // follows it, so saving the phone number afterwards never puts the old language back.
  const [seenLang, setSeenLang] = useState(lang);
  if (seenLang !== lang) { setSeenLang(lang); setPreferredLanguage(lang === "en" ? "en" : "ar"); }

  useD21Title(t("myProfile"));

  async function saveInfo(e: React.FormEvent) {
    e.preventDefault();
    setInfoSaving(true);
    setInfoMsg(null);
    try {
      const res = await fetch("/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phoneNumber, preferredLanguage, whatsappLanguage: waLang === "system" ? null : waLang }) });
      const text = await res.text();
      let body: { error?: string } = {};
      try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
      if (!res.ok) throw new Error(body.error ?? t("error"));
      setInfoMsg({ ok: true, text: t("profileSaved") });
      // The saved language applies in place (the quick switch's path: same URL, no reload); a
      // screen without the switch falls back to the full reload it always did.
      if (preferredLanguage !== lang) {
        if (switcher) setTimeout(() => switcher.apply(preferredLanguage), 600);
        else setTimeout(() => window.location.reload(), 600);
      }
    } catch (err: unknown) {
      setInfoMsg({ ok: false, text: err instanceof Error ? err.message : t("error") });
    } finally {
      setInfoSaving(false);
    }
  }

  // ── «رمز المحطة» (Workstations W2): the existing self-set PIN flow, re-pointed to the station
  // PIN (PUT /api/profile/station-pin). Changing it needs the current station PIN; the first one
  // (or after the administrator's reset, UR-04) needs a recent password step-up — the server answers
  // 401 REAUTH_REQUIRED and the dashboard's step-up dialog asks for the password, then retries.
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [pinSaving, setPinSaving] = useState(false);
  const [pinMsg, setPinMsg] = useState<Msg>(null);
  const [stationPin, setStationPin] = useState<{ set: boolean; setAt: string | null; locked: boolean; stations: string[]; admin: boolean } | null>(null);
  const loadStationPin = useCallback(() => fetch("/api/profile/station-pin", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => setStationPin(d)).catch(() => setStationPin(null)), []);
  useEffect(() => { void loadStationPin(); }, [loadStationPin]);
  async function savePin(e: React.FormEvent) {
    e.preventDefault();
    setPinMsg(null);
    if (newPin !== confirmPin) { setPinMsg({ ok: false, text: t("pinMismatch") }); return; }
    setPinSaving(true);
    try {
      const res = await fetch("/api/profile/station-pin", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(stationPin?.set ? { currentPin } : {}), newPin }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((ar ? body.error : body.errorEn ?? body.error) ?? t("error"));
      setPinMsg({ ok: true, text: L("حُفظ رمز المحطة. استخدمه على جهاز المحطة بعد اختيار اسمك.", "The station PIN is saved. Use it at the station device after choosing your name.") });
      setCurrentPin(""); setNewPin(""); setConfirmPin("");
      void loadStationPin();
      load();
    } catch (err: unknown) {
      setPinMsg({ ok: false, text: err instanceof Error ? err.message : t("error") });
    } finally {
      setPinSaving(false);
    }
  }

  // ── Password change ──────────────────────────────────────────────────────────────────────
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confPw, setConfPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<Msg>(null);
  const pwShort = !!newPw && newPw.length < PASSWORD_MIN;
  const pwMismatch = !!confPw && confPw !== newPw;
  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    if (pwShort || pwMismatch) return;
    setPwSaving(true);
    try {
      const res = await fetch("/api/profile/password", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: curPw, newPassword: newPw }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((ar ? body.error : body.errorEn ?? body.error) ?? t("error"));
      const n = Number(body.otherSessionsEnded ?? 0);
      setPwMsg({ ok: true, text: n > 0 ? L(`تغيّرت كلمة المرور. أُنهيت جلساتك الأخرى (${n}): ادخل بكلمة المرور الجديدة على أجهزتك الأخرى.`, `Password changed. Your other sessions (${n}) were ended: sign in with the new password on your other devices.`) : L("تغيّرت كلمة المرور.", "Password changed.") });
      setCurPw(""); setNewPw(""); setConfPw("");
      load();
    } catch (err: unknown) {
      setPwMsg({ ok: false, text: err instanceof Error ? err.message : t("error") });
    } finally {
      setPwSaving(false);
    }
  }

  // ── Ending sessions (confirmed first, TD-12b; the step-up dialog asks for the password) ───
  const [confirm, setConfirm] = useState<{ kind: "one"; s: Session } | { kind: "others" } | null>(null);
  const [ending, setEnding] = useState(false);
  const [endMsg, setEndMsg] = useState<Msg>(null);
  async function doEnd() {
    if (!confirm) return;
    setEnding(true);
    setEndMsg(null);
    try {
      const res = await fetch(confirm.kind === "one" ? `/api/profile/sessions/${confirm.s.ref}` : "/api/profile/sessions", { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((ar ? body.error : body.errorEn ?? body.error) ?? t("error"));
      const n = Number(body.ended ?? 0);
      setEndMsg({ ok: true, text: confirm.kind === "one" ? L("أُنهيت الجلسة.", "The session was ended.") : n > 0 ? L(`أُنهيت جلساتك الأخرى (${n}).`, `Your other sessions were ended (${n}).`) : L("لا توجد جلسات أخرى.", "No other sessions.") });
      setConfirm(null);
      load();
    } catch (err: unknown) {
      setEndMsg({ ok: false, text: err instanceof Error ? err.message : t("error") });
      setConfirm(null);
    } finally {
      setEnding(false);
    }
  }

  // ── Labels ───────────────────────────────────────────────────────────────────────────────
  const methodLabel = (m: string | null | undefined) =>
    m === "PASSWORD" ? L("كلمة المرور", "Password") : m === "USERNAME_PIN" ? L("اسم المستخدم والرمز", "Username + PIN") : m === "PIN" ? L("الرمز", "PIN") : "—";
  const deviceName = (d: DeviceInfo) => (d.browser ? `${L("متصفح ", "")}${d.browser}${d.os ? ` · ${d.os}` : ""}` : d.os ?? L("متصفح غير معروف", "Unknown browser"));
  const categoryLabel = (d: DeviceInfo) => (d.category === "phone" ? L("هاتف", "Phone") : d.category === "tablet" ? L("جهاز لوحي", "Tablet") : L("حاسوب", "Computer"));
  const sessionName = (d: DeviceInfo) => `${L("ويب", "Web")}${d.browser ? ` · ${d.browser}` : ""}${d.os ? ` ${L("على", "on")} ${d.os}` : ""}`;
  const activityText = (a: Activity): [string, Tone] => {
    const dev = a.device.browser ? ` · ${deviceName(a.device)}` : "";
    const ok = a.result === "SUCCESS";
    switch (a.action) {
      case "SIGN_IN":
        if (ok) return [`${L("دخول ب", "Signed in with ")}${a.reasonCode === "PASSWORD" ? L("كلمة المرور", "password") : a.reasonCode === "USERNAME_PIN" ? L("اسم المستخدم والرمز", "username + PIN") : L("الرمز", "PIN")}${dev}`, "success"];
        if (a.result === "FAILURE") return [a.reasonCode === "PASSWORD" ? L("كلمة مرور غير صحيحة", "Wrong password") : L("رمز غير صحيح", "Wrong PIN"), "warning"];
        return [L("رُفض الدخول", "Sign-in refused"), "warning"];
      case "MFA_SIGN_IN": return ok ? [L("دخول بالتحقق بخطوتين", "Signed in with two-step verification"), "success"] : [L("رمز تحقق غير صحيح", "Wrong verification code"), "warning"];
      case "MFA_RECOVERY_CODE_USED": return [L("استُخدم رمز استرداد", "A recovery code was used"), "warning"];
      case "STEP_UP": return ok ? [L("تأكيد الهوية", "Identity confirmed"), "success"] : [L("تأكيد هوية غير صحيح", "Identity confirmation failed"), "warning"];
      case "SIGN_OUT": return [`${L("تسجيل الخروج", "Signed out")}${dev}`, "neutral"];
      case "PRIVILEGED_PIN_ONLY_REFUSED": return [L("رُفض الدخول بالرمز وحده", "PIN-only sign-in refused"), "warning"];
      case "MFA_ENROLLED": return [L("فُعّل التحقق بخطوتين", "Two-step verification turned on"), "success"];
      case "SESSION_ENDED_SELF": return [L("أنهيت جلسة", "You ended a session"), "neutral"];
      case "OTHER_SESSIONS_ENDED_SELF": return [L("أنهيت جلساتك الأخرى", "You ended your other sessions"), "neutral"];
      case "PASSWORD_CHANGED_SELF": return [L("غيّرت كلمة المرور", "You changed your password"), "success"];
      case "PASSWORD_CHANGE_SELF": return [L("كلمة المرور الحالية غير صحيحة", "Wrong current password"), "warning"];
      default: return [a.action, "neutral"];
    }
  };

  const others = useMemo(() => (data?.sessions ?? []).filter((s) => !s.current).length, [data]);
  if (!user) return null;
  const role = (ar ? ROLE_LABELS_AR[user.role] : ROLE_LABELS[user.role]) ?? user.role;
  const initials = user.name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("");
  const msg = (m: Msg) => (m ? <Notice tone={m.ok ? "success" : "danger"}><span role={m.ok ? "status" : undefined}>{m.text}</span></Notice> : null);
  // Arabic number agreement: 1 «جلسة واحدة», 2 «جلستان», 3–10 «3 جلسات», 11+ «11 جلسة».
  const plural = (n: number, ar1: string, ar2: string, arN: string, arMany: string, en: string) =>
    ar ? (n === 1 ? ar1 : n === 2 ? ar2 : n >= 3 && n <= 10 ? `${n} ${arN}` : `${n} ${arMany}`) : `${n} ${en}${n === 1 ? "" : "s"}`;

  const secret = (id: string, label: string, value: string, set: (v: string) => void, extra: { pin?: boolean; error?: string | null; autoComplete?: string; minLength?: number } = {}) => (
    <Field label={label} error={extra.error ?? null}>
      <span className="pf-secret">
        <input
          id={id}
          type={shown[id] ? "text" : "password"}
          inputMode={extra.pin ? "numeric" : undefined}
          dir="ltr"
          value={value}
          onChange={(e) => set(extra.pin ? e.target.value.replace(/\D/g, "") : e.target.value)}
          maxLength={extra.pin ? PIN_LENGTH : PASSWORD_MAX}
          minLength={extra.minLength}
          autoComplete={extra.autoComplete ?? "off"}
          required
          aria-invalid={!!extra.error || undefined}
          className={`hr-input${extra.pin ? " pf-pin" : ""}`}
        />
        <button type="button" className="hr-btn is-ghost hr-iconbtn" onClick={() => setShown((s) => ({ ...s, [id]: !s[id] }))} aria-label={shown[id] ? L("إخفاء", "Hide") : L("إظهار", "Show")} aria-pressed={!!shown[id]}>
          {shown[id] ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
        </button>
      </span>
    </Field>
  );

  const block = (id: string, title: string, caption: ReactNode, action: ReactNode, children: ReactNode) => (
    <section className="pf-block" aria-labelledby={id}>
      <div className="pf-bhead">
        <h2 id={id}>{title}</h2>
        {caption ? <span className="pf-bcap">{caption}</span> : null}
        {action ? <span className="pf-bact">{action}</span> : null}
      </div>
      {children}
    </section>
  );

  const activityList = (rows: Activity[]) => (
    <ul className="pf-activity" data-testid="pf-activity">
      {rows.map((a, i) => {
        const [text, tone] = activityText(a);
        return (
          <li key={`${a.at}-${i}`}>
            <Dot tone={tone}>{text}</Dot>
            <time className="pf-when" dateTime={a.at}>{when(a.at)}</time>
          </li>
        );
      })}
    </ul>
  );
  const noActivity = <p className="hr-caption pf-empty">{L("لا يوجد نشاط مسجّل بعد.", "No activity recorded yet.")}</p>;

  const a = data?.account;
  const pwState = !a ? "" : !a.hasPassword ? L("غير معيّنة", "Not set") : a.passwordChangedAt ? `${L("غُيّرت في", "Changed on")} ${when(a.passwordChangedAt, { time: false })}` : L("معيّنة", "Set");
  const pinState = !stationPin ? "" : stationPin.locked ? L("مقفل على جهاز محطة", "Locked on a station device") : stationPin.set ? `${L("عُيّن في", "Set on")} ${when(stationPin.setAt!, { time: false })}` : L("غير معيّن", "Not set");
  const facts: [string, ReactNode][] = a ? [
    [L("الاسم المعروض", "Display name"), <bdi key="n">{a.name}</bdi>],
    [L("اسم المستخدم", "Username"), a.username ? <bdi key="u" dir="ltr" className="pf-latin">{a.username}</bdi> : "—"],
    [L("الدور", "Role"), role],
    [L("أُنشئ", "Created"), when(a.createdAt, { time: false })],
    [L("آخر دخول", "Last sign-in"), data?.previousSignIn ? `${when(data.previousSignIn.at)} · ${methodLabel(data.previousSignIn.method)} · ${L("ويب", "Web")}` : L("هذا أول دخول مسجّل", "This is the first recorded sign-in")],
    [L("كلمة المرور", "Password"), pwState],
    [L("التحقق بخطوتين", "Two-step verification"), a.mfaEnrolledAt ? <Dot key="m" tone="success">{L("مفعّل", "On")}</Dot> : <Dot key="m" tone="neutral">{L("غير مفعّل", "Off")}</Dot>],
    [L("رمز المحطة", "Station PIN"), pinState || "—"],
  ] : [];

  return (
    <OpsRoot>
      <div className="hr-page pf-page" data-testid="profile-page">
        {/* Identity header (UR-02 Page header): avatar, name, username · status · role; TD-11 actions. */}
        <header className="pf-header">
          <div className="pf-id">
            <span className="pf-avatar" aria-hidden>{initials}</span>
            <div className="pf-idtext">
              <h1 className="hr-title">{user.name}</h1>
              <div className="pf-meta">
                {a?.username ? <><bdi dir="ltr" className="pf-latin">{a.username}</bdi><i aria-hidden /></> : null}
                <Dot tone="success">{L("نشط", "Active")}</Dot>
                <i aria-hidden />
                <span>{role}</span>
                <i aria-hidden className="pf-hide-phone" />
                <span className="pf-hide-phone">{L("الحساب · الأمان", "Account · Security")}</span>
              </div>
            </div>
          </div>
          <div className="pf-actions">
            <Btn onClick={() => setTab("activity")} data-testid="pf-open-log">{L("سجل نشاط الدخول", "Sign-in activity")}</Btn>
            <Btn className="pf-danger" disabled={!data || others === 0} title={data && others === 0 ? L("لا توجد جلسات أخرى", "No other sessions") : undefined} onClick={() => setConfirm({ kind: "others" })} data-testid="pf-end-others">
              {L("إنهاء الجلسات الأخرى", "End other sessions")}
            </Btn>
          </div>
        </header>

        <Tabs<TabKey>
          label={L("أقسام الملف", "Profile sections")}
          value={tab}
          onChange={setTab}
          items={[
            { key: "overview", label: L("نظرة عامة", "Overview") },
            { key: "security", label: L("الأمان", "Security") },
            { key: "devices", label: L("الأجهزة والجلسات", "Devices & sessions"), count: data ? data.sessions.length : undefined },
            { key: "activity", label: L("سجل الدخول", "Sign-in log") },
            // feat/notifications: «التنبيهات» — the e-mail choice per category.
            { key: "notifications", label: L("التنبيهات", "Notifications") },
          ]}
        />

        {msg(endMsg)}
        {loadError && !data ? <OpsError message={L("تعذّر تحميل بيانات الحساب.", "Could not load your account.")} onRetry={load} /> : null}
        {!data && !loadError ? <OpsLoading rows={5} /> : null}

        {data && a && tab === "overview" ? (
          <div className="pf-tabbody" data-testid="pf-overview">
            <div className="pf-cols">
              <dl className="pf-props">
                {facts.map(([k, v]) => (
                  <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
                ))}
              </dl>
              <form onSubmit={saveInfo} className="pf-form" aria-labelledby="pf-prefs-h">
                <span className="pf-group" id="pf-prefs-h">{t("personalInfo")}</span>
                <Field label={t("phoneNumber")}>
                  <input type="tel" dir="auto" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder={t("phonePlaceholder")} className="hr-input pf-ltr" />
                </Field>
                <div className="hr-field">
                  <span className="hr-label" id="pf-lang">{t("language")}</span>
                  <span className="ops-seg pf-seg" role="group" aria-labelledby="pf-lang">
                    {(["ar", "en"] as const).map((lng) => (
                      <button key={lng} type="button" aria-pressed={preferredLanguage === lng} lang={lng} onClick={() => setPreferredLanguage(lng)}>
                        {lng === "ar" ? "العربية" : "English"}
                      </button>
                    ))}
                  </span>
                </div>
                <div className="hr-field">
                  <span className="hr-label" id="pf-walang">{L("لغة رسائل واتساب", "WhatsApp message language")}</span>
                  <span className="ops-seg pf-seg" role="group" aria-labelledby="pf-walang" data-testid="pf-walang">
                    {(["system", "ar", "en"] as const).map((v) => (
                      <button key={v} type="button" aria-pressed={waLang === v} lang={v === "system" ? undefined : v} onClick={() => setWaLang(v)} data-testid={`pf-walang-${v}`}>
                        {v === "system" ? L("حسب إعداد النظام", "As the system setting") : v === "ar" ? "العربية" : "English"}
                      </button>
                    ))}
                  </span>
                  <span className="hr-caption">{L("لرسائل الأتمتة التي تصلك على واتساب", "For the automation messages you receive on WhatsApp")}</span>
                </div>
                {msg(infoMsg)}
                <div className="pf-formacts">
                  <Btn type="submit" variant="primary" disabled={infoSaving}>{infoSaving ? t("saving") : t("save")}</Btn>
                </div>
              </form>
            </div>
            {block("pf-recent", L("النشاط الأخير", "Recent activity"), null, <button type="button" className="pf-link" onClick={() => setTab("activity")}>{L("السجل الكامل", "Full log")}</button>,
              data.activity.length ? activityList(data.activity) : noActivity)}
          </div>
        ) : null}

        {data && a && tab === "security" ? (
          <div className="pf-tabbody" data-testid="pf-security">
            <div className="pf-cols">
              {block("pf-pw-h", L("كلمة المرور", "Password"), a.hasPassword ? pwState : null, null,
                a.hasPassword ? (
                  <form onSubmit={savePassword} className="pf-form" data-testid="pf-password-form">
                    {secret("pf-cur-pw", L("كلمة المرور الحالية", "Current password"), curPw, setCurPw, { autoComplete: "current-password" })}
                    {secret("pf-new-pw", L("كلمة المرور الجديدة", "New password"), newPw, setNewPw, { autoComplete: "new-password", minLength: PASSWORD_MIN, error: pwShort ? L(`${PASSWORD_MIN} أحرف على الأقل.`, `At least ${PASSWORD_MIN} characters.`) : null })}
                    {secret("pf-conf-pw", L("تأكيد كلمة المرور", "Confirm password"), confPw, setConfPw, { autoComplete: "new-password", error: pwMismatch ? L("كلمتا المرور غير متطابقتين.", "The passwords do not match.") : null })}
                    <p className="hr-caption pf-note">{L("بعد التغيير تنتهي جلساتك على الأجهزة الأخرى، وتبقى هذه الجلسة.", "After the change your sessions on other devices end; this one stays.")}</p>
                    {msg(pwMsg)}
                    <div className="pf-formacts">
                      <Btn type="submit" variant="primary" disabled={pwSaving || pwShort || pwMismatch || !curPw || !newPw || !confPw} data-testid="pf-password-save">{pwSaving ? t("saving") : L("تغيير كلمة المرور", "Change password")}</Btn>
                    </div>
                  </form>
                ) : <Notice tone="info">{L("لا توجد كلمة مرور لهذا الحساب: يعيّنها مسؤول المستخدمين.", "This account has no password: an account editor sets it.")}</Notice>)}

              {block("pf-pin-h", L("رمز المحطة", "Station PIN"), pinState || null, null,
                stationPin?.admin ? <Notice tone="info">{L("حساب مدير المنشأة لا يدخل من أجهزة المحطات المشتركة، فلا يحتاج رمز محطة. يستخدم المحطة من متصفحه بحسابه.", "The administrator account does not sign in at shared station devices, so it needs no station PIN.")}</Notice> : (
                <form onSubmit={savePin} className="pf-form" data-testid="pf-pin-form">
                  <p className="hr-caption pf-note" data-testid="pf-station-pin-note">{L("رمز من 6 أرقام تدخله على جهاز المحطة بعد اختيار اسمك. لا يفتح النظام الرئيسي، ولا يراه المسؤول.", "Six digits you enter at the station device after choosing your name. It does not open the main system, and the administrator never sees it.")}{stationPin?.stations.length ? ` ${L("محطاتك:", "Your stations:")} ${stationPin.stations.join(L("، ", ", "))}.` : ""}</p>
                  {stationPin?.locked ? <Notice tone="warning">{L("رمزك مقفل على جهاز محطة بعد محاولات خاطئة. يعيد مسؤول النظام تفعيله.", "Your PIN is locked on a station device after wrong attempts. The administrator re-enables it.")}</Notice> : null}
                  {/* The first station PIN (or after an administrator's reset, UR-04): no current one — a password step-up confirms the person instead. */}
                  {stationPin && !stationPin.set
                    ? <p className="hr-caption pf-note" data-testid="pf-pin-reset">{L("لم تعيّن رمز المحطة بعد. عيّنه الآن؛ نطلب كلمة مرورك للتحقق من هويتك.", "You have not set a station PIN yet. Set it now; we ask for your password to confirm it is you.")}</p>
                    : secret("pf-current", L("رمز المحطة الحالي", "Current station PIN"), currentPin, setCurrentPin, { pin: true })}
                  {secret("pf-new", L("رمز المحطة الجديد", "New station PIN"), newPin, setNewPin, { pin: true, minLength: PIN_LENGTH })}
                  {secret("pf-confirm", t("confirmNewPin"), confirmPin, setConfirmPin, { pin: true, error: confirmPin && confirmPin !== newPin ? t("pinMismatch") : null })}
                  {msg(pinMsg)}
                  <div className="pf-formacts">
                    <Btn type="submit" variant="primary" disabled={pinSaving || !stationPin || newPin.length !== PIN_LENGTH || confirmPin !== newPin || (stationPin.set && currentPin.length !== PIN_LENGTH)} data-testid="pf-pin-save">{pinSaving ? t("saving") : stationPin?.set ? L("تغيير رمز المحطة", "Change station PIN") : L("تعيين رمز المحطة", "Set station PIN")}</Btn>
                  </div>
                </form>))}
            </div>
            <div id="mfa" className="pf-mfa"><MfaEnrollment lang={ar ? "ar" : "en"} onEnrolled={load} /></div>
          </div>
        ) : null}

        {data && tab === "devices" ? (
          <div className="pf-tabbody" data-testid="pf-devices">
            <p className="pf-lead">{L("الأجهزة التي دخلت منها خلال آخر 90 يومًا. الثقة لا تُمنح لمتصفح أو نظام لمجرد التعرف عليه: الدخول من المتصفح بكلمة المرور دائمًا.", "The devices you signed in from in the last 90 days. Trust is never given to a browser or system just because it is recognised: a browser always signs in with the password.")}</p>
            {block("pf-dev-h", L("أجهزتي", "My devices"), `${plural(data.devices.length, "جهاز واحد", "جهازان", "أجهزة", "جهازًا", "device")} · ${L("آخر 90 يومًا", "last 90 days")}`, null, (
              <>
                <div className="hr-tablewrap pf-wide">
                  <table className="hr-table pf-table" data-testid="pf-device-table">
                    <thead><tr>
                      <th>{L("الجهاز", "Device")}</th>
                      <th>{L("الفئة · المنصة", "Category · platform")}</th>
                      <th>{L("آخر دخول ناجح", "Last successful sign-in")}</th>
                      <th>{L("آخر نشاط", "Last activity")}</th>
                      <th>{L("الدخول السريع", "Quick sign-in")}</th>
                      <th>{L("الحالة", "Status")}</th>
                    </tr></thead>
                    <tbody>
                      {data.devices.map((d) => (
                        <tr key={d.ref} data-current={d.current || undefined}>
                          <td className="pf-two">
                            <div className="pf-devname">
                              <span className="pf-strong"><bdi>{deviceName(d.device)}</bdi></span>
                              {d.current ? <span className="pf-here"><Dot tone="info">{L("هذا الجهاز", "This device")}</Dot></span> : null}
                            </div>
                            <div className="pf-sub">{L("غير مسجّل · كلمة المرور فقط", "Not registered · password only")}</div>
                          </td>
                          <td>{categoryLabel(d.device)} · {L("متصفح ويب", "Web browser")}</td>
                          <td>{d.lastSignInAt ? `${when(d.lastSignInAt)} · ${methodLabel(d.lastSignInMethod)}` : "—"}</td>
                          <td>{when(d.lastSeenAt)}</td>
                          <td>—</td>
                          <td><Dot tone="neutral">{L("غير موثوق", "Not trusted")}</Dot></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="pf-rows pf-narrow" data-testid="pf-device-list">
                  {data.devices.map((d) => (
                    <li key={d.ref}>
                      <div className="pf-rowtop">
                        <span className="pf-strong"><bdi>{deviceName(d.device)}</bdi></span>
                        {d.current ? <span className="pf-here"><Dot tone="info">{L("هذا الجهاز", "This device")}</Dot></span> : null}
                        <span className="pf-push"><Dot tone="neutral">{L("غير موثوق", "Not trusted")}</Dot></span>
                      </div>
                      <div className="pf-sub"><span>{categoryLabel(d.device)} · {L("متصفح ويب", "Web browser")}</span>{d.lastSignInAt ? <span>{L("آخر دخول", "Last sign-in")} {when(d.lastSignInAt)} · {methodLabel(d.lastSignInMethod)}</span> : null}</div>
                    </li>
                  ))}
                </ul>
              </>
            ))}

            {block("pf-sess-h", L("الجلسات النشطة", "Active sessions"), `${plural(data.sessions.length, "جلسة واحدة", "جلستان", "جلسات", "جلسة", "session")} · ${L("تنتهي من الخادم فور الإنهاء", "ended on the server at once")}`,
              <button type="button" className="pf-link" disabled={others === 0} onClick={() => setConfirm({ kind: "others" })} data-testid="pf-end-others-link">{L("إنهاء كل الجلسات الأخرى", "End all other sessions")}</button>, (
              <>
                <div className="hr-tablewrap pf-wide">
                  <table className="hr-table pf-table" data-testid="pf-session-table">
                    <thead><tr>
                      <th>{L("الجلسة", "Session")}</th>
                      <th>{L("طريقة الدخول", "Sign-in method")}</th>
                      <th>{L("بدأت", "Started")}</th>
                      <th>{L("آخر نشاط", "Last activity")}</th>
                      <th><span className="hr-sr">{L("إجراء", "Action")}</span></th>
                    </tr></thead>
                    <tbody>
                      {data.sessions.map((s) => (
                        <tr key={s.ref} data-testid="pf-session-row" data-current={s.current || undefined}>
                          <td className="pf-strong"><bdi>{sessionName(s.device)}</bdi></td>
                          <td>{methodLabel(s.method)}{s.mfa ? L(" · تحقق بخطوتين", " · 2-step") : ""}</td>
                          <td>{when(s.createdAt)}</td>
                          <td>{when(s.lastSeenAt)}</td>
                          <td className="pf-act">{s.current ? <span className="pf-tag">{L("هذه الجلسة", "This session")}</span> : <Btn size="sm" onClick={() => setConfirm({ kind: "one", s })} data-testid="pf-end-session">{L("إنهاء الجلسة", "End session")}</Btn>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="pf-rows pf-narrow">
                  {data.sessions.map((s) => (
                    <li key={s.ref}>
                      <div className="pf-rowtop">
                        <span className="pf-strong"><bdi>{sessionName(s.device)}</bdi></span>
                        <span className="pf-push">{s.current ? <span className="pf-tag">{L("هذه الجلسة", "This session")}</span> : <Btn size="sm" onClick={() => setConfirm({ kind: "one", s })}>{L("إنهاء الجلسة", "End session")}</Btn>}</span>
                      </div>
                      <div className="pf-sub"><span>{methodLabel(s.method)}</span><span>{L("بدأت", "Started")} {when(s.createdAt)}</span><span>{L("آخر نشاط", "Last activity")} {when(s.lastSeenAt)}</span></div>
                    </li>
                  ))}
                </ul>
              </>
            ))}
            <p className="pf-foot">{L("كل إنهاء يتطلب تأكيد هويتك بكلمة المرور ويُسجَّل باسمك. تنتهي الجلسة بعد 4 ساعات دون نشاط، أو بعد 12 ساعة من الدخول.", "Every end needs you to confirm your identity with your password and is recorded under your name. A session ends after 4 hours without activity, or 12 hours after sign-in.")}</p>
          </div>
        ) : null}

        {tab === "notifications" ? <NotificationPrefs /> : null}

        {data && tab === "activity" ? (
          <div className="pf-tabbody" data-testid="pf-log">
            {block("pf-log-h", L("سجل نشاط الدخول", "Sign-in activity"), L("آخر 50 حدثًا: الدخول وتأكيد الهوية وتسجيل الخروج وتغييرات الأمان", "The last 50 events: sign-ins, identity confirmations, sign-outs and security changes"), null,
              data.activity.length ? activityList(data.activity) : noActivity)}
          </div>
        ) : null}
      </div>

      {/* TD-12b: what ending does, then the action. The step-up dialog asks for the password when needed. */}
      <Dialog
        open={!!confirm}
        onClose={() => { if (!ending) setConfirm(null); }}
        title={confirm?.kind === "one" ? L("إنهاء هذه الجلسة؟", "End this session?") : L("إنهاء كل الجلسات الأخرى؟", "End all other sessions?")}
        testId="pf-confirm"
        actions={<>
          <Btn variant="primary" className="pf-confirm-danger" busy={ending} onClick={doEnd} data-testid="pf-confirm-end">{confirm?.kind === "one" ? L("إنهاء الجلسة", "End session") : L("إنهاء الجلسات", "End sessions")}</Btn>
          <Btn variant="ghost" disabled={ending} onClick={() => setConfirm(null)}>{L("تراجع", "Cancel")}</Btn>
        </>}
      >
        {confirm?.kind === "one" ? <p className="pf-dlgname"><bdi>{sessionName(confirm.s.device)}</bdi> · {L("بدأت", "started")} {when(confirm.s.createdAt)}</p> : null}
        <ul className="pf-bullets">
          <li>{confirm?.kind === "one" ? L("تنتهي الجلسة على ذلك الجهاز فورًا.", "The session on that device ends at once.") : L(`تنتهي جلساتك على الأجهزة الأخرى فورًا (${others}).`, `Your sessions on other devices end at once (${others}).`)}</li>
          <li>{L("يلزم الدخول بكلمة المرور لأي استخدام قادم منه.", "Any later use there needs the password again.")}</li>
          <li>{L("تبقى هذه الجلسة.", "This session stays.")}</li>
        </ul>
        <p className="hr-caption" style={{ margin: 0 }}>{L("للتأكيد قد يُطلب منك إدخال كلمة المرور.", "You may be asked for your password to confirm.")}</p>
      </Dialog>
    </OpsRoot>
  );
}
