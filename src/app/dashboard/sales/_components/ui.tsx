"use client";

import { Select as HqSelect } from "@/components/ui/Select";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Ban, Check, Circle, CircleDashed, Clock, FileText,
  MessageSquare, PackageCheck, RotateCcw, Save, Search, XCircle, type LucideIcon,
} from "lucide-react";
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
 * NUMBERS AND DATES FOR AN ARABIC INTERFACE THAT USES LATIN DIGITS.
 *
 * The interface is Arabic and right-to-left; the digits in it are 0–9. Those are separate
 * decisions and this module is where the second one is made, once, for every Sales and
 * Commissions screen.
 *
 * ── Why the locale is pinned, not inherited ──
 * `toLocaleString("ar")` renders ١٢٬٤٥٠ on one machine and 12,450 on another, because the
 * default numbering system for an Arabic locale differs by platform and by browser version.
 * A figure that changes shape depending on who opens the page is not a figure anybody can
 * quote in an email. So every call below names `ar-SA-u-nu-latn` — Arabic locale, Latin
 * numbering system — and nothing here ever falls back to the browser's idea of either.
 *
 * ── Why dates are numeric ──
 * `25/09/2026` is unambiguous, sorts visually, and is the same eleven characters in both
 * languages. Month names are not: they are long, they wrap in a table cell, and in Arabic
 * there are two competing sets of them.
 *
 * ── What is NOT transformed ──
 * Anything a customer typed. A company name, a note, an address, a rejection reason —
 * whatever numerals a person wrote are theirs and are stored and shown exactly as written.
 * The audit in `scripts/e2e/regression/sales-digits-audit.mjs` excludes those fields by
 * name, and the exclusions are listed there.
 */

/** Arabic labels, Latin digits. Named explicitly so no platform gets a vote. */
const AR_LATN = "ar-SA-u-nu-latn-ca-gregory";
const EN = "en-GB";
const locale = (lang: "ar" | "en") => (lang === "ar" ? AR_LATN : EN);

/**
 * A count: `42`, `12,450`.
 *
 * Grouping is Latin (comma) in both languages, because the group separator has to match the
 * digits it separates — ١٢٬٤٥٠ with Latin digits reads as a typo.
 */
export function num(n: number, _lang: "ar" | "en" = "ar"): string {
  return n.toLocaleString("en-US");
}

/** A percentage the way the design writes one: `2.5%`, `38%`. Never `%`. */
export function percent(value: number | string, places?: number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  const text = places === undefined
    ? String(Number(n.toFixed(6)))
    : n.toFixed(places);
  return `${text}%`;
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
    d.toLocaleDateString(locale(lang), { month: "long", year: "numeric" });
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

/** `25/09/2026`. Zero-padded so a column of dates lines up. */
export function formatDay(value: string | Date | null | undefined, _lang?: "ar" | "en"): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** `15:00`, twenty-four hour. The one time format that needs no am/pm in either language. */
export function formatTime(value: string | Date): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * When something is due, in the words a work queue needs.
 *
 * Near dates read as "today"/"tomorrow" plus a time, because a follow-up list is about what
 * happens next and a reader should not have to subtract dates to find out. Anything further
 * out is the plain numeric date.
 */
export function formatWhen(value: string | Date | null | undefined, lang: "ar" | "en"): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(new Date())) / 86_400_000);
  const time = formatTime(d);
  if (days === 0) return `${lang === "ar" ? "اليوم" : "Today"} ${time}`;
  if (days === 1) return `${lang === "ar" ? "غداً" : "Tomorrow"} ${time}`;
  if (days === -1) return `${lang === "ar" ? "أمس" : "Yesterday"} ${time}`;
  return formatDay(d);
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
    <div data-ui="page-header" className="flex items-start justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <h1 className="text-[24px] font-bold leading-[34px] text-oo-text-primary">{title}</h1>
        {subtitle && (
          <div data-ui="page-header-sub" className="mt-[3px] text-[12px] leading-[18px] text-oo-text-secondary">{subtitle}</div>
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
      data-ui="alert"
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
    <div data-ui="card" className={`rounded-2xl border border-oo-border-default bg-oo-bg-default p-5 ${className}`}>{children}</div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div data-ui="section-title" className="flex items-center justify-between gap-2 mb-3">
      <h2 className="text-[18px] font-semibold leading-[28px] text-oo-text-primary">{children}</h2>
      {right}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div data-ui="empty" className="py-10 text-center text-[14px] leading-[22px] text-oo-text-muted">{children}</div>
  );
}

