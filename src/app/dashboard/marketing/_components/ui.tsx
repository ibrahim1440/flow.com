"use client";

import { useEffect, useState, type ReactNode } from "react";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useUser } from "../../user-context";
import { KPI, type KpiKey } from "@/lib/marketing/kpi";
import { PLATFORM } from "@/lib/marketing/platforms";
import { useD21Phone } from "@/components/shell/page-context";
import { localizeApiError, networkErrorText } from "@/lib/i18n/api-errors";
import { useLang as useLangInner } from "../../sales/_components/ui";

export {
  useLang, Button, Field, TextInput, Select, TextArea, Modal, Alert, api, Money, Num, PageHeader, EmptyState, Spinner, SearchField,
} from "../../sales/_components/ui";

/**
 * The marketing screens' shared pieces. Everything that shows a figure goes through `fmt` /
 * `<Kpi>`, which print «غير متاح» for null — a missing figure is never drawn as 0.
 */

export function useMkt() {
  const user = useUser();
  const can = (sub: string) => hasSubPrivilege(user?.permissions ?? {}, "marketing", sub);
  return { user, can };
}

/** The bilingual picker for the marketing screens: `L("عربي", "English")`, like the rest of the ERP. */
export function useMktL() {
  const lang = useLangInner();
  return (ar: string, en: string) => (lang === "ar" ? ar : en);
}

export function usePageTitle(ar: string, en: string, lang: "ar" | "en") {
  useD21Phone({ title: lang === "ar" ? ar : en, sub: lang === "ar" ? "التسويق" : "Marketing" });
}

export const NA_AR = "غير متاح";

export function fmt(v: number | null | undefined, opts: { digits?: number; unit?: "SAR" | "pct" | "x" | "count" | "ratio"; lang?: "ar" | "en" } = {}): string {
  // Figures render after their data loads (client only), so the page language is read when no `lang` is given.
  const en = opts.lang ? opts.lang === "en" : isEn();
  if (v === null || v === undefined || Number.isNaN(v)) return en ? "Not available" : NA_AR;
  const digits = opts.digits ?? (opts.unit === "count" ? 0 : 2);
  const s = v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: opts.unit === "SAR" ? Math.min(2, digits) : 0 });
  if (opts.unit === "SAR") return `${s} ${en ? "SAR" : "ر.س"}`;
  if (opts.unit === "pct") return `${s}%`;
  if (opts.unit === "x") return `${s}×`;
  return s;
}

/** The page language outside React (the root layout sets <html lang>). */
function isEn(): boolean {
  return typeof document !== "undefined" && document.documentElement.lang === "en";
}

export function fmtDate(d: string | Date | null | undefined, withTime = false): string {
  if (!d) return "—";
  // The page's language: the Arabic locale's right-to-left marks scramble a date on an English screen.
  return new Intl.DateTimeFormat(isEn() ? "en-GB" : "ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit", ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) }).format(new Date(d));
}

export function platformName(key: string, lang?: "ar" | "en") {
  const p = PLATFORM[key];
  const l = lang ?? (isEn() ? "en" : "ar");
  return p ? (l === "ar" ? p.ar : p.en) : key;
}

export type Figure = { value: number | null; previous: number | null; changePct: number | null; kpi: string; source: string; sourceEn?: string; lastUpdated: string | null };

/** A KPI tile: value, change vs the previous equal period, definition and source on hover/focus and in text. */
export function Kpi({ f, label, testId, lang = "ar" }: { f: Figure | undefined; label?: string; testId?: string; lang?: "ar" | "en" }) {
  const def = f ? KPI[f.kpi as KpiKey] : undefined;
  const unit = def?.unit;
  const name = label ?? (def ? (lang === "ar" ? def.ar : def.en) : "—");
  if (!f) return null;
  const good = def?.higherIsBetter;
  const tone = f.changePct === null || good === null || good === undefined ? "" : (f.changePct > 0) === good ? "up" : f.changePct === 0 ? "" : "down";
  return (
    <div className="mkt-kpi" data-testid={testId} title={def ? (lang === "ar" ? `${def.formulaAr}\nالمصدر: ${f.source}` : `${def.formulaEn}\nSource: ${f.sourceEn ?? f.source}`) : lang === "ar" ? f.source : f.sourceEn ?? f.source}>
      <span className={`v ${f.value === null ? "na" : ""}`}><bdi>{fmt(f.value, { unit, lang })}</bdi></span>
      <span className="l">{name}</span>
      <span className="m">
        {f.changePct !== null ? <span className={tone}><bdi>{f.changePct > 0 ? "+" : ""}{f.changePct}%</bdi> {lang === "ar" ? "عن الفترة السابقة" : "vs the previous period"} · </span> : f.previous === null && f.value !== null ? (lang === "ar" ? "لا مقارنة · " : "No comparison · ") : null}
        {f.lastUpdated ? (lang === "ar" ? `آخر تحديث ${fmtDate(f.lastUpdated, true)}` : `Updated ${fmtDate(f.lastUpdated, true)}`) : (lang === "ar" ? "لا تحديث" : "Not updated")}
      </span>
    </div>
  );
}

