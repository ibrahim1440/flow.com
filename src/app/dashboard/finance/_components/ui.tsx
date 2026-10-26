"use client";

// Finance (cash & budget) — data helpers and the screen pieces, on Direction 2.1.
//
// UI batch 2 (finance): the six screens moved from the old CYWyp FIN-01…06 kit onto the shared
// Direction 2.1 primitives (HR kit + operations scope, as the batch-1 stock screens), to the GX
// B-P01…B-P07 frames (Figma 1JbZgpMqmPkUVne8ms9Ozz). The data half of this file — `api`,
// `useApi`, the branch context, the language and money helpers — is unchanged; the visual
// pieces keep their names and props so every page keeps its logic, and now render the HR / ops
// primitives (`hr-btn`, `hr-table`, `hr-notice`, `hr-state`, the HR Dialog) with finance.css for
// the few finance-only blocks. No colour, size or pattern here is new: tokens only.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { localizeApiError, networkErrorText } from "@/lib/i18n/api-errors";
import { useI18n } from "@/lib/i18n/context";
import { formatSAR } from "@/lib/finance/money";
import { Dialog as HrDialog } from "@/components/hr/ui";
import { OpsError, OpsLoading } from "@/components/ops/ui";

// ─── Language helpers ─────────────────────────────────────────────────────────

export function useL() {
  const { lang } = useI18n();
  const L = useCallback((ar: string, en: string) => (lang === "ar" ? ar : en), [lang]);
  const money = useCallback((minor: number | null | undefined, opts?: { sign?: boolean }) => (minor === null || minor === undefined ? "—" : formatSAR(minor, lang, { ...opts, plain: true })), [lang]);
  const sar = useCallback((minor: number | null | undefined, opts?: { sign?: boolean }) => (minor === null || minor === undefined ? "—" : formatSAR(minor, lang, opts)), [lang]);
  const pct = useCallback((bp: number | null | undefined) => {
    if (bp === null || bp === undefined) return "—";
    const s = `${bp > 0 ? "+" : bp < 0 ? "−" : ""}${(Math.abs(bp) / 100).toFixed(2)}%`;
    return lang === "ar" ? `⁦${s}⁩` : s;
  }, [lang]);
  const name = useCallback((o: { nameAr?: string | null; nameEn: string } | null | undefined) => (o ? (lang === "ar" && o.nameAr ? o.nameAr : o.nameEn) : "—"), [lang]);
  return { L, lang, money, sar, pct, name };
}

// ─── Finance context (branch scope + refresh) ────────────────────────────────

type FinanceCtx = { branch: string; setBranch: (b: string) => void; version: number; refresh: () => void };
export const FinanceContext = createContext<FinanceCtx>({ branch: "", setBranch: () => {}, version: 0, refresh: () => {} });
export const useFinance = () => useContext(FinanceContext);

/** Adds ?branch= when a branch is selected. */
export function withBranch(url: string, branch: string) {
  if (!branch) return url;
  return url + (url.includes("?") ? "&" : "?") + "branch=" + encodeURIComponent(branch);
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) { super(message); this.status = status; this.details = details; }
}

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  }).catch(() => { throw new ApiError(networkErrorText(), 0); });
  const data = await res.json().catch(() => null);
  // The refusal in the page's language (the body's Arabic, else the shared table), as the other modules do.
  if (!res.ok) throw new ApiError((data && localizeApiError(data)) || `Request failed (${res.status})`, res.status, data?.details);
  return data as T;
}

/** GET with loading / error / reload, re-run on branch or version change. */
export function useApi<T>(url: string | null) {
  const { branch, version } = useFinance();
  const [tick, setTick] = useState(0);
  // Loading is derived: the request key the current state belongs to differs from the key
  // being asked for. Previous data stays on screen while a refresh is in flight.
  const target = url ? withBranch(url, branch) : null;
  const key = target ? `${target}#${version}#${tick}` : null;
  const [state, setState] = useState<{ key: string | null; data: T | null; error: ApiError | null }>({ key: null, data: null, error: null });
  const latest = useRef<string | null>(null);
  useEffect(() => {
    latest.current = key;
    if (!key || !target) return;
    api<T>(target)
      .then((d) => { if (latest.current === key) setState({ key, data: d, error: null }); })
      .catch((e) => { if (latest.current === key) setState((s) => ({ key, data: s.data, error: e instanceof ApiError ? e : new ApiError(String(e), 0) })); });
  }, [key, target]);
  const loading = !!key && state.key !== key;
  return { data: state.data, error: loading ? null : state.error, loading, reload: () => setTick((t) => t + 1) };
}

// ─── Primitives (Direction 2.1) ───────────────────────────────────────────────

/**
 * A section of the page. The GX frames draw no boxed cards: blocks sit on the sheet, separated
 * by a hairline and a section head («التنبيهات · مرتبة حسب الأهمية»). `pad` is kept for the
 * callers' sake and ignored.
 */
