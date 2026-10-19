"use client";
// «المستخدمون والصلاحيات» (Figma Phase 8, page 596:2) — the pieces every screen of the area shares:
// the section header and its tabs (UR-01 / UR-05 / UR-12 «المستخدمون · الأدوار · أجهزة المحطات ·
// سجل الصلاحيات»), the tags and status words, Asia/Riyadh dates, the password confirmation drawn in
// every confirming dialog («كلمة مرورك», J-4) and the request helper. Direction 2.1 kit only.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Btn, Dot, Flag, OpsRoot } from "@/components/ops/ui";
import { useD21Crumbs, useD21Phone, useD21Title } from "@/components/shell/page-context";
import { initials } from "@/components/d21/labels";
import { useUser } from "../../user-context";
import { SettingsFrame } from "../../_components/tools-ui";
import "./users.css";

export type Lang = "ar" | "en";
export function useLangL() {
  const user = useUser();
  const lang: Lang = user?.preferredLanguage === "en" ? "en" : "ar";
  const L = useCallback((ar: string, en: string) => (lang === "ar" ? ar : en), [lang]);
  return { lang, ar: lang === "ar", L };
}

export type ApiResult<T> = { ok: boolean; status: number; data: T & { error?: string; errorEn?: string; code?: string } };
export async function api<T = Record<string, unknown>>(url: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const r = await fetch(url, { method: init.method ?? "GET", headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
export const errText = (d: { error?: string; errorEn?: string } | null | undefined, lang: Lang, fallback: string) => (lang === "en" ? d?.errorEn ?? d?.error : d?.error ?? d?.errorEn) ?? fallback;

// ── Dates: absolute, Asia/Riyadh, Latin digits (UR-12 «Asia/Riyadh») ─────────────────────────────
const TZ = "Asia/Riyadh";
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function parts(iso: string | Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), time: `${p.hour}:${p.minute}` };
}
const dayKey = (x: { y: number; m: number; d: number }) => x.y * 10000 + x.m * 100 + x.d;
/** «6 أكتوبر 2026» */
export function fmtDate(iso: string | Date | null | undefined, lang: Lang): string {
  if (!iso) return "—";
  const p = parts(iso);
  return lang === "ar" ? `${p.d} ${AR_MONTHS[p.m - 1]} ${p.y}` : `${p.d} ${EN_MONTHS[p.m - 1]} ${p.y}`;
}
/** «6 أكتوبر» (this year) or «6 أكتوبر 2025». */
export function fmtShort(iso: string | Date | null | undefined, lang: Lang): string {
  if (!iso) return "—";
  const p = parts(iso);
  const now = parts(new Date());
  const base = lang === "ar" ? `${p.d} ${AR_MONTHS[p.m - 1]}` : `${p.d} ${EN_MONTHS[p.m - 1]}`;
  return p.y === now.y ? base : `${base} ${p.y}`;
}
export const fmtTime = (iso: string | Date | null | undefined) => (iso ? parts(iso).time : "—");
/** «اليوم 09:30», «أمس 16:40», «5 أكتوبر 18:02» */
export function fmtWhen(iso: string | Date | null | undefined, lang: Lang): string {
  if (!iso) return "—";
  const p = parts(iso);
  const today = parts(new Date());
  const yest = parts(new Date(Date.now() - 86_400_000));
  if (dayKey(p) === dayKey(today)) return `${lang === "ar" ? "اليوم" : "Today"} ${p.time}`;
  if (dayKey(p) === dayKey(yest)) return `${lang === "ar" ? "أمس" : "Yesterday"} ${p.time}`;
  return `${fmtShort(iso, lang)} ${p.time}`;
}
/** A yyyy-mm-dd date input value → the end of that day in Asia/Riyadh (an exception runs through the day). */
export function endOfDayRiyadh(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return new Date(`${v}T23:59:59+03:00`).toISOString();
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────
export type UserStatus = "active" | "inactive" | "locked" | "mustChange";
export const STATUS_WORD: Record<UserStatus, { ar: string; en: string; tone: "success" | "neutral" | "danger" | "warning" }> = {
  active: { ar: "نشط", en: "Active", tone: "success" },
  inactive: { ar: "موقوف", en: "Inactive", tone: "neutral" },
  locked: { ar: "مقفل", en: "Locked", tone: "danger" },
  mustChange: { ar: "يجب تغيير كلمة المرور", en: "Must change password", tone: "warning" },
};
export function StatusWord({ status, lang }: { status: UserStatus; lang: Lang }) {
  const s = STATUS_WORD[status];
  return <Dot tone={s.tone}>{lang === "ar" ? s.ar : s.en}</Dot>;
}
export const METHOD_WORD: Record<string, { ar: string; en: string }> = {
  PASSWORD: { ar: "كلمة المرور", en: "Password" }, USERNAME_PIN: { ar: "اسم المستخدم والرمز", en: "Username + PIN" }, PIN: { ar: "الرمز", en: "PIN" },
};
export type DeviceInfo = { browser: string | null; os: string | null; category: "desktop" | "phone" | "tablet" };
export function deviceText(d: DeviceInfo | null | undefined, lang: Lang): string {
  if (!d) return "—";
  const on = lang === "ar" ? "على" : "on";
  if (d.browser && d.os) return `${d.browser} ${on} ${d.os}`;
  return d.browser ?? d.os ?? (lang === "ar" ? "متصفح" : "Browser");
}

/** «مخصص», «قالب النظام»: text on the subtle surface (users.py tag()). */
export function Tag({ children, testId }: { children: ReactNode; testId?: string }) {
  return <span className="ur-tag" data-testid={testId}>{children}</span>;
}
export function SensFlag({ lang }: { lang: Lang }) {
  return <Flag tone="warning">{lang === "ar" ? "حساس" : "Sensitive"}</Flag>;
}
export type Source = "role" | "grant" | "deny" | "expired";
/** Where a value comes from (users.py src_tag): text with a dot, never colour alone. */
export function SrcTag({ source, lang, extra }: { source: Source; lang: Lang; extra?: string }) {
  const w = { role: ["الدور", "Role"], grant: ["استثناء منح", "Grant exception"], deny: ["استثناء منع", "Deny exception"], expired: ["استثناء منتهٍ", "Expired exception"] }[source];
  const tone = source === "grant" ? "info" : source === "deny" ? "warning" : "neutral";
  return <span className={`ur-src tone-${tone}`}><Dot tone={tone}>{(lang === "ar" ? w[0] : w[1]) + (extra ?? "")}</Dot></span>;
}
export function Avatar({ name, size }: { name: string; size?: "lg" | "md" }) {
  return <span className={`ur-av${size ? ` is-${size}` : ""}`} aria-hidden>{initials(name)}</span>;
}
/** A Latin identifier (username) inside Arabic text: an LTR isolate in the UI face. */
export function Latin({ children }: { children: ReactNode }) {
  return <bdi dir="ltr" className="ur-latin">{children}</bdi>;
}

// ── The area's frame and section header ─────────────────────────────────────────────────────────
/** OpsRoot + the settings sub-navigation (1440) — the frame every screen of the area sits in. */
export function UsersFrame({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <OpsRoot className="tl-root ur-root">
      <SettingsFrame>
        <div className="ur-page" data-testid={testId}>{children}</div>
      </SettingsFrame>
    </OpsRoot>
  );
}

export type SectionTab = "users" | "roles" | "devices" | "audit";
/**
 * The section header (users.py sec_head): «المستخدمون والصلاحيات», its meta line and actions, then
 * the section tabs. «أجهزة المحطات» has no page: the station device model (I-10) is not built, so
 * the tab is drawn disabled with «قريباً», as the settings navigation does for a section with no page.
 */
export function SectionHead({ tab, meta, actions, counts, isAdmin }: { tab: SectionTab; meta: ReactNode; actions?: ReactNode; counts?: { users?: number; roles?: number }; isAdmin: boolean }) {
  const { L } = useLangL();
  const items: { key: SectionTab; href: string | null; label: string; count?: number }[] = [
    { key: "users", href: "/dashboard/employees", label: L("المستخدمون", "Users"), count: counts?.users },
    { key: "roles", href: "/dashboard/employees/roles", label: L("الأدوار", "Roles"), count: counts?.roles },
    { key: "devices", href: null, label: L("أجهزة المحطات", "Station devices") },
    ...(isAdmin ? [{ key: "audit" as const, href: "/dashboard/employees/audit", label: L("سجل الصلاحيات", "Permission log") }] : []),
  ];
  return (
    <>
      <div className="hr-pagehead ur-head">
        <div className="ur-headtext">
          <h1 className="hr-title">{L("المستخدمون والصلاحيات", "Users & permissions")}</h1>
          <div className="ur-meta">{meta}</div>
        </div>
        {actions ? <div className="hr-actions">{actions}</div> : null}
      </div>
      <nav className="hr-tabs is-underline tl-tabs ur-tabs" aria-label={L("أقسام المستخدمين والصلاحيات", "Users & permissions sections")} data-testid="ur-section-tabs">
        {items.map((t) => t.href ? (
          <Link key={t.key} href={t.href} className="hr-tab" aria-current={t.key === tab ? "page" : undefined} data-testid={`ur-tab-${t.key}`}>
            {t.label}{t.count !== undefined ? <span className="hr-count">{t.count}</span> : null}
          </Link>
        ) : (
          <span key={t.key} className="hr-tab ur-tab-soon" aria-disabled="true" title={L("يتطلب نموذج أجهزة المحطات (I-10) — مخطط", "Needs the station device model (I-10) — planned")} data-testid={`ur-tab-${t.key}`}>
            {t.label}<em>{L("قريباً", "Soon")}</em>
          </span>
        ))}
      </nav>
    </>
  );
}

/** The record crumb (UR-02: «… / المستخدمون / سلمان الشهري») and the phone header. */
export function useUsersChrome(opts: { title: string | null; crumbs?: { text: string; href?: string }[]; phone?: { title: string; sub?: string; back?: string; ownBar?: boolean; action?: { href: string; label: string; icon: "plus" } } | null }) {
  useD21Title(opts.title);
  useD21Crumbs(opts.crumbs ?? null);
  useD21Phone(opts.phone ?? null);
}

// ── «كلمة مرورك» (J-4 / AU-08): the step-up drawn inline in every confirming dialog ─────────────
type Me = { username: string | null; mfa: boolean };
let meCache: Promise<Me> | null = null;
function loadMe(): Promise<Me> {
  if (!meCache) {
    meCache = Promise.all([
      fetch("/api/profile/security").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/auth/mfa").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([s, m]) => ({ username: (s?.account?.username as string | undefined) ?? null, mfa: !!m?.enrolled }));
  }
  return meCache;
}

/**
 * The password field of a confirming dialog and the confirmation it makes: POST /api/auth/reauth
 * with the caller's username and password (and the verification code when two-step verification
 * is on). The action is sent only after the server accepted it; the server checks the step-up
 * again on the action itself (requireAdminAction … stepUp), so nothing here is trusted.
 */
export function usePasswordConfirm() {
  const { lang } = useLangL();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void loadMe().then(setMe); }, []);
  const confirm = useCallback(async (): Promise<boolean> => {
    setErr(null);
    if (!password) { setErr(lang === "ar" ? "أدخل كلمة مرورك." : "Enter your password."); return false; }
    const r = await api("/api/auth/reauth", { method: "POST", body: { username: me?.username ?? undefined, password, ...(me?.mfa ? { code } : {}) } });
    if (!r.ok) { setErr(r.status === 429 ? errText(r.data, lang, "") || (lang === "ar" ? "محاولات كثيرة. حاول لاحقًا." : "Too many attempts. Try later.") : lang === "ar" ? "كلمة المرور غير صحيحة." : "The password is not correct."); return false; }
    return true;
  }, [password, code, me, lang]);
  const reset = useCallback(() => { setPassword(""); setCode(""); setErr(null); }, []);
  return { password, setPassword, code, setCode, mfa: !!me?.mfa, err, setErr, confirm, reset };
}

export function PasswordConfirmField({ pc, hint, testId }: { pc: ReturnType<typeof usePasswordConfirm>; hint?: string; testId?: string }) {
  const { L } = useLangL();
  const [shown, setShown] = useState(false);
  return (
    <>
      <label className="hr-field">
        <span className="hr-label">{L("كلمة مرورك", "Your password")}</span>
        <span className="ur-secret">
          <input className="hr-input" type={shown ? "text" : "password"} autoComplete="current-password" value={pc.password} onChange={(e) => pc.setPassword(e.target.value)} data-testid={testId ?? "ur-password"} dir="ltr" />
          <button type="button" className="ur-show" onClick={() => setShown((s) => !s)} aria-pressed={shown}>{shown ? L("إخفاء", "Hide") : L("إظهار", "Show")}</button>
        </span>
        {pc.err ? <span className="hr-err" role="alert">{pc.err}</span> : <span className="hr-help">{hint ?? L("مطلوبة لتغيير الصلاحيات. لا يُقبل الرمز السريع ولا البيانات الحيوية.", "Required to change permissions. Quick PIN and biometrics are not accepted.")}</span>}
      </label>
      {pc.mfa ? (
        <label className="hr-field">
          <span className="hr-label">{L("رمز التحقق", "Verification code")}</span>
          <input className="hr-input" inputMode="numeric" autoComplete="one-time-code" value={pc.code} onChange={(e) => pc.setCode(e.target.value)} dir="ltr" />
        </label>
      ) : null}
    </>
  );
}

/** A reason picked from the usual ones or typed (UR-04 / UR-11 «السبب»). */
export function ReasonField({ value, onChange, options, required, testId, label }: { value: string; onChange: (v: string) => void; options?: string[]; required?: boolean; testId?: string; label?: string }) {
  const { L } = useLangL();
  const id = `ur-reasons-${testId ?? "x"}`;
  return (
    <label className="hr-field">
      <span className="hr-label">{label ?? L("السبب", "Reason")}{required ? <span className="ur-req"> *</span> : null}</span>
      <input className="hr-input" value={value} onChange={(e) => onChange(e.target.value)} list={options?.length ? id : undefined} maxLength={300} data-testid={testId ?? "ur-reason"} />
      {options?.length ? <datalist id={id}>{options.map((o) => <option key={o} value={o} />)}</datalist> : null}
    </label>
  );
}

/** The area's «لا تملك صلاحية» state (UR-S04): who to ask. */
export function NoAccess({ admin }: { admin?: string | null }) {
  const { L } = useLangL();
  return (
    <div className="hr-notice tone-info" role="status" data-testid="ur-no-access">
      <strong>{L("لا تملك صلاحية إدارة المستخدمين.", "You do not have user management access.")}</strong>{" "}
      {L(`لطلبها تواصل مع مسؤول النظام${admin ? `: ${admin}` : ""}.`, `To request it, contact the administrator${admin ? `: ${admin}` : ""}.`)}
    </div>
  );
}

export function useIsPathActive(prefix: string) {
  const p = usePathname() ?? "";
  return p === prefix || p.startsWith(prefix + "/");
}

export { Btn };
