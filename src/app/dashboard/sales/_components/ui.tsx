"use client";

import { type ReactNode } from "react";
import {
  AlertTriangle, FlaskConical, Ban, Check, ChevronDown, Circle, CircleDashed, Clock, FileText,
  MessageSquare, PackageCheck, RotateCcw, Save, Search, XCircle, type LucideIcon,
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

/**
 * A date for an Arabic-first screen.
 *
 * `formatDate` in lib/utils is pinned to en-US, so every Arabic screen in this module was
 * rendering "Jan 1, 2099" beside right-to-left text. That function is used across the whole
 * ERP and is left alone; this is the Sales-local replacement.
 *
 * Near dates read as "today"/"tomorrow" plus a time, because a follow-up list is about what
 * happens next and a reader should not have to subtract dates to find out. Anything further
 * out gets a short numeric date.
 */
/** A count in the reader's own numerals. Arabic screens showing Latin digits read as a
 * half-translated interface, and the design uses Arabic-Indic throughout. */
export function num(n: number, lang: "ar" | "en"): string {
  return n.toLocaleString(lang === "ar" ? "ar-SA-u-nu-arab" : "en-GB");
}

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/**
 * Arabic-Indic presentation of an already-formatted Latin-digit number.
 *
 * A character substitution rather than a re-format, so the exact decimal string produced
 * upstream survives intact — the money path is deliberately string-only and must not be
 * routed back through `Number` to change its numerals.
 */
export function toArabicDigits(s: string): string {
  return s.replace(/[0-9,.]/g, (c) => (c === "," ? "٬" : c === "." ? "٫" : AR_DIGITS[Number(c)]));
}

/**
 * The months a period picker offers: the last twelve, this one, and the next.
 *
 * A `<select>` rather than `<input type="month">` everywhere this is used, because the
 * native control renders its month name in the BROWSER's locale — an Arabic page was
 * offering "September 2026". `current` is always present in the list, so a month reached
 * from a link or a stale bookmark stays selectable.
 */
export function monthOptions(current: string, lang: "ar" | "en"): { value: string; label: string }[] {
  const name = (d: Date) =>
    d.toLocaleDateString(lang === "ar" ? "ar-SA-u-nu-arab-ca-gregory" : "en-GB", {
      month: "long",
      year: "numeric",
    });
  const out = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1 - i);
    return { value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: name(d) };
  });
  if (!out.some((o) => o.value === current)) {
    const [y, m] = current.split("-").map(Number);
    out.unshift({ value: current, label: name(new Date(y, (m ?? 1) - 1, 1)) });
  }
  return out;
}

/** A calendar day the way the design writes one: "٣٠ سبتمبر" / "30 Sep". No year, because
 *  these columns are all within the current cycle and the year is noise in a table. */
export function formatDay(value: string | Date | null | undefined, lang: "ar" | "en"): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(lang === "ar" ? "ar-SA-u-nu-arab" : "en-GB", {
    day: "numeric",
    month: lang === "ar" ? "long" : "short",
  });
}