export function Card({ children, className = "" }: { children: ReactNode; className?: string; pad?: string }) {
  return <section className={`fin-sec ${className}`}>{children}</section>;
}

/** Section head: title, an inline muted caption, and the end actions. */
export function CardTitle({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="fin-head">
      <h2>{title}</h2>
      {sub ? <p className="hr-caption">{sub}</p> : null}
      {right ? <div className="fin-head-end">{right}</div> : null}
    </div>
  );
}

const TONE = { ok: "success", warn: "warning", bad: "danger", info: "neutral", brand: "info" } as const;
export type Tone = keyof typeof TONE;

/** A tinted chip (the frames' «غير مصنفة», «28 سبتمبر», policy chips). */
export function Badge({ children, tone = "info" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`fin-chip tone-${TONE[tone]}`}>{children}</span>;
}

/** A status as a dot and its label (the frames' «• مُراجعة», «• محجوز», «• ممول»). */
export function Status({ children, tone = "info" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`hr-dot tone-${TONE[tone]}`}><span>{children}</span></span>;
}

/**
 * The HR button. `icon` is accepted and not drawn: the GX frames' finance buttons are text
 * only. `kind` maps onto the HR variants.
 */
export function Button({ children, kind = "secondary", disabled, onClick, type = "button", busy, className = "", title, size }: {
  children: ReactNode; kind?: "primary" | "secondary" | "danger" | "ghost"; icon?: React.ElementType; disabled?: boolean;
  onClick?: () => void; type?: "button" | "submit"; busy?: boolean; className?: string; title?: string; size?: "sm";
}) {
  return (
    <button type={type} title={title} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick}
      className={`hr-btn${kind !== "secondary" ? ` is-${kind}` : ""}${size ? " is-sm" : ""} ${className}`}>
      {busy ? "…" : null}
      {children}
    </button>
  );
}

/**
 * A metric cell («النقد المؤكد في الحسابات · 412,900.00 · مقيد 0.00»), drawn as one cell of a
 * `.stk-metrics` strip (stock.css): label, value, caption. Wrap several in `<Metrics>`.
 */
export function Kpi({ label, value, sub, valueClass = "" }: { label: string; value: ReactNode; sub?: ReactNode; icon?: React.ElementType; tone?: string; valueClass?: string }) {
  return (
    <div>
      <span className="stk-lbl">{label}</span>
      <span className={`stk-mid ${valueClass}`}>{value}</span>
      {sub ? <span className="stk-d">{sub}</span> : null}
    </div>
  );
}

/** The metric strip (stock.css `.stk-metrics`): equal columns with a hairline between them. */
export function Metrics({ children, cols, className = "" }: { children: ReactNode; cols: number; className?: string }) {
  return <div className={`stk-metrics fin-metrics ${className}`} style={{ ["--stk-cols" as string]: cols }}>{children}</div>;
}

/** Control class for native inputs and selects (the ERP keeps native controls, D7). */
export const INPUT = "hr-input fin-input";

export function Field({ label, error, children, hint }: { label?: string; error?: string | null; children: ReactNode; hint?: string }) {
  return (
    <label className="hr-field">
      {label ? <span className="hr-label">{label}</span> : null}
      {children}
      {error ? <span className="hr-err">{error}</span> : hint ? <span className="hr-help">{hint}</span> : null}
    </label>
  );
}