export function Sec({ title, caption, children, actions, testId }: { title: ReactNode; caption?: ReactNode; children: ReactNode; actions?: ReactNode; testId?: string }) {
  return (
    <section className="mkt-sec" data-testid={testId}>
      <div className="mkt-toolbar" style={{ marginBottom: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{title}</h2>
        <span className="sp" />
        {actions}
      </div>
      {caption ? <p className="mkt-muted" style={{ margin: "0 0 10px" }}>{caption}</p> : null}
      {children}
    </section>
  );
}

export function Chip({ children, tone, testId }: { children: ReactNode; tone?: "good" | "warn" | "bad" | "info"; testId?: string }) {
  return <span className="mkt-chip" data-tone={tone} data-testid={testId}>{children}</span>;
}

type Spec = { ar: string; en: string; tone?: "good" | "warn" | "bad" | "info" };
export const POST_STATUS: Record<string, Spec> = {
  DRAFT: { ar: "مسودة", en: "Draft" }, IN_REVIEW: { ar: "بانتظار الاعتماد", en: "Awaiting approval", tone: "warn" }, APPROVED: { ar: "معتمد", en: "Approved", tone: "info" },
  SCHEDULED: { ar: "مجدول", en: "Scheduled", tone: "info" }, PUBLISHING: { ar: "قيد النشر", en: "Publishing", tone: "info" }, PUBLISHED: { ar: "منشور", en: "Published", tone: "good" },
  PARTIAL: { ar: "نُشر جزئياً", en: "Partly published", tone: "warn" }, FAILED: { ar: "فشل النشر", en: "Publishing failed", tone: "bad" }, CANCELLED: { ar: "ملغى", en: "Cancelled" },
};
export const VARIANT_STATUS: Record<string, Spec> = {
  PENDING: { ar: "بانتظار", en: "Pending" }, QUEUED: { ar: "في القائمة", en: "Queued", tone: "info" }, PUBLISHING: { ar: "يُنشر الآن", en: "Publishing now", tone: "info" }, PUBLISHED: { ar: "منشور عبر API", en: "Published via API", tone: "good" },
  FAILED: { ar: "فشل", en: "Failed", tone: "bad" }, MANUAL_REQUIRED: { ar: "بانتظار النشر اليدوي", en: "Awaiting manual publishing", tone: "warn" }, MANUAL_DONE: { ar: "نُشر يدوياً (مؤكد)", en: "Published manually (confirmed)", tone: "good" }, CANCELLED: { ar: "ملغى", en: "Cancelled" },
};
export const CAMPAIGN_STATUS: Record<string, Spec> = {
  DRAFT: { ar: "مسودة", en: "Draft" }, PLANNED: { ar: "مخططة", en: "Planned", tone: "info" }, ACTIVE: { ar: "نشطة", en: "Active", tone: "good" }, PAUSED: { ar: "موقوفة", en: "Paused", tone: "warn" },
  COMPLETED: { ar: "منتهية", en: "Completed" }, ARCHIVED: { ar: "مؤرشفة", en: "Archived" },
};
export const APPROVAL_STATUS: Record<string, Spec> = { PENDING: { ar: "معلّق", en: "Pending", tone: "warn" }, APPROVED: { ar: "معتمد", en: "Approved", tone: "good" }, REJECTED: { ar: "مرفوض", en: "Rejected", tone: "bad" }, CANCELLED: { ar: "ملغى", en: "Cancelled" } };
export const MESSAGE_STATUS: Record<string, Spec> = {
  QUEUED: { ar: "مجدولة", en: "Scheduled", tone: "info" }, SENDING: { ar: "تُرسل", en: "Sending", tone: "info" }, SENT: { ar: "أُرسلت", en: "Sent" }, DELIVERED: { ar: "سُلّمت", en: "Delivered", tone: "good" }, READ: { ar: "قُرئت", en: "Read", tone: "good" },
  FAILED: { ar: "فشلت", en: "Failed", tone: "bad" }, SKIPPED: { ar: "لم تُرسل", en: "Not sent", tone: "warn" }, CANCELLED: { ar: "ملغاة", en: "Cancelled" },
};
export const CONNECTION_STATUS: Record<string, Spec> = {
  NOT_CONFIGURED: { ar: "غير مربوط", en: "Not connected" }, PENDING: { ar: "بانتظار التحقق", en: "Awaiting verification", tone: "warn" }, CONNECTED: { ar: "متصل (تم التحقق)", en: "Connected (verified)", tone: "good" },
  EXPIRED: { ar: "انتهت الصلاحية", en: "Expired", tone: "bad" }, ERROR: { ar: "خطأ", en: "Error", tone: "bad" }, DISABLED: { ar: "مفصول", en: "Disconnected" },
};
export const OBJECTIVES: Record<string, { ar: string; en: string }> = {
  AWARENESS: { ar: "الوعي", en: "Awareness" }, ENGAGEMENT: { ar: "التفاعل", en: "Engagement" }, TRAFFIC: { ar: "الزيارات", en: "Traffic" },
  LEADS: { ar: "العملاء المحتملون", en: "Leads" }, CONVERSIONS: { ar: "التحويلات", en: "Conversions" }, SALES: { ar: "المبيعات", en: "Sales" },
  RETENTION: { ar: "الاحتفاظ بالعملاء", en: "Retention" },
};
/** A status / objective label in the viewer's language (the key itself when unknown). */
export function specLabel(map: Record<string, { ar: string; en: string }>, key: string, lang: "ar" | "en"): string {
  const s = map[key];
  return s ? (lang === "ar" ? s.ar : s.en) : key;
}

export function StatusChip({ map, value, testId }: { map: Record<string, Spec>; value: string; testId?: string }) {
  const lang = useLangInner();
  const s = map[value];
  return <Chip tone={s?.tone} testId={testId}>{s ? (lang === "ar" ? s.ar : s.en) : value}</Chip>;
}

/** A period picker: presets plus explicit dates. Dates are Riyadh calendar days (YYYY-MM-DD). */
const riyadhDay = (msAgo = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date(Date.now() - msAgo));

export function useRange(days = 30) {
  const [from, setFrom] = useState(() => riyadhDay((days - 1) * 86_400_000));
  const [to, setTo] = useState(() => riyadhDay());
  const preset = (n: number) => () => { setFrom(riyadhDay((n - 1) * 86_400_000)); setTo(riyadhDay()); };
  return { from, to, setFrom, setTo, qs: `from=${from}&to=${to}`, presets: { "7": preset(7), "30": preset(30), "90": preset(90) } };
}

export function RangePicker({ r }: { r: ReturnType<typeof useRange> }) {
  const L = useMktL();
  return (
    <div className="mkt-toolbar" data-testid="range">
      <div className="mkt-seg" role="group" aria-label={L("الفترة", "Period")}>
        {(["7", "30", "90"] as const).map((k) => <button key={k} type="button" onClick={r.presets[k]}>{L(`${k} يوم`, `${k} days`)}</button>)}
      </div>
      <label className="mkt-muted">{L("من", "From")} <input type="date" value={r.from} max={r.to} onChange={(e) => e.target.value && r.setFrom(e.target.value)} className="mkt-chip" aria-label={L("من", "From")} /></label>
      <label className="mkt-muted">{L("إلى", "To")} <input type="date" value={r.to} min={r.from} onChange={(e) => e.target.value && r.setTo(e.target.value)} className="mkt-chip" aria-label={L("إلى", "To")} /></label>
    </div>
  );
}

/** Load JSON for a URL; reload by bumping the token. Keeps loading / error states apart. */
export function useLoad<T>(url: string | null) {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string }>({ key: null, data: null, error: "" });
  const [token, setToken] = useState(0);
  const key = url ? `${url}#${token}` : null;
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const k = `${url}#${token}`;
    fetch(url).then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (cancelled) return;
      // A failed reload keeps the last good data on screen beside the error.
      if (!res.ok) setState((s) => ({ key: k, data: s.data, error: localizeApiError(body) ?? (isEn() ? "Could not load." : "تعذر التحميل.") }));
      else setState({ key: k, data: body as T, error: "" });
    }).catch(() => { if (!cancelled) setState((s) => ({ key: k, data: s.data, error: networkErrorText() })); });
    return () => { cancelled = true; };
  }, [url, token]);
  return { data: state.data, error: state.error, loading: key !== null && state.key !== key, reload: () => setToken((t) => t + 1) };
}

export function Banner({ tone, children, onClose }: { tone?: "warn" | "info"; children: ReactNode; onClose?: () => void }) {
  if (!children) return null;
  return (
    <div className={`mkt-banner ${tone ?? ""}`} role={tone ? "status" : "alert"}>
      <span>{children}</span>
      {onClose ? <button type="button" onClick={onClose} aria-label={isEn() ? "Close" : "إغلاق"} style={{ float: "inline-end", fontWeight: 700 }}>×</button> : null}
    </div>
  );
}

export function NotAllowed({ what }: { what: string }) {
  const L = useMktL();
  return <div className="mkt-banner info" data-testid="not-allowed">{L(`لا تملك صلاحية ${what}. اطلبها من مسؤول النظام.`, `You do not have permission for ${what}. Ask your system administrator.`)}</div>;
}
