"use client";

// Finance UI kit. Measurements follow the Figma frames on page "15 — Finance · Cash & Budget"
// (cards 16px radius / 20px padding, 13px table text, 11px table headers, 12px labels).
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, Loader2, RefreshCw, ShieldAlert, X, Inbox } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { formatSAR } from "@/lib/finance/money";

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
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data?.details);
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

// ─── Primitives ───────────────────────────────────────────────────────────────

export function Card({ children, className = "", pad = "p-5" }: { children: ReactNode; className?: string; pad?: string }) {
  return <div className={`bg-white rounded-2xl border border-border shadow-sm ${pad} flex flex-col gap-3 min-w-0 ${className}`}>{children}</div>;
}

export function CardTitle({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <h2 className="text-[15px] font-extrabold text-charcoal">{title}</h2>
        {sub && <p className="text-xs text-brown mt-0.5">{sub}</p>}
      </div>
      {right && <div className="flex items-center gap-2 flex-wrap">{right}</div>}
    </div>
  );
}

const TONES = {
  ok: "bg-green-100 text-green-700",
  warn: "bg-amber-100 text-amber-700",
  bad: "bg-red-100 text-red-700",
  info: "bg-slate-100 text-slate-600",
  brand: "bg-orange-light text-orange",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "info" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}

export function Button({ children, kind = "secondary", icon: Icon, disabled, onClick, type = "button", busy, className = "", title }: {
  children: ReactNode; kind?: "primary" | "secondary" | "danger" | "ghost"; icon?: React.ElementType; disabled?: boolean;
  onClick?: () => void; type?: "button" | "submit"; busy?: boolean; className?: string; title?: string;
}) {
  const k = {
    primary: "bg-orange text-white hover:bg-orange-dark border border-orange",
    secondary: "bg-white text-charcoal border border-border hover:bg-cream",
    danger: "bg-white text-red-600 border border-red-100 hover:bg-red-50",
    ghost: "text-brown hover:bg-cream border border-transparent",
  }[kind];
  return (
    <button type={type} title={title} disabled={disabled || busy} onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${k} ${className}`}>
      {busy ? <Loader2 size={16} className="animate-spin" /> : Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}

export function Kpi({ label, value, sub, icon: Icon, tone = "brand", valueClass = "" }: { label: string; value: ReactNode; sub?: ReactNode; icon: React.ElementType; tone?: "brand" | "teal" | "blue" | "bad" | "ok" | "warn" | "slate"; valueClass?: string }) {
  const bg = { brand: "bg-orange", teal: "bg-teal-600", blue: "bg-blue-600", bad: "bg-red-600", ok: "bg-green-600", warn: "bg-amber-700", slate: "bg-slate-600" }[tone];
  return (
    <div className="bg-white rounded-2xl border border-border shadow-sm p-4 flex items-center gap-4 min-w-0">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${bg}`}><Icon size={20} className="text-white" /></div>
      <div className="min-w-0">
        <p className="text-xs font-bold text-brown truncate">{label}</p>
        <p className={`text-xl font-extrabold text-charcoal leading-tight tabular-nums ${valueClass}`}>{value}</p>
        {sub && <p className="text-[11px] text-brown mt-0.5 truncate">{sub}</p>}
      </div>
    </div>
  );
}

export const INPUT = "w-full px-3 py-2 border-2 border-border rounded-[10px] text-[13px] bg-white outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 transition-colors";

