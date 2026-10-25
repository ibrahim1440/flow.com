"use client";

import { useEffect, useState, type ReactNode } from "react";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useUser } from "../../user-context";
import { KPI, type KpiKey } from "@/lib/marketing/kpi";
import { PLATFORM } from "@/lib/marketing/platforms";
import { useD21Phone } from "@/components/shell/page-context";

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

export function usePageTitle(ar: string, en: string, lang: "ar" | "en") {
  useD21Phone({ title: lang === "ar" ? ar : en, sub: lang === "ar" ? "التسويق" : "Marketing" });
}

export const NA_AR = "غير متاح";

export function fmt(v: number | null | undefined, opts: { digits?: number; unit?: "SAR" | "pct" | "x" | "count" | "ratio"; lang?: "ar" | "en" } = {}): string {
  if (v === null || v === undefined || Number.isNaN(v)) return opts.lang === "en" ? "Not available" : NA_AR;
  const digits = opts.digits ?? (opts.unit === "count" ? 0 : 2);
  const s = v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: opts.unit === "SAR" ? Math.min(2, digits) : 0 });
  if (opts.unit === "SAR") return `${s} ${opts.lang === "en" ? "SAR" : "ر.س"}`;
  if (opts.unit === "pct") return `${s}%`;
  if (opts.unit === "x") return `${s}×`;
  return s;
}

export function fmtDate(d: string | Date | null | undefined, withTime = false): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit", ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) }).format(new Date(d));
}

export function platformName(key: string, lang: "ar" | "en" = "ar") {
  const p = PLATFORM[key];
  return p ? (lang === "ar" ? p.ar : p.en) : key;
}

export type Figure = { value: number | null; previous: number | null; changePct: number | null; kpi: string; source: string; lastUpdated: string | null };

