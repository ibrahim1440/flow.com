"use client";

import { type ReactNode } from "react";
import {
  AlertTriangle, FlaskConical, Ban, Check, Circle, CircleDashed, Clock, FileText,
  MessageSquare, PackageCheck, RotateCcw, Save, XCircle, type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../user-context";

/**
 * The pieces every sales screen shares.
 *
 * Extracted after the third screen, not before the first — these exist because the same
 * banner, the same empty state and the same money formatting were about to be written out
 * a fourth time, and a copied pill is a pill that will disagree with its siblings within a
 * month.
 *
 * ── Direction ──
 * Nothing here hard-codes left or right. `dir` is set once on <html> from the user's
 * language, and every spacing decision below uses a logical property (`ps-`, `me-`,
 * `text-start`) so the same markup lays out correctly in Arabic and English. A `ml-2`
 * anywhere in this module would be a bug that only shows up for the people who use the
 * system most.
 */

export function useLang(): "ar" | "en" {
  const user = useUser();
  return (user?.preferredLanguage as "ar" | "en") ?? "ar";
}

/** Pick the Arabic or English half of a bilingual label map. */
export function pick(
  map: Record<string, { en: string; ar: string }>,
  key: string,
  lang: "ar" | "en",
): string {
  return lang === "ar" ? (map[key]?.ar ?? key) : (map[key]?.en ?? key);
}

/**
 * The provisional-interface notice.
 *
 * A provisional screen that looks finished is worse than one that admits it, because
 * nobody reviews what appears already signed off.
 */
export function ProvisionalBanner() {
  const { t } = useI18n();
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 flex items-start gap-2">
      <AlertTriangle size={15} className="text-amber-700 flex-shrink-0 mt-0.5" aria-hidden />
      <p className="text-xs font-bold text-amber-900">{t("provisionalUiBanner")}</p>
    </div>
  );
}

/**
 * The sandbox notice, shown wherever money figures come from the sandbox collection source.
 *
 * Deliberately not subtle. Everything downstream of it is arithmetic on payments that were
 * typed in for testing, and a commission screen that does not say so reads as a payable.
 */