export function Spinner() {
  return (
    <div data-ui="spinner" className="flex items-center justify-center h-64" role="status" aria-live="polite">
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
      data-ui="btn"
      data-variant={variant}
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
    <div data-ui="field" className="space-y-1">
      <label htmlFor={id} className="block text-xs font-bold text-oo-text-secondary">
        {label}
        {required && <span className="text-oo-status-rejected ps-0.5" aria-hidden>*</span>}
      </label>
      {children}
      {hint && !error && <p data-ui="field-hint" className="text-[11px] text-oo-text-muted font-medium">{hint}</p>}
      {error && (
        <p id={`${id}-error`} data-ui="field-error" className="text-[11px] text-oo-status-rejected font-bold" role="alert">
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
      data-ui="input"
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
    <HqSelect
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      data-ui="input"
      className={FIELD_BASE}
    >
      {children}
    </HqSelect>
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
      data-ui="input"
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
  return `${formatted} ${unit}`;
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
  // The figure is wrapped in <bdi>. A Latin-digit amount sitting in Arabic text is a
  // direction-neutral run, and the bidi algorithm will happily reorder it against whatever
  // is beside it — "12,450.00" after a full stop can come out as "00.450,12", and a minus
  // sign migrates to the wrong end. <bdi> isolates it so the number is laid out on its own
  // terms and then placed as a unit.
  return (
    <span
      className={`${strong ? "font-semibold" : ""} ${
        negative ? "text-oo-status-rejected" : "text-oo-text-primary"
      }`}
    >
      <bdi className="tabular-nums">{formatted}</bdi> {unit}
    </span>
  );
}

/**
 * An identifier or a bare number, isolated from the text around it.
 *
 * For quotation numbers, order numbers, collection references, phone numbers — anything
 * that is read as one token and must not be reordered by the surrounding Arabic. This is
 * the reason `OF-1042` does not render as `1042-OF`.
 */
export function Num({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <bdi className={`tabular-nums ${className}`}>{children}</bdi>;
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
      data-ui="pill"
      data-tone={tone}
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
      data-ui="status"
      data-tone={spec.tone}
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

export function LeadStatusBadge({ status, testId }: { status: string; testId?: string }) {
  return <StatusBadge spec={LEAD_STATUS_SPECS[status]} testId={testId} />;
}

/**
 * A modal dialog.
 *
 * Closes on Escape and on a click outside, both of which people try before looking for the
 * ×. `aria-modal` and a labelled heading are what make it a dialog to a screen reader
 * rather than a div that happens to be on top.
 */
/**
 * Focus, the way a modal dialog is expected to behave (IMD-13).
 *
 * Opening used to leave focus on the button behind the scrim, so an Escape handled on the
 * scrim never reached the dialog unless the user had first clicked into a field, Tab walked
 * through the page underneath, and closing dropped focus at the top of the document. With
 * this hook: focus moves in on open (to an autofocused control, else the first field, else
 * the dialog itself), Escape closes from anywhere, Tab stays inside, and focus returns to the
 * control that opened it. Hang the returned ref on the element with role="dialog" and give
 * it tabIndex={-1}.
 */
export function useModalFocus(onClose: () => void) {
  const box = useRef<HTMLDivElement | null>(null);
  // Read during the first render, before any autoFocus inside the dialog has moved focus.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null));
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const el = box.current;
    const focusables = () =>
      Array.from(el?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]):not(.hq-native), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (el && !el.contains(document.activeElement)) {
      const field = el.querySelector<HTMLElement>("input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])");
      (field ?? el).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close.current(); return; }
      if (e.key !== "Tab" || !el) return;
      const list = focusables();
      if (list.length === 0) { e.preventDefault(); el.focus(); return; }
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [opener]);
  return box;
}

/** The dialog box itself, for screens that draw their own scrim and layout but need the same
    focus behaviour as `Modal` (see `useModalFocus`). */
export function FocusDialog({
  onClose, children, className = "", testId, labelledBy, label,
}: {
  onClose: () => void; children: ReactNode; className?: string; testId?: string;
  labelledBy?: string; label?: string;
}) {
  const box = useModalFocus(onClose);
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      data-testid={testId}
      data-ui="dialog"
      onClick={(e) => e.stopPropagation()}
      className={`outline-none ${className}`}
    >
      {children}
    </div>
  );
}

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
  const box = useModalFocus(onClose);

  return (
    <div
      data-ui="dialog-scrim"
      className="fixed inset-0 bg-black/40 z-[60] flex items-start sm:items-center justify-center p-3 overflow-y-auto"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        data-ui="dialog"
        onClick={(e) => e.stopPropagation()}
        className={`bg-oo-bg-default rounded-2xl shadow-2xl w-full outline-none ${wide ? "max-w-3xl" : "max-w-lg"} my-4`}
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
    <div data-ui="search" className="relative min-w-[200px] flex-1">
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
    <div data-ui="stat" className="bg-oo-bg-default px-5 py-4" data-testid={testId}>
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
  "ui-row-action inline-flex items-center whitespace-nowrap rounded-[10px] border border-oo-border-strong " +
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