/** A KPI tile: value, change vs the previous equal period, definition and source on hover/focus and in text. */
export function Kpi({ f, label, testId, lang = "ar" }: { f: Figure | undefined; label?: string; testId?: string; lang?: "ar" | "en" }) {
  const def = f ? KPI[f.kpi as KpiKey] : undefined;
  const unit = def?.unit;
  const name = label ?? (def ? (lang === "ar" ? def.ar : def.en) : "—");
  if (!f) return null;
  const good = def?.higherIsBetter;
  const tone = f.changePct === null || good === null || good === undefined ? "" : (f.changePct > 0) === good ? "up" : f.changePct === 0 ? "" : "down";
  return (
    <div className="mkt-kpi" data-testid={testId} title={def ? `${def.formulaAr}\nالمصدر: ${f.source}` : f.source}>
      <span className={`v ${f.value === null ? "na" : ""}`}><bdi>{fmt(f.value, { unit, lang })}</bdi></span>
      <span className="l">{name}</span>
      <span className="m">
        {f.changePct !== null ? <span className={tone}><bdi>{f.changePct > 0 ? "+" : ""}{f.changePct}%</bdi> عن الفترة السابقة · </span> : f.previous === null && f.value !== null ? "لا مقارنة · " : null}
        {f.lastUpdated ? `آخر تحديث ${fmtDate(f.lastUpdated, true)}` : "لا تحديث"}
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

type Spec = { ar: string; tone?: "good" | "warn" | "bad" | "info" };
export const POST_STATUS: Record<string, Spec> = {
  DRAFT: { ar: "مسودة" }, IN_REVIEW: { ar: "بانتظار الاعتماد", tone: "warn" }, APPROVED: { ar: "معتمد", tone: "info" },
  SCHEDULED: { ar: "مجدول", tone: "info" }, PUBLISHING: { ar: "قيد النشر", tone: "info" }, PUBLISHED: { ar: "منشور", tone: "good" },
  PARTIAL: { ar: "نُشر جزئياً", tone: "warn" }, FAILED: { ar: "فشل النشر", tone: "bad" }, CANCELLED: { ar: "ملغى" },
};
export const VARIANT_STATUS: Record<string, Spec> = {
  PENDING: { ar: "بانتظار" }, QUEUED: { ar: "في القائمة", tone: "info" }, PUBLISHING: { ar: "يُنشر الآن", tone: "info" }, PUBLISHED: { ar: "منشور عبر API", tone: "good" },
  FAILED: { ar: "فشل", tone: "bad" }, MANUAL_REQUIRED: { ar: "بانتظار النشر اليدوي", tone: "warn" }, MANUAL_DONE: { ar: "نُشر يدوياً (مؤكد)", tone: "good" }, CANCELLED: { ar: "ملغى" },
};
export const CAMPAIGN_STATUS: Record<string, Spec> = {
  DRAFT: { ar: "مسودة" }, PLANNED: { ar: "مخططة", tone: "info" }, ACTIVE: { ar: "نشطة", tone: "good" }, PAUSED: { ar: "موقوفة", tone: "warn" },
  COMPLETED: { ar: "منتهية" }, ARCHIVED: { ar: "مؤرشفة" },
};
export const APPROVAL_STATUS: Record<string, Spec> = { PENDING: { ar: "معلّق", tone: "warn" }, APPROVED: { ar: "معتمد", tone: "good" }, REJECTED: { ar: "مرفوض", tone: "bad" }, CANCELLED: { ar: "ملغى" } };
export const MESSAGE_STATUS: Record<string, Spec> = {
  QUEUED: { ar: "مجدولة", tone: "info" }, SENDING: { ar: "تُرسل", tone: "info" }, SENT: { ar: "أُرسلت" }, DELIVERED: { ar: "سُلّمت", tone: "good" }, READ: { ar: "قُرئت", tone: "good" },
  FAILED: { ar: "فشلت", tone: "bad" }, SKIPPED: { ar: "لم تُرسل", tone: "warn" }, CANCELLED: { ar: "ملغاة" },
};
export const CONNECTION_STATUS: Record<string, Spec> = {
  NOT_CONFIGURED: { ar: "غير مربوط" }, PENDING: { ar: "بانتظار التحقق", tone: "warn" }, CONNECTED: { ar: "متصل (تم التحقق)", tone: "good" },
  EXPIRED: { ar: "انتهت الصلاحية", tone: "bad" }, ERROR: { ar: "خطأ", tone: "bad" }, DISABLED: { ar: "مفصول" },
};
export const OBJECTIVES: Record<string, string> = { AWARENESS: "الوعي", ENGAGEMENT: "التفاعل", TRAFFIC: "الزيارات", LEADS: "العملاء المحتملون", CONVERSIONS: "التحويلات", SALES: "المبيعات", RETENTION: "الاحتفاظ بالعملاء" };

export function StatusChip({ map, value, testId }: { map: Record<string, Spec>; value: string; testId?: string }) {
  const s = map[value];
  return <Chip tone={s?.tone} testId={testId}>{s?.ar ?? value}</Chip>;
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
  return (
    <div className="mkt-toolbar" data-testid="range">
      <div className="mkt-seg" role="group" aria-label="الفترة">
        {(["7", "30", "90"] as const).map((k) => <button key={k} type="button" onClick={r.presets[k]}>{k} يوم</button>)}
      </div>
      <label className="mkt-muted">من <input type="date" value={r.from} max={r.to} onChange={(e) => e.target.value && r.setFrom(e.target.value)} className="mkt-chip" aria-label="من" /></label>
      <label className="mkt-muted">إلى <input type="date" value={r.to} min={r.from} onChange={(e) => e.target.value && r.setTo(e.target.value)} className="mkt-chip" aria-label="إلى" /></label>
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
      if (!res.ok) setState((s) => ({ key: k, data: s.data, error: (body as { error?: string }).error ?? "تعذر التحميل." }));
      else setState({ key: k, data: body as T, error: "" });
    }).catch(() => { if (!cancelled) setState((s) => ({ key: k, data: s.data, error: "تعذر الاتصال بالخادم." })); });
    return () => { cancelled = true; };
  }, [url, token]);
  return { data: state.data, error: state.error, loading: key !== null && state.key !== key, reload: () => setToken((t) => t + 1) };
}

export function Banner({ tone, children, onClose }: { tone?: "warn" | "info"; children: ReactNode; onClose?: () => void }) {
  if (!children) return null;
  return (
    <div className={`mkt-banner ${tone ?? ""}`} role={tone ? "status" : "alert"}>
      <span>{children}</span>
      {onClose ? <button type="button" onClick={onClose} aria-label="إغلاق" style={{ float: "inline-end", fontWeight: 700 }}>×</button> : null}
    </div>
  );
}

export function NotAllowed({ what }: { what: string }) {
  return <div className="mkt-banner info" data-testid="not-allowed">لا تملك صلاحية {what}. اطلبها من مسؤول النظام.</div>;
}