export function SandboxBanner({ notice }: { notice?: string | null }) {
  const lang = useLang();
  if (!notice) return null;
  return (
    <div
      className="bg-violet-50 border border-violet-200 rounded-xl px-4 py-2.5 flex items-start gap-2"
      role="note"
      data-testid="sandbox-banner"
    >
      <FlaskConical size={15} className="text-violet-700 flex-shrink-0 mt-0.5" aria-hidden />
      <p className="text-xs font-bold text-violet-900">
        {lang === "ar" ? "مصدر تجريبي: " : "Sandbox source: "}
        {notice}
      </p>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold text-charcoal">{title}</h1>
        {subtitle && <div className="text-brown text-sm font-medium">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Alert({
  kind,
  children,
  onDismiss,
}: {
  kind: "error" | "success" | "info";
  children: ReactNode;
  onDismiss?: () => void;
}) {
  if (!children) return null;
  const tone =
    kind === "error"
      ? "bg-red-50 border-red-200 text-red-700"
      : kind === "success"
        ? "bg-success-bg border-green-200 text-green-700"
        : "bg-info-bg border-slate-200 text-slate";
  return (
    <div
      className={`border px-4 py-3 rounded-xl text-sm font-bold flex items-start gap-3 ${tone}`}
      // Errors are announced; a confirmation that steals focus mid-typing is worse than one
      // that waits to be read.
      role={kind === "error" ? "alert" : "status"}
      data-testid={`alert-${kind}`}
    >
      <span className="flex-1">{children}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="opacity-60 hover:opacity-100 font-black" aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl border border-border p-5 ${className}`}>{children}</div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3">
      <h2 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">{children}</h2>
      {right}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="text-center py-10 text-brown/40 text-sm font-semibold">{children}</div>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center h-64" role="status" aria-live="polite">
      <div className="w-10 h-10 border-4 border-orange border-t-transparent rounded-full animate-spin" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

const BTN_BASE =
  "inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-bold transition-all " +
  "active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange/50 focus-visible:ring-offset-1";

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  disabled,
  title,
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  title?: string;
  testId?: string;
}) {
  const tone =
    variant === "primary"
      ? "bg-orange text-white hover:bg-orange-dark shadow-md shadow-orange/20"
      : variant === "danger"
        ? "bg-red-600 text-white hover:bg-red-700"
        : variant === "ghost"
          ? "text-brown hover:bg-cream"
          : "bg-white border-2 border-border text-charcoal hover:border-orange";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={`${BTN_BASE} ${tone}`}
    >
      {children}
    </button>
  );
}

const FIELD_BASE =
  "w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm bg-white " +
  "focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors " +
  "disabled:bg-cream/50 disabled:text-brown/60";

/**
 * A labelled control.
 *
 * The label is wired to the input with htmlFor/id rather than merely sitting above it, so
 * the label is clickable, a screen reader announces it, and the browser-UAT can find the
 * field by its name instead of by position — which is what "the third input in the modal"
 * turns into, and what breaks the moment a field is added.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-bold text-brown">
        {label}
        {required && <span className="text-red-600 ps-0.5" aria-hidden>*</span>}
      </label>
      {children}
      {hint && !error && <p className="text-[11px] text-brown/60 font-medium">{hint}</p>}
      {error && (
        <p id={`${id}-error`} className="text-[11px] text-red-600 font-bold" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  invalid,
  inputMode,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  invalid?: boolean;
  inputMode?: "text" | "numeric" | "decimal" | "tel" | "email";
}) {
  return (
    <input
      id={id}
      type={type}
      inputMode={inputMode}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${id}-error` : undefined}
      onChange={(e) => onChange(e.target.value)}
      className={`${FIELD_BASE} ${invalid ? "border-red-400" : ""}`}
    />
  );
}

export function Select({
  id,
  value,
  onChange,
  children,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={FIELD_BASE}
    >
      {children}
    </select>
  );
}

export function TextArea({
  id,
  value,
  onChange,
  rows = 3,
  placeholder,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={FIELD_BASE}
    />
  );
}

/**
 * Present an exact decimal string as money, without ever going through a float.
 *
 * A Prisma Decimal serialises as the shortest string that represents it — 1350 for one
 * thousand three hundred and fifty, 1552.5 for the total of a quotation. Rendering that
 * verbatim puts "1552.5 SAR" on a document a customer is invoiced against, and a column of
 * figures where some have two decimal places and some have none is unreadable.
 *
 * The padding and grouping are done as STRING operations. `Number(x).toFixed(2)` would be
 * one line shorter and would route the amount through binary floating point, which is the
 * one thing every layer below this has been careful not to do.
 */
export function formatMoney(raw: string, places = 2): string {
  const trimmed = raw.trim();
  // Anything that is not a plain decimal is handed back untouched rather than mangled.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;

  const negative = trimmed.startsWith("-");
  const [intPart, fracPart = ""] = trimmed.replace(/^-/, "").split(".");
  const frac = (fracPart + "0".repeat(places)).slice(0, places);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${places > 0 ? "." + frac : ""}`;
}

/**
 * Money, in the one format the whole module uses.
 *
 * `tabular-nums` because these sit in columns and proportional digits make a column of
 * figures impossible to scan.
 */
export function Money({ value, currency = "SAR" }: { value: string | number | null | undefined; currency?: string }) {
  if (value === null || value === undefined || value === "") return <span className="text-brown/40">—</span>;
  const raw = String(value);
  const negative = raw.trim().startsWith("-");
  return (
    <span className={`tabular-nums font-bold ${negative ? "text-red-600" : ""}`}>
      {formatMoney(raw)} <span className="text-[10px] font-semibold text-brown/60">{currency}</span>
    </span>
  );
}

export function Pill({
  children,
  tone = "neutral",
  testId,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "info" | "accent";
  testId?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-cream text-brown",
    good: "bg-emerald-100 text-emerald-800",
    warn: "bg-amber-100 text-amber-800",
    bad: "bg-red-50 text-red-700",
    info: "bg-info-bg text-slate",
    accent: "bg-orange/15 text-orange",
  };
  return (
    <span
      data-testid={testId}
      className={`inline-block px-2 py-0.5 rounded-lg text-[11px] font-bold whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

const PILL_TONES: Record<string, string> = {
  neutral: "bg-cream text-brown",
  good: "bg-emerald-100 text-emerald-800",
  warn: "bg-amber-100 text-amber-800",
  bad: "bg-red-50 text-red-700",
  info: "bg-info-bg text-slate",
  accent: "bg-orange/15 text-orange",
};

type Tone = keyof typeof PILL_TONES;
export type StatusSpec = { en: string; ar: string; tone: Tone; Icon: LucideIcon };
type Spec = StatusSpec;

/**
 * Status badges, one map per stored enum.
 *
 * `Pill` takes a free-form tone, which means two screens can render the same stored value in
 * two different colours and nobody notices until a reader compares them. These maps are the
 * single place a status decides how it looks, keyed by the value the database actually holds.
 *
 * Every badge carries an icon AND a word. Colour alone fails for the colour-blind and washes
 * out on a warehouse tablet in daylight, and two of these maps deliberately reuse a tone —
 * Draft and Superseded are both neutral, Unqualified and Lost are both neutral — so the icon
 * and the label are what actually distinguish them, not the fill.
 *
 * Unqualified and Lost are neutral rather than red on purpose: both are ordinary outcomes of
 * doing the work, not errors, and colouring them like failures misreads the pipeline.
 */
function StatusBadge({ spec, testId }: { spec: Spec | undefined; fallback?: string; testId?: string }) {
  const { lang } = useBadgeLang();
  if (!spec) return null;
  const { Icon } = spec;
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[11px] font-bold whitespace-nowrap ${PILL_TONES[spec.tone]}`}
    >
      <Icon size={12} aria-hidden className="flex-shrink-0" />
      {lang === "ar" ? spec.ar : spec.en}
    </span>
  );
}

function useBadgeLang() {
  const user = useUser();
  return { lang: (user?.preferredLanguage ?? "ar") as "ar" | "en" };
}

/** `LeadStatus` — the 5 stored values. */
export const LEAD_STATUS_SPECS: Record<string, Spec> = {
  NEW:         { en: "New",         ar: "جديد",       tone: "info",    Icon: Circle },
  CONTACTED:   { en: "Contacted",   ar: "تم التواصل", tone: "warn",    Icon: MessageSquare },
  QUALIFIED:   { en: "Qualified",   ar: "مؤهَّل",      tone: "accent",  Icon: Check },
  UNQUALIFIED: { en: "Unqualified", ar: "غير مؤهَّل",  tone: "neutral", Icon: XCircle },
  CONVERTED:   { en: "Converted",   ar: "محوَّل",      tone: "good",    Icon: PackageCheck },
};

/** `QuoteStatus` — the 6 stored values. Draft and Superseded share a tone; the icon separates them. */
export const QUOTE_STATUS_SPECS: Record<string, Spec> = {
  DRAFT:      { en: "Draft",      ar: "مسودة",          tone: "neutral", Icon: Save },
  ISSUED:     { en: "Issued",     ar: "صادر",           tone: "info",    Icon: FileText },
  ACCEPTED:   { en: "Accepted",   ar: "مقبول",          tone: "good",    Icon: Check },
  REJECTED:   { en: "Rejected",   ar: "مرفوض",          tone: "bad",     Icon: Ban },
  EXPIRED:    { en: "Expired",    ar: "منتهي الصلاحية", tone: "warn",    Icon: Clock },
  SUPERSEDED: { en: "Superseded", ar: "مستبدَل",         tone: "neutral", Icon: RotateCcw },
};

/**
 * `AccrualStatus` — the 5 declared values.
 *
 * PREVIEW is declared in the schema and **never written by this build**: accruals are created
 * as ACCRUED and move to APPROVED then PAID. It is mapped here so a row is never unlabelled if
 * that changes, not because the state occurs today.
 */
export const ACCRUAL_STATUS_SPECS: Record<string, Spec> = {
  PREVIEW:  { en: "Preview",  ar: "معاينة", tone: "warn",    Icon: CircleDashed },
  ACCRUED:  { en: "Accrued",  ar: "مستحَق",  tone: "info",    Icon: Clock },
  APPROVED: { en: "Approved", ar: "معتمَد",  tone: "accent",  Icon: FileText },
  PAID:     { en: "Paid",     ar: "مدفوع",  tone: "good",    Icon: Check },
  REVERSED: { en: "Reversed", ar: "معكوس",  tone: "neutral", Icon: RotateCcw },
};

/** `OpportunityOutcome` — outcome is not a stage, and this badge sits beside one rather than replacing it. */
export const DEAL_OUTCOME_SPECS: Record<string, Spec> = {
  OPEN: { en: "Open", ar: "مفتوح", tone: "info",    Icon: Circle },
  WON:  { en: "Won",  ar: "رابح",  tone: "good",    Icon: Check },
  LOST: { en: "Lost", ar: "خاسر",  tone: "neutral", Icon: XCircle },
};

export function LeadStatusBadge({ status, testId }: { status: string; testId?: string }) {
  return <StatusBadge spec={LEAD_STATUS_SPECS[status]} testId={testId} />;
}
export function QuoteStatusBadge({ status, testId }: { status: string; testId?: string }) {
  return <StatusBadge spec={QUOTE_STATUS_SPECS[status]} testId={testId} />;
}
export function AccrualStatusBadge({ status, testId }: { status: string; testId?: string }) {
  return <StatusBadge spec={ACCRUAL_STATUS_SPECS[status]} testId={testId} />;
}
export function DealOutcomeBadge({ outcome, testId }: { outcome: string; testId?: string }) {
  return <StatusBadge spec={DEAL_OUTCOME_SPECS[outcome]} testId={testId} />;
}

/**
 * A modal dialog.
 *
 * Closes on Escape and on a click outside, both of which people try before looking for the
 * ×. `aria-modal` and a labelled heading are what make it a dialog to a screen reader
 * rather than a div that happens to be on top.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  testId,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 z-[60] flex items-start sm:items-center justify-center p-3 overflow-y-auto"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        onClick={(e) => e.stopPropagation()}
        className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? "max-w-3xl" : "max-w-lg"} my-4`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <h2 className="text-lg font-extrabold text-charcoal">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brown/60 hover:text-charcoal font-black text-xl leading-none px-2"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">{children}</div>
        {footer && (
          <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-2 flex-wrap">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A table that scrolls inside its own box.
 *
 * The page body must never scroll sideways — on a phone that makes every other control
 * unreachable — so the overflow lives here, on the one element that is genuinely too wide.
 */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto -mx-5 px-5">{children}</div>;
}

/** Fetch JSON and surface the server's own message, never a generic one. */
export async function api<T = Record<string, unknown>>(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, status: res.status, data };
}