export function Field({ label, error, children, hint }: { label?: string; error?: string | null; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      {label && <span className="text-xs font-bold text-brown">{label}</span>}
      {children}
      {hint && !error && <span className="text-[11px] text-brown">{hint}</span>}
      {error && <span className="text-[11px] text-red-700">{error}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex flex-wrap max-w-full p-[3px] gap-0.5 rounded-[10px] bg-cream-dark">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${value === o.value ? "bg-white text-charcoal shadow-sm" : "text-gray-600 hover:text-charcoal"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Tables ───────────────────────────────────────────────────────────────────

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    // tabIndex: a horizontally scrolling region must be reachable by keyboard (WCAG 2.1.1).
    <div tabIndex={0} className={`rounded-xl border border-border overflow-x-auto bg-white focus-visible:outline-2 focus-visible:outline-orange ${className}`}>
      <table className="w-full text-[13px] border-collapse">{children}</table>
    </div>
  );
}
export function Th({ children, num, className = "" }: { children?: ReactNode; num?: boolean; className?: string }) {
  return <th className={`bg-cream-dark px-3 py-2.5 text-[11px] font-bold text-gray-600 whitespace-nowrap ${num ? "ltr:text-right rtl:text-left" : "text-start"} ${className}`}>{children}</th>;
}
export function Td({ children, num, className = "", onClick }: { children?: ReactNode; num?: boolean; className?: string; onClick?: () => void }) {
  return <td onClick={onClick} className={`px-3 py-[11px] border-t border-border-light align-middle ${num ? "ltr:text-right rtl:text-left tabular-nums whitespace-nowrap" : "text-start"} ${className}`}>{children}</td>;
}

// ─── States ───────────────────────────────────────────────────────────────────

export function LoadingState({ label }: { label?: string }) {
  const { L } = useL();
  return (
    <div className="bg-white rounded-2xl border border-border p-5 flex flex-col gap-3" aria-busy="true">
      {[55, 90, 75, 90, 45].map((w, i) => <div key={i} className="h-3.5 rounded-full bg-border animate-pulse" style={{ width: `${w}%` }} />)}
      <p className="text-xs text-brown">{label ?? L("جارٍ تحميل البيانات المالية…", "Loading financial data…")}</p>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }) {
  const { L } = useL();
  if (error instanceof ApiError && error.status === 403) return <NoPermission />;
  return (
    <div className="bg-white rounded-2xl border-2 border-red-100 p-6 flex flex-col items-center gap-2.5 text-center" role="alert">
      <div className="w-12 h-12 rounded-xl bg-red-100 flex items-center justify-center"><AlertTriangle size={22} className="text-red-600" /></div>
      <h3 className="text-base font-extrabold text-charcoal">{L("تعذّر تحميل البيانات", "Could not load the data")}</h3>
      <p className="text-[13px] text-brown max-w-sm">{L("لم تُعرض أرقام ناقصة. أعد المحاولة، وإن استمر الخطأ فأبلغ مسؤول النظام.", "No partial figures are shown. Try again; if it persists, tell your system administrator.")}</p>
      <p className="text-[11px] text-brown">{error.message}</p>
      {onRetry && <Button icon={RefreshCw} onClick={onRetry}>{L("إعادة المحاولة", "Try again")}</Button>}
    </div>
  );
}

export function NoPermission() {
  const { L } = useL();
  return (
    <div className="bg-white rounded-2xl border border-border p-7 flex flex-col items-center gap-2.5 text-center">
      <div className="w-12 h-12 rounded-xl bg-red-100 flex items-center justify-center"><ShieldAlert size={22} className="text-red-600" /></div>
      <h3 className="text-lg font-extrabold text-charcoal">{L("لا تملك صلاحية الوصول", "You do not have access")}</h3>
      <p className="text-[13px] text-brown max-w-sm">{L("هذه الشاشة غير متاحة لدورك. تواصل مع المدير إن كنت تحتاجها.", "This screen is not available to your role. Ask your manager if you need it.")}</p>
    </div>
  );
}

export function EmptyState({ title, body, children, icon: Icon = Inbox }: { title: string; body?: string; children?: ReactNode; icon?: React.ElementType }) {
  return (
    <div className="bg-white rounded-2xl border border-border p-7 flex flex-col items-center gap-2.5 text-center">
      <div className="w-14 h-14 rounded-full bg-orange-light flex items-center justify-center"><Icon size={24} className="text-orange" /></div>
      <h3 className="text-base font-extrabold text-charcoal">{title}</h3>
      {body && <p className="text-[13px] text-brown max-w-md">{body}</p>}
      {children && <div className="flex gap-2 flex-wrap justify-center mt-1">{children}</div>}
    </div>
  );
}

export function Notice({ tone = "warn", children, icon: Icon = AlertTriangle }: { tone?: Tone; children: ReactNode; icon?: React.ElementType }) {
  return (
    <div className={`flex items-start gap-2.5 px-3.5 py-3 rounded-xl text-[13px] font-medium ${TONES[tone]}`}>
      <Icon size={18} className="flex-shrink-0 mt-0.5" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ─── Collapsible section ─────────────────────────────────────────────────────
// Native <details>/<summary> (the ERP uses native controls): keyboard and screen-reader
// support come with the element. Closed by default unless `open` is passed.

export function Section({ title, summary, children, testId }: { title: string; summary?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <details className="group rounded-[10px] border border-border-light" data-testid={testId}>
      <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer select-none text-xs font-bold text-brown list-none [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-1.5"><ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden />{title}</span>
        {summary !== undefined && <span className="font-medium text-brown-light tabular-nums">{summary}</span>}
      </summary>
      <div className="px-3 pb-3 pt-1 flex flex-col gap-2">{children}</div>
    </details>
  );
}

// ─── Dialog ───────────────────────────────────────────────────────────────────

export function Dialog({ open, onClose, title, sub, children, width = "max-w-[560px]" }: { open: boolean; onClose: () => void; title: string; sub?: string; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] bg-gray-900/45 flex items-start justify-center overflow-y-auto p-4 sm:p-10" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`w-full ${width} bg-white rounded-2xl shadow-2xl p-6 flex flex-col gap-4`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold text-charcoal">{title}</h2>
            {sub && <p className="text-xs text-brown mt-0.5">{sub}</p>}
          </div>
          <button type="button" onClick={onClose} className="text-brown-light hover:text-charcoal" aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
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