/** The operations segmented control (ops.css `.ops-seg`). */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label?: string }) {
  return (
    <div className="ops-seg fin-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

// ─── Tables ───────────────────────────────────────────────────────────────────

/** The HR hairline table. `className` reaches the table (e.g. `is-mrow` for phone list rows). */
export function Table({ children, className = "", label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div className="hr-tablewrap fin-tablewrap">
      <table className={`hr-table fin-table ${className}`} aria-label={label}>{children}</table>
    </div>
  );
}
export function Th({ children, num, className = "" }: { children?: ReactNode; num?: boolean; className?: string }) {
  return <th className={`${num ? "num " : ""}${className}`}>{children}</th>;
}
export function Td({ children, num, className = "", onClick }: { children?: ReactNode; num?: boolean; className?: string; onClick?: () => void }) {
  return <td onClick={onClick} className={`${num ? "num " : ""}${className}`}>{children}</td>;
}

// ─── States ───────────────────────────────────────────────────────────────────

export function LoadingState({ label }: { label?: string }) {
  const { L } = useL();
  return <OpsLoading rows={5} label={label ?? L("جارٍ تحميل البيانات المالية…", "Loading financial data…")} />;
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }) {
  const { L } = useL();
  if (error instanceof ApiError && error.status === 403) return <NoPermission />;
  return (
    <div className="fin-stack">
      <OpsError message={L("لم تُعرض أرقام ناقصة. أعد المحاولة، وإن استمر الخطأ فأبلغ مسؤول النظام.", "No partial figures are shown. Try again; if it persists, tell your system administrator.")} onRetry={onRetry} />
      <p className="hr-caption fin-errdetail">{error.message}</p>
    </div>
  );
}

export function NoPermission() {
  const { L } = useL();
  return (
    <div className="hr-state" role="status">
      <h3>{L("لا تملك صلاحية الوصول", "You do not have access")}</h3>
      <p className="hr-caption" style={{ margin: 0 }}>{L("هذه الشاشة غير متاحة لدورك. تواصل مع المدير إن كنت تحتاجها.", "This screen is not available to your role. Ask your manager if you need it.")}</p>
    </div>
  );
}

export function EmptyState({ title, body, children }: { title: string; body?: string; children?: ReactNode; icon?: React.ElementType }) {
  return (
    <div className="hr-state">
      <h3>{title}</h3>
      {body ? <p className="hr-caption" style={{ margin: 0, maxWidth: 460 }}>{body}</p> : null}
      {children ? <div className="fin-row fin-center">{children}</div> : null}
    </div>
  );
}

const NOTICE = { ok: "success", warn: "warning", bad: "danger", info: "info", brand: "info" } as const;
export function Notice({ tone = "warn", children }: { tone?: Tone; children: ReactNode; icon?: React.ElementType }) {
  return <div className={`hr-notice tone-${NOTICE[tone]} fin-notice`} role={tone === "bad" ? "alert" : undefined}>{children}</div>;
}

// ─── Collapsible section ─────────────────────────────────────────────────────
// Native <details>/<summary> (the ERP uses native controls): keyboard and screen-reader
// support come with the element. Closed by default. Drawn as the frame's label · value row
// («الربط بمستند · لا يوجد»).

export function Section({ title, summary, children, testId }: { title: string; summary?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <details className="fin-disclose" data-testid={testId}>
      <summary>
        <span>{title}</span>
        {summary !== undefined ? <span className="fin-disclose-sum">{summary}</span> : null}
      </summary>
      <div className="fin-disclose-body">{children}</div>
    </details>
  );
}

// ─── Dialog ───────────────────────────────────────────────────────────────────

/**
 * The HR Dialog (modal, focus trap, Esc, phone sheet). The finance dialogs keep their actions in
 * the body, as before; `width` (a legacy max-width class) picks the wide variant.
 */
export function Dialog({ open, onClose, title, sub, children, width }: { open: boolean; onClose: () => void; title: string; sub?: string; children: ReactNode; width?: string }) {
  const { L } = useL();
  const px = Number(/\[(\d+)px\]/.exec(width ?? "")?.[1] ?? 560);
  const cls = px >= 900 ? "fin-dlg-xl" : px >= 700 ? "fin-dlg-lg" : px > 560 ? "fin-dlg-md" : undefined;
  return <HrDialog open={open} onClose={onClose} title={title} sub={sub} className={cls} closeLabel={L("إخفاء النافذة", "Close dialog")}>{children}</HrDialog>;
}

/** A stable key per form mount, so a double-submitted request lands once. */
export function useIdempotencyKey() {
  const [key, setKey] = useState(() => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())));
  return { key, renew: () => setKey(crypto.randomUUID()) };
}

export function useHasSub(permissions: Record<string, { access: string; sub?: Record<string, boolean> }> | undefined, sub: string) {
  const f = permissions?.finance;
  return !!f && f.access !== "none" && !!f.sub?.[sub];
}

// ─── Chart colours ────────────────────────────────────────────────────────────

const TOKEN_DEFAULTS = { primary: "#5c5c38", soft: "#e3dccb", grid: "#efe9dc", muted: "#6e6a61", danger: "#b42318", plan: "#c9bfa6" };
/**
 * The Direction 2.1 token values the charts need. Recharts draws SVG presentation attributes,
 * which cannot read CSS variables, so the values are read once from the page's computed style
 * (the hex values here are only the fallback before mount).
 */
const readTokens = (): string => {
  const cs = getComputedStyle(document.querySelector("[data-fin-root]") ?? document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return JSON.stringify({ primary: v("--action-primary", TOKEN_DEFAULTS.primary), soft: v("--border-strong", TOKEN_DEFAULTS.soft), grid: v("--border-subtle", TOKEN_DEFAULTS.grid), muted: v("--text-muted", TOKEN_DEFAULTS.muted), danger: v("--status-danger", TOKEN_DEFAULTS.danger), plan: v("--border-control", TOKEN_DEFAULTS.plan) });
};
const DEFAULT_TOKENS = JSON.stringify(TOKEN_DEFAULTS);
export function useChartTokens(): typeof TOKEN_DEFAULTS {
  const key = useSyncExternalStore(() => () => {}, readTokens, () => DEFAULT_TOKENS);
  return useMemo(() => JSON.parse(key) as typeof TOKEN_DEFAULTS, [key]);
}