export function formatWhen(value: string | Date | null | undefined, lang: "ar" | "en"): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const locale = lang === "ar" ? "ar-SA-u-nu-arab" : "en-GB";
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(new Date())) / 86_400_000);
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (days === 0) return `${lang === "ar" ? "اليوم" : "Today"} ${time}`;
  if (days === 1) return `${lang === "ar" ? "غداً" : "Tomorrow"} ${time}`;
  if (days === -1) return `${lang === "ar" ? "أمس" : "Yesterday"} ${time}`;
  // The year only earns its place when it is not this one. The design writes these as
  // "٢٦ سبتمبر", and a column of dates that all repeat the same year is four wasted glyphs.
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(locale, {
    ...(thisYear ? {} : { year: "numeric" }),
    month: lang === "ar" ? "long" : "short",
    day: "numeric",
  });
}

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
    <div className="flex items-center gap-2.5 rounded-[10px] border border-oo-status-waiting bg-oo-status-waiting-bg px-4 py-[9px]">
      <p className="flex-1 text-[12px] font-medium leading-[18px] text-oo-status-hold">{t("provisionalUiBanner")}</p>
      <AlertTriangle size={16} className="shrink-0 text-oo-status-hold" aria-hidden />
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
      className="flex items-center gap-2.5 rounded-[10px] border-2 border-oo-status-hold bg-oo-status-hold-bg px-4 py-[10px]"
      role="note"
      data-testid="sandbox-banner"
    >
      <p className="flex-1 text-[14px] font-medium leading-[22px] text-oo-status-hold">
        {lang === "ar" ? "مصدر تجريبي: " : "Sandbox source: "}
        {notice}
      </p>
      <FlaskConical size={16} className="shrink-0 text-oo-status-hold" aria-hidden />
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
        <h1 className="text-[24px] font-bold leading-[34px] text-oo-text-primary">{title}</h1>
        {subtitle && (
          <div className="mt-[3px] text-[12px] leading-[18px] text-oo-text-secondary">{subtitle}</div>
        )}
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
      ? "bg-oo-status-blocked-bg border-oo-status-blocked text-oo-status-blocked"
      : kind === "success"
        ? "bg-oo-status-success-bg border-oo-status-success text-oo-status-success"
        : "bg-oo-bg-subtle border-oo-border-strong text-oo-text-secondary";
  return (
    <div
      className={`flex items-start gap-3 rounded-[10px] border px-4 py-3 text-[14px] leading-[22px] ${tone}`}
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
    <div className={`rounded-2xl border border-oo-border-default bg-oo-bg-default p-5 ${className}`}>{children}</div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3">
      <h2 className="text-[18px] font-semibold leading-[28px] text-oo-text-primary">{children}</h2>
      {right}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="py-10 text-center text-[14px] leading-[22px] text-oo-text-muted">{children}</div>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center h-64" role="status" aria-live="polite">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-oo-action-primary border-t-transparent" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

const BTN_BASE =
  "inline-flex items-center gap-2 rounded-[10px] px-[18px] py-[10px] text-[14px] font-medium leading-[22px] transition-colors " +
  "disabled:opacity-50 disabled:cursor-not-allowed " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-action-primary/40 focus-visible:ring-offset-1";

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
      ? "bg-oo-action-primary text-white hover:bg-oo-action-primary-hover"
      : variant === "danger"
        ? "bg-oo-status-blocked text-white hover:opacity-90"
        : variant === "ghost"
          ? "text-oo-text-secondary hover:bg-oo-bg-subtle"
          : "border border-oo-border-strong bg-oo-bg-default text-oo-text-primary hover:border-oo-action-primary";
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
  "w-full rounded-[10px] border border-oo-border-strong bg-oo-bg-default px-[14px] py-[10px] " +
  "text-[14px] leading-[22px] text-oo-text-primary placeholder:text-oo-text-muted " +
  "outline-none transition-colors focus:border-oo-action-primary focus:ring-2 focus:ring-oo-action-primary/20 " +
  "disabled:bg-oo-bg-subtle disabled:text-oo-text-muted";

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
      <label htmlFor={id} className="block text-xs font-bold text-oo-text-secondary">
        {label}
        {required && <span className="text-oo-status-rejected ps-0.5" aria-hidden>*</span>}
      </label>
      {children}
      {hint && !error && <p className="text-[11px] text-oo-text-muted font-medium">{hint}</p>}
      {error && (
        <p id={`${id}-error`} className="text-[11px] text-oo-status-rejected font-bold" role="alert">
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
const CURRENCY_AR: Record<string, string> = { SAR: "ر.س", USD: "$", EUR: "€", AED: "د.إ" };

/**
 * The same money, as a plain string.
 *
 * For the places an amount is part of a sentence or an aria-label and a `<Money>` element
 * cannot go. Same formatter, same numerals, same currency word — so a figure never reads
 * one way in a table cell and another way in the sentence describing it.
 */
export function moneyText(
  value: string | number,
  currency: string,
  lang: "ar" | "en",
  places = 2,
): string {
  const formatted = formatMoney(String(value), places);
  const unit = lang === "ar" ? (CURRENCY_AR[currency] ?? currency) : currency;
  return `${lang === "ar" ? toArabicDigits(formatted) : formatted} ${unit}`;
}

export function Money({
  value,
  currency = "SAR",
  strong,
}: {
  value: string | number | null | undefined;
  currency?: string;
  /** Headline figures — a statement total, a KPI — carry weight. A figure in a table column
   *  does not: the design sets those in ordinary body text. */
  strong?: boolean;
}) {
  const lang = useLang();
  if (value === null || value === undefined || value === "") {
    return <span className="text-oo-text-muted">—</span>;
  }
  const raw = String(value);
  const negative = raw.trim().startsWith("-");
  const formatted = formatMoney(raw);
  const unit = lang === "ar" ? (CURRENCY_AR[currency] ?? currency) : currency;
  return (
    <span
      className={`tabular-nums ${strong ? "font-semibold" : ""} ${
        negative ? "text-oo-status-rejected" : "text-oo-text-primary"
      }`}
      dir={lang === "ar" ? "rtl" : undefined}
    >
      {lang === "ar" ? toArabicDigits(formatted) : formatted} {unit}
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
  // Soft fills for qualifiers that are not one of the stored status enums — "lapsed",
  // "ordered", a share percentage. Status itself uses the outlined badges above.
  const tones: Record<string, string> = {
    neutral: "bg-oo-bg-subtle text-oo-text-secondary",
    good: "bg-oo-status-success-bg text-oo-status-success",
    warn: "bg-oo-status-waiting-bg text-oo-status-waiting",
    bad: "bg-oo-status-blocked-bg text-oo-status-blocked",
    info: "bg-oo-status-preparing-bg text-oo-status-preparing",
    accent: "bg-oo-status-ready-bg text-oo-status-ready",
  };
  return (
    <span
      data-testid={testId}
      className={`inline-block whitespace-nowrap rounded-lg px-2 py-[3px] text-[12px] font-medium leading-[18px] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Status badge tones, taken from the design system's status tokens.
 *
 * Each is a background plus a border-and-text colour, because the design draws these as
 * outlined chips rather than soft pills: `bg` at 50-weight, `border`/`text` at 600–700. The
 * names are the Figma token names (`status/preparing`, `status/ready`, …) rather than
 * good/warn/bad, so a reader can put a badge next to the frame it came from.
 *
 * These values are Tailwind's default palette because the design tokens resolve to exactly
 * those hexes — `status/preparing-bg` is #eff6ff, which is `blue-50`.
 */
const PILL_TONES: Record<string, string> = {
  preparing: "bg-oo-status-preparing-bg border-oo-status-preparing text-oo-status-preparing",
  waiting: "bg-oo-status-waiting-bg border-oo-status-waiting text-oo-status-waiting",
  ready: "bg-oo-status-ready-bg border-oo-status-ready text-oo-status-ready",
  success: "bg-oo-status-success-bg border-oo-status-success text-oo-status-success",
  cancelled: "bg-oo-status-cancelled-bg border-oo-status-cancelled text-oo-status-cancelled",
  rejected: "bg-oo-status-rejected-bg border-oo-status-rejected text-oo-status-rejected",
  hold: "bg-oo-status-hold-bg border-oo-status-hold text-oo-status-hold",
  blocked: "bg-oo-status-blocked-bg border-oo-status-blocked text-oo-status-blocked",
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
/**
 * Geometry is the design's: 28px tall, 10/4 padding, 6px radius, 8px gap, 12/18 medium text,
 * 1px border. Not a soft pill — the outline is what lets these sit legibly on both the white
 * table rows and the subtle page background without a fill heavy enough to shout.
 */
function StatusBadge({ spec, testId }: { spec: Spec | undefined; fallback?: string; testId?: string }) {
  const { lang } = useBadgeLang();
  if (!spec) return null;
  const { Icon } = spec;
  return (
    <span
      data-testid={testId}
      className={`inline-flex h-7 items-center gap-2 rounded-md border px-2.5 py-1 text-[12px] font-medium leading-[18px] whitespace-nowrap ${PILL_TONES[spec.tone]}`}
    >
      <Icon size={16} aria-hidden className="flex-shrink-0" />
      {lang === "ar" ? spec.ar : spec.en}
    </span>
  );
}

function useBadgeLang() {
  const user = useUser();
  return { lang: (user?.preferredLanguage ?? "ar") as "ar" | "en" };
}

/** `LeadStatus` — the 5 stored values. */
/**
 * The seven stored `LeadSource` values.
 *
 * Shared, because the list screen's filter, the create form and the settings screen were
 * each about to keep their own copy, and a source that reads "زيارة" in one place and
 * "زيارة مباشرة" in another looks like two different sources to the person reading it.
 */
export const LEAD_SOURCE_LABELS: Record<string, { en: string; ar: string }> = {
  WALK_IN: { en: "Walk-in", ar: "زيارة" },
  REFERRAL: { en: "Referral", ar: "إحالة" },
  PHONE: { en: "Phone", ar: "هاتف" },
  SOCIAL: { en: "Social media", ar: "وسائل التواصل" },
  EXHIBITION: { en: "Exhibition", ar: "معرض" },
  WEBSITE: { en: "Website", ar: "الموقع" },
  OTHER: { en: "Other", ar: "أخرى" },
};

export const LEAD_STATUS_SPECS: Record<string, Spec> = {
  NEW:         { en: "New",         ar: "جديد",       tone: "preparing", Icon: Circle },
  CONTACTED:   { en: "Contacted",   ar: "تم التواصل", tone: "waiting",   Icon: MessageSquare },
  QUALIFIED:   { en: "Qualified",   ar: "مؤهَّل",      tone: "ready",     Icon: Check },
  UNQUALIFIED: { en: "Unqualified", ar: "غير مؤهَّل",  tone: "cancelled", Icon: XCircle },
  CONVERTED:   { en: "Converted",   ar: "محوَّل",      tone: "success",   Icon: PackageCheck },
};

/** `QuoteStatus` — the 6 stored values. Draft and Superseded share a tone; the icon separates them. */
export const QUOTE_STATUS_SPECS: Record<string, Spec> = {
  DRAFT:      { en: "Draft",      ar: "مسودة",          tone: "cancelled", Icon: Save },
  ISSUED:     { en: "Issued",     ar: "صادر",           tone: "preparing", Icon: FileText },
  ACCEPTED:   { en: "Accepted",   ar: "مقبول",          tone: "success",   Icon: Check },
  REJECTED:   { en: "Rejected",   ar: "مرفوض",          tone: "rejected",  Icon: Ban },
  EXPIRED:    { en: "Expired",    ar: "منتهي الصلاحية", tone: "hold",      Icon: Clock },
  SUPERSEDED: { en: "Superseded", ar: "مستبدَل",         tone: "cancelled", Icon: RotateCcw },
};

/**
 * `AccrualStatus` — the 5 declared values.
 *
 * PREVIEW is declared in the schema and **never written by this build**: accruals are created
 * as ACCRUED and move to APPROVED then PAID. It is mapped here so a row is never unlabelled if
 * that changes, not because the state occurs today.
 */
export const ACCRUAL_STATUS_SPECS: Record<string, Spec> = {
  PREVIEW:  { en: "Preview",  ar: "معاينة", tone: "waiting",   Icon: CircleDashed },
  ACCRUED:  { en: "Accrued",  ar: "مستحَق",  tone: "preparing", Icon: Clock },
  APPROVED: { en: "Approved", ar: "معتمَد",  tone: "ready",     Icon: FileText },
  PAID:     { en: "Paid",     ar: "مدفوع",  tone: "success",   Icon: Check },
  REVERSED: { en: "Reversed", ar: "معكوس",  tone: "cancelled", Icon: RotateCcw },
};

/** `OpportunityOutcome` — outcome is not a stage, and this badge sits beside one rather than replacing it. */
export const DEAL_OUTCOME_SPECS: Record<string, Spec> = {
  OPEN: { en: "Open", ar: "مفتوح", tone: "preparing", Icon: Circle },
  WON:  { en: "Won",  ar: "رابح",  tone: "success",   Icon: Check },
  LOST: { en: "Lost", ar: "خاسر",  tone: "cancelled", Icon: XCircle },
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
        className={`bg-oo-bg-default rounded-2xl shadow-2xl w-full ${wide ? "max-w-3xl" : "max-w-lg"} my-4`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-oo-border-default">
          <h2 className="text-lg font-extrabold text-oo-text-primary">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-oo-text-muted hover:text-oo-text-primary font-black text-xl leading-none px-2"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">{children}</div>
        {footer && (
          <div className="px-5 py-4 border-t border-oo-border-default flex items-center justify-end gap-2 flex-wrap">
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

/**
 * The filter bar above a list.
 *
 * In an RTL document the first child sits on the right. The design puts the search there
 * and the filters on the left, with the magnifier against the search box's leading edge and
 * each chevron against its select's trailing edge — so both icons use logical `start`/`end`
 * rather than a hard side, and the same markup is correct in English.
 */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2.5">{children}</div>;
}

const CONTROL =
  "w-full rounded-[10px] border border-oo-border-strong bg-oo-bg-default py-2.5 text-[14px] " +
  "leading-[22px] text-oo-text-primary outline-none focus:border-oo-action-primary " +
  "focus:ring-2 focus:ring-oo-action-primary/20";

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  testId?: string;
}) {
  return (
    <div className="relative min-w-[200px] flex-1">
      <Search
        size={15}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 start-3.5 my-auto text-oo-text-muted"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        data-testid={testId}
        className={`${CONTROL} ps-10 pe-3.5 placeholder:text-oo-text-muted`}
      />
    </div>
  );
}

export function FilterSelect({
  value,
  onChange,
  label,
  width = "w-[200px]",
  testId,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  width?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className={`relative ${width} shrink-0`}>
      <ChevronDown
        size={14}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 end-3.5 my-auto text-oo-text-secondary"
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        data-testid={testId}
        className={`${CONTROL} appearance-none ps-3.5 pe-9`}
      >
        {children}
      </select>
    </div>
  );
}

export type Col = {
  label: ReactNode;
  /** A width utility — `w-[150px]`, `min-w-[240px]`. The design fixes most columns and lets
   *  exactly one take the slack, so widths belong with the column, not in the cells. */
  w?: string;
  align?: "start" | "end";
};

/**
 * The module's one table shell: the bordered, rounded card IS the table in this design —
 * there is no padded card around it, and the header is a tinted band flush with the edge.
 *
 * Every Sales list was previously a `<Card>` wrapping a bare `<table>` with no cell padding,
 * which is why adjacent headers ran into each other. Putting the geometry here means a route
 * cannot get the density wrong by forgetting a class.
 */
export function DataTable({
  cols,
  minWidth,
  testId,
  children,
}: {
  cols: Col[];
  minWidth: number;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-oo-border-default bg-oo-bg-default">
      {/* The page body must never scroll sideways; the overflow lives on the one element
          that is genuinely too wide. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-start" style={{ minWidth }} data-testid={testId}>
          <thead>
            <tr className="bg-oo-bg-subtle">
              {cols.map((c, i) => (
                <th
                  key={i}
                  scope="col"
                  /* `relative`, because an action column's heading is an `sr-only` span and
                     `sr-only` is absolutely positioned. Without a positioned ancestor it
                     lands against the initial containing block — off the left edge of an
                     RTL page — and makes the whole document scroll sideways by however far
                     the table has been shifted. One pixel of invisible text, ninety pixels
                     of horizontal scroll. */
                  className={`${c.w ?? ""} relative px-4 py-[11px] text-[12px] font-medium leading-[18px] text-oo-text-muted ${
                    c.align === "end" ? "text-end" : "text-start"
                  }`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

/** A body row. The separator is a top border so the header band needs no bottom edge. */
export function Tr({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <tr className="border-t border-oo-border-default" data-testid={testId}>
      {children}
    </tr>
  );
}

export function Td({
  children,
  align,
  className = "",
}: {
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <td
      className={`px-4 py-[13px] align-middle text-[14px] leading-[22px] text-oo-text-primary ${
        align === "end" ? "text-end" : ""
      } ${className}`}
    >
      {children}
    </td>
  );
}

/**
 * The design's headline strip: one bordered box divided into equal cells.
 *
 * The dividers are a 1px grid gap showing the border colour through, rather than
 * `divide-x`, so they land correctly in both directions without a direction-specific
 * utility.
 */
export function StatStrip({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-oo-border-default bg-oo-border-default">
      <div className={`grid gap-px sm:grid-cols-2 ${cols === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4"}`}>
        {children}
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  note,
  money,
  tone,
  testId,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  money?: boolean;
  /** The one figure the reader came for. Everything else stays in the text colour. */
  tone?: "primary" | "action";
  testId?: string;
}) {
  return (
    <div className="bg-oo-bg-default px-5 py-4" data-testid={testId}>
      <p
        className={`text-[24px] font-bold leading-[34px] tabular-nums ${
          tone === "action" ? "text-oo-action-primary" : "text-oo-text-primary"
        }`}
      >
        {money ? <Money value={String(value)} strong /> : value}
      </p>
      <p className="text-[14px] leading-[22px] text-oo-text-primary">{label}</p>
      {note && <p className="text-[12px] leading-[18px] text-oo-text-muted">{note}</p>}
    </div>
  );
}

/**
 * A progress bar with its own caption, as the design draws it.
 *
 * The fill colour carries the same meaning as the status palette does everywhere else —
 * green once the thing is met, amber while it is plausibly on track, red when it is not —
 * and the caption repeats the figure in words, because colour alone is not a reading.
 */
export function ProgressBar({
  percent,
  label,
  width = "w-[220px]",
  testId,
}: {
  percent: number;
  label: string;
  width?: string;
  testId?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const tone =
    percent >= 100 ? "bg-oo-status-success" : percent >= 50 ? "bg-oo-status-waiting" : "bg-oo-status-blocked";
  return (
    <div className="flex flex-col gap-1">
      <div
        className={`${width} h-[10px] overflow-hidden rounded-[10px] bg-oo-bg-subtle`}
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        data-testid={testId}
      >
        <div className={`h-[10px] ${tone}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="text-[12px] leading-[18px] text-oo-text-secondary">{label}</span>
    </div>
  );
}

/** The outlined control that sits in a table's action column. Smaller than `Button`, which
 *  is sized for page-level actions and would set the row height on its own. */
export const ROW_ACTION =
  "inline-flex items-center whitespace-nowrap rounded-[10px] border border-oo-border-strong " +
  "bg-oo-bg-default px-3 py-[7px] text-[12px] leading-[18px] transition-colors";

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
