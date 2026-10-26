"use client";
// Native HR — shared UI kit (Direction 2.1, scoped by [data-hr-root]; see hr.css).
// Pages fetch JSON from /api/hr/* and render with these pieces. Every control here is a
// convenience: the API re-checks each duty, so a hidden button is never the security.
import { Select } from "@/components/ui/Select";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { SectionPages } from "@/components/shell/page-context";
import "./hr.css";
import { useI18n } from "@/lib/i18n/context";
import { localizeApiError, networkErrorText } from "@/lib/i18n/api-errors";
import { hrTr, monthLabel, type HrKey } from "@/lib/i18n/hr";
import type { Lang } from "@/lib/i18n/translations";

// ── Language ───────────────────────────────────────────────────────────────────────

/**
 * The HR screens' language helpers. `L(ar, en)` picks the sentence for the viewer's language
 * (the finance/CRM pattern); `t(key)` reads the shared HR dictionary (src/lib/i18n/hr.ts).
 * The direction comes from the shell (`dir` on the Direction 2.1 root), never from here.
 */
export function useHrI18n() {
  const { lang } = useI18n();
  const L = useCallback((ar: string, en: string) => (lang === "en" ? en : ar), [lang]);
  const t = useCallback((key: HrKey) => hrTr(key, lang), [lang]);
  const month = useCallback((m: string) => monthLabel(m, lang), [lang]);
  return { lang, en: lang === "en", L, t, month };
}

/** The page language outside React (error text from fetches): the root `<html lang>`. */
const docLang = (): Lang => (typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "ar");

// ── Data ───────────────────────────────────────────────────────────────────────────

export class HrApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The refusal in the viewer's language: HR routes return Arabic as `error` and the service's
 * exact English as `errorEn` (src/lib/hr/http.ts). Other routes may return one `error` only.
 */
export function pickError(body: unknown, status: number, lang: Lang = docLang()): string {
  // The shared picker: the body's Arabic (errorAr, an Arabic error, the shared table) for Arabic, errorEn for English.
  return localizeApiError(body, lang) ?? `HTTP ${status}`;
}

export async function hrFetch<T = unknown>(url: string, init?: { method?: string; json?: unknown; form?: FormData }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? (init?.json !== undefined || init?.form ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.form ?? (init?.json !== undefined ? JSON.stringify(init.json) : undefined),
    cache: "no-store",
  }).catch(() => { throw new HrApiError(networkErrorText(), 0, null); });
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await res.json().catch(() => ({})) : null;
  if (!res.ok) throw new HrApiError(pickError(body, res.status), res.status, (body as { code?: string })?.code ?? null);
  return body as T;
}

export function useHr<T>(url: string | null) {
  // Loading is derived (the finance useApi pattern): the key the current state belongs to
  // differs from the key being asked for. Previous data stays on screen while refreshing.
  const [tick, setTick] = useState(0);
  const key = url ? `${url}#${tick}` : null;
  const [state, setState] = useState<{ key: string | null; data: T | null; error: HrApiError | null }>({ key: null, data: null, error: null });
  const latest = useRef<string | null>(null);
  useEffect(() => {
    latest.current = key;
    if (!key || !url) return;
    hrFetch<T>(url)
      .then((d) => { if (latest.current === key) setState({ key, data: d, error: null }); })
      .catch((e) => { if (latest.current === key) setState((s) => ({ key, data: s.data, error: e instanceof HrApiError ? e : new HrApiError(String(e), 0, null) })); });
  }, [key, url]);
  const loading = !!key && state.key !== key;
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((d: T | null) => setState((s) => ({ ...s, data: d })), []);
  return { data: state.data, error: loading ? null : state.error, loading, reload, setData };
}

/** Run a mutation, remember its error, and expose a busy flag for the button that started it. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, setError, run };
}

// ── HR meta (duties + reference lists) ─────────────────────────────────────────────

export type HrCaps = Record<string, boolean>;
export type HrMeta = {
  caps: HrCaps;
  /** The caller's login id, to tell their own draft from someone else's. */
  actorId: string;
  allBranches: boolean;
  selfEmployeeId: string | null;
  departments: { id: string; code: string; nameAr: string }[];
  branches: { id: string; code: string; nameAr: string | null; nameEn: string }[];
  leaveTypes: { id: string; code: string; nameAr: string; paid: boolean; tracksBalance: boolean; isProposal: boolean }[];
  shifts: { id: string; code: string; name: string; startTime: string; endTime: string }[];
  people: { id: string; employeeNo: string; fullNameAr: string; jobTitle: string }[];
  policy: { version: number; dayBasis: string; timezone: string; isProposal: boolean; weekendDays: number[] } | null;
};
const MetaCtx = createContext<{ meta: HrMeta | null; reload: () => void }>({ meta: null, reload: () => {} });
export function HrMetaProvider({ children }: { children: ReactNode }) {
  const { data, reload } = useHr<HrMeta>("/api/hr/meta");
  return <MetaCtx.Provider value={{ meta: data, reload }}>{children}</MetaCtx.Provider>;
}
export const useHrMeta = () => useContext(MetaCtx);
export const useCan = () => {
  const { meta } = useHrMeta();
  return (sub: string) => !!meta?.caps?.[sub];
};

// ── Formatting (Latin digits, as the rest of the ERP) ──────────────────────────────

const nf = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/**
 * "YYYY-MM-DD HH:mm" in the HR policy's zone (Asia/Riyadh unless configured), never in the
 * viewer's machine zone and never as a raw UTC slice — instants are stored in UTC.
 */
export function dateTimeIn(iso: string | Date | null | undefined, timeZone = "Asia/Riyadh"): string {
  if (!iso) return "—";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export const money = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : nf.format(Number(v)));
export const days = (v: string | number | null | undefined) => (v === null || v === undefined ? "—" : String(Number(v)));
export const monthAr = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  const names = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  return `${names[mm - 1]} ${y}`;
};
/** Today as a calendar day in Asia/Riyadh (a UTC slice is yesterday between 00:00 and 03:00). */
export const todayIso = () => dateTimeIn(new Date()).slice(0, 10);

// ── Labels & tones ─────────────────────────────────────────────────────────────────

export type Tone = "neutral" | "success" | "info" | "warning" | "danger" | "cancelled";
/** [Arabic label, tone, English label]. Read the label with `statusLabel` / `<StatusDot>`. */
export type StatusEntry = [string, Tone, string?];
export const EMPLOYEE_STATUS: Record<string, StatusEntry> = {
  PROBATION: ["فترة تجربة", "info", "Probation"], ACTIVE: ["على رأس العمل", "success", "Active"], NOTICE: ["فترة إشعار", "warning", "Notice period"], SUSPENDED: ["موقوف", "danger", "Suspended"], SEPARATED: ["انتهت خدمته", "cancelled", "Service ended"],
};
export const REQUEST_STATUS: Record<string, StatusEntry> = {
  PENDING: ["بانتظار القرار", "warning", "Awaiting your decision"], APPROVED: ["معتمد", "success", "Approved"], REJECTED: ["مرفوض", "danger", "Rejected"], WITHDRAWN: ["مسحوب", "cancelled", "Withdrawn"], CANCELLED: ["ملغى", "cancelled", "Cancelled"],
};
export const RUN_STATUS: Record<string, StatusEntry> = {
  DRAFT: ["مسودة", "neutral", "Draft"], REVIEW: ["بانتظار الاعتماد", "warning", "Awaiting approval"], APPROVED: ["معتمد · بانتظار الصرف", "info", "Approved · awaiting payment"], PAID: ["مصروف", "success", "Paid"], CANCELLED: ["ملغى", "cancelled", "Cancelled"],
};
export const ADVANCE_STATUS: Record<string, StatusEntry> = {
  REQUESTED: ["بانتظار الاعتماد", "warning", "Awaiting approval"], APPROVED: ["معتمدة · بانتظار الصرف", "info", "Approved · awaiting payment"], REJECTED: ["مرفوضة", "danger", "Rejected"], DISBURSED: ["مصروفة", "info", "Paid"], CLOSED: ["مغلقة", "success", "Closed"], CANCELLED: ["ملغاة", "cancelled", "Cancelled"],
};
export const INSTALLMENT_STATUS: Record<string, StatusEntry> = {
  SCHEDULED: ["مجدول", "neutral", "Scheduled"], RESERVED: ["محجوز في مسير", "warning", "Reserved in payroll"], SETTLED: ["مسدد", "success", "Repaid"], COVERED: ["مسدد نقدًا", "success", "Repaid in cash"],
};
export const STAGE: Record<string, StatusEntry> = {
  APPLIED: ["متقدم", "neutral", "Applied"], SCREENING: ["فرز", "neutral", "Screening"], INTERVIEW: ["مقابلة", "info", "Interview"], OFFER: ["عرض", "warning", "Offer"], HIRED: ["تم التوظيف", "success", "Hired"], REJECTED: ["مرفوض", "cancelled", "Rejected"], WITHDRAWN: ["انسحب", "cancelled", "Withdrawn"],
};
export const CONTRACT_STATUS: Record<string, StatusEntry> = { DRAFT: ["مسودة", "neutral", "Draft"], ACTIVE: ["ساري", "success", "Active"], SUPERSEDED: ["حلّ محله تعديل", "neutral", "Superseded by a change"], ENDED: ["منتهٍ", "cancelled", "Ended"] };

/** The label of a status entry in the given language (the code itself when unknown). */
export const statusLabel = (map: Record<string, StatusEntry>, value: string, lang: Lang) => {
  const e = map[value];
  if (!e) return value;
  return lang === "en" ? (e[2] ?? e[0]) : e[0];
};

// ── Components ─────────────────────────────────────────────────────────────────────

/** The HR content scope. Wraps every HR and self-service page inside the shared shell. */
export function HrRoot({ children, className = "" }: { children: ReactNode; className?: string }) {
  // The canvas, sheet, navigation, tokens and IBM Plex come from the shared Direction 2.1
  // shell (components/shell/AppShell); this only scopes the HR content styles.
  return <div data-hr-root="" className={className}>{children}</div>;
}

/** `stackMobile`: on the phone the actions sit under the meta line (M-02 R3); unchanged above 767. */
export function PageHeader({ title, actions, children, stackMobile }: { title: ReactNode; actions?: ReactNode; children?: ReactNode; stackMobile?: boolean }) {
  // The section's pages («مسيرات الرواتب | السلف», «الإجازات | الحضور») are the approved Segmented
  // control, drawn where the reference puts one — in the page header's action area, not the
  // shell's top bar (owner decision S-2 / A-1). The shell resolves them; this only places them.
  const inner = (
    <>
      <div className="hr-pagehead">
        <h1 className="hr-title">{title}</h1>
        <div className="hr-actions"><SectionPages />{actions}</div>
      </div>
      {children ? <div className="hr-meta">{children}</div> : null}
    </>
  );
  return stackMobile ? <div className="hr-headstack">{inner}</div> : inner;
}

export function Tabs<K extends string>({ items, value, onChange, label, underline }: { items: { key: K; label: string; count?: number | string; danger?: boolean }[]; value: K; onChange: (k: K) => void; label: string; underline?: boolean }) {
  return (
    <div className={`hr-tabs${underline ? " is-underline" : ""}`} role="tablist" aria-label={label}>
      {items.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className={`hr-tab${t.danger ? " is-danger" : ""}`} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined ? <span className="hr-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Btn({ children, variant = "secondary", size, busy, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm"; busy?: boolean }) {
  return (
    <button type="button" {...rest} disabled={rest.disabled || busy} aria-busy={busy || undefined} className={`hr-btn${variant !== "secondary" ? ` is-${variant}` : ""}${size ? " is-sm" : ""} ${rest.className ?? ""}`}>
      {busy ? "…" : null}
      {children}
    </button>
  );
}

export function Dot({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`hr-dot tone-${tone}`}><span>{children}</span></span>;
}
export function StatusDot({ map, value }: { map: Record<string, StatusEntry>; value: string }) {
  const { lang } = useHrI18n();
  const tone = map[value]?.[1] ?? "neutral";
  return <Dot tone={tone}>{statusLabel(map, value, lang)}</Dot>;
}
export function Flag({ tone = "warning", children }: { tone?: "warning" | "danger" | "info"; children: ReactNode }) {
  // One inner run: inside the inline-flex chip, loose text and a number span would become
  // separate flex items and lose the spaces between them («بعد23يومًا»).
  return <span className={`hr-flag tone-${tone}`}><span>{children}</span></span>;
}
/** `plainOnMobile`: on a phone an informational notice reads as a caption (no box), to save space. */
export function Notice({ tone = "info", plainOnMobile, children }: { tone?: "info" | "warning" | "danger" | "success"; plainOnMobile?: boolean; children: ReactNode }) {
  return <div className={`hr-notice tone-${tone}${plainOnMobile ? " is-plain-mobile" : ""}`} role={tone === "danger" ? "alert" : undefined}>{children}</div>;
}

export function KV({ rows }: { rows: [ReactNode, ReactNode, string?][] }) {
  return (
    <dl className="hr-kv">
      {rows.map(([k, v, color], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd style={color ? { color: `var(--hr-${color})` } : undefined}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A metric strip. The optional third element is a class for that cell (e.g. `hr-only-compact`). */
export function Metrics({ items }: { items: ([string, ReactNode] | [string, ReactNode, string])[] }) {
  return (
    <div className="hr-metrics">
      {items.map(([k, v, cls]) => (
        <div key={k} className={cls}>
          <span className="hr-caption">{k}</span>
          <span className="hr-metric">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function Field({ label, help, error, children, wide }: { label: string; help?: ReactNode; error?: string | null; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`hr-field${wide ? " is-wide" : ""}`}>
      <span className="hr-label">{label}</span>
      {children}
      {error ? <span className="hr-err">{error}</span> : help ? <span className="hr-help">{help}</span> : null}
    </label>
  );
}

export function LoadingTable({ rows = 6, label: given }: { rows?: number; label?: string }) {
  const { t } = useHrI18n();
  const label = given ?? t("loading");
  return (
    <div aria-busy="true" aria-label={label} className="hr-stack" style={{ paddingBlock: 8 }}>
      <span className="hr-caption">{label}</span>
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="hr-skel" style={{ width: `${70 + ((i * 7) % 30)}%` }} />)}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: HrApiError | Error | string; onRetry?: () => void }) {
  const { t } = useHrI18n();
  const msg = typeof error === "string" ? error : error.message;
  const status = typeof error === "object" && "status" in error ? (error as HrApiError).status : 0;
  if (status === 403) return <NoPermission />;
  return (
    <div className="hr-notice tone-danger" role="alert" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <div>
        <strong>{t("loadFailed")}</strong> <span>{msg}</span>
        <div className="hr-caption">{t("nothingChanged")}</div>
      </div>
      {onRetry ? <Btn size="sm" onClick={onRetry}>{t("retry")}</Btn> : null}
    </div>
  );
}

export function NoPermission({ duty }: { duty?: string }) {
  const { t, L } = useHrI18n();
  return (
    <div className="hr-state" role="status">
      <h3>{t("noPermissionTitle")}</h3>
      <p className="hr-caption" style={{ margin: 0 }}>{duty ? L(`تحتاج صلاحية «الموارد البشرية · ${duty}». `, `You need the “HR · ${duty}” permission. `) : ""}{t("noPermissionBody")}</p>
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="hr-state">
      <h3>{title}</h3>
      {body ? <p className="hr-caption" style={{ margin: 0, maxWidth: 460 }}>{body}</p> : null}
      {action}
    </div>
  );
}

export function Dialog({ open, title, onClose, children, actions, className, closeLabel, sub, testId }: { open: boolean; title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; className?: string; closeLabel?: string; sub?: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest onClose without making it an effect dependency: an inline arrow from the
  // caller would otherwise re-run the effect on every render and steal focus while typing.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const backdrop = useRef<HTMLDivElement>(null);
  // The control focus returns to on close. Restored by the inert effect's cleanup, AFTER the
  // inert attributes are removed (N-1): focusing an element that is still inert does nothing.
  const opener = useRef<HTMLElement | null>(null);
  const { t } = useHrI18n();
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  // Modal for real (D-2): while open, everything outside the dialog is inert — including an
  // operations pane it was opened from — and Tab / Shift+Tab cycle inside it. Only the
  // attributes added here are removed on close.
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const host = backdrop.current;
    if (!el || !host) return;
    const made: Element[] = [];
    for (let node: Element | null = host; node && node !== document.body; node = node.parentElement) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      for (const sib of Array.from(parent.children)) {
        if (sib === node || sib.hasAttribute("inert") || sib.tagName === "SCRIPT") continue;
        sib.setAttribute("inert", ""); made.push(sib);
      }
    }
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]):not(.hq-native), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")).filter((x) => x.offsetParent !== null);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !el.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !el.contains(active))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onTab);
    return () => {
      document.removeEventListener("keydown", onTab);
      for (const m of made) m.removeAttribute("inert");
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus();
    };
  }, [open]);
  // On a phone the sheet sits on the visible part of the screen: when the on-screen keyboard
  // opens, the visual viewport shrinks and the sheet is lifted above it and capped to what is
  // left, its body scrolls, and the focused field is kept in view. Android Chrome also resizes
  // the layout (viewport `interactive-widget`); iOS needs this.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!open || !vv) return;
    const sheetMode = window.matchMedia("(max-height: 500px) and (pointer: coarse)");
    const isField = (f: Element | null): f is HTMLElement => !!f && /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName) && !!ref.current?.contains(f);
    // Scroll the sheet so the focused field sits fully above the action bar and inside the visible
    // area (D-P1-5). Measured, not left to scroll-margin: in phone landscape the actions are sticky
    // inside the scrolling sheet, and the keyboard may open before or after the tap.
    const keepClear = () => {
      const f = document.activeElement;
      const dlg = ref.current;
      if (!isField(f) || !dlg) return;
      const body = dlg.querySelector<HTMLElement>(".hr-dialog-body");
      const scroller = [body, dlg].find((s) => !!s && s.scrollHeight > s.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(s).overflowY));
      if (!scroller) return;
      const acts = dlg.querySelector<HTMLElement>(".hr-dialog-actions");
      const sr = scroller.getBoundingClientRect();
      const visibleBottom = vv.offsetTop + vv.height;
      const lo = Math.min(sr.bottom, acts ? acts.getBoundingClientRect().top : sr.bottom, visibleBottom);
      const hi = Math.max(sr.top, vv.offsetTop);
      // A note never grows taller than the room above the actions: past that it scrolls inside
      // itself, and the line being typed stays in view.
      if (f instanceof HTMLTextAreaElement && sheetMode.matches) {
        f.style.maxHeight = `${Math.max(44, Math.min(120, Math.floor(lo - hi - 4)))}px`;
        if (f.selectionEnd === f.value.length) f.scrollTop = f.scrollHeight;
      }
      const fr = f.getBoundingClientRect();
      // An 8 px margin where there is room; a field that only just fits gets what is left.
      const pad = Math.max(0, Math.min(8, (lo - hi - fr.height) / 2));
      const bottom = lo - pad;
      const top = hi + pad;
      if (fr.bottom > bottom) scroller.scrollTop += fr.bottom - bottom;
      else if (fr.top < top) scroller.scrollTop -= top - fr.top;
    };
    let later: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      keepClear();
      requestAnimationFrame(keepClear);
      clearTimeout(later);
      later = setTimeout(keepClear, 300);
    };
    const update = () => {
      const el = backdrop.current;
      if (!el) return;
      const keyboard = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      el.style.setProperty("--hr-kb", `${keyboard}px`);
      el.style.setProperty("--hr-vvh", `${Math.round(vv.height)}px`);
      // Keep the field being typed in visible above the actions, whether the keyboard shrank the
      // visual viewport (iOS) or the layout itself (Android, resizes-content).
      settle();
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    // Content that arrives later (e.g. the leave quote above the reason field) must not push
    // the field being typed in under the actions.
    const body = ref.current?.querySelector(".hr-dialog-body");
    const mo = body ? new MutationObserver(() => keepClear()) : null;
    if (body && mo) mo.observe(body, { childList: true, subtree: true, characterData: true });
    // A field focused by a tap is kept clear now and again once the keyboard has opened (it
    // animates in after focus).
    const onFocus = () => settle();
    const onInput = (e: Event) => { if (e.target instanceof HTMLTextAreaElement) requestAnimationFrame(keepClear); };
    const onBlur = (e: FocusEvent) => { if (e.target instanceof HTMLTextAreaElement) e.target.style.maxHeight = ""; };
    const dialogEl = ref.current;
    dialogEl?.addEventListener("focusin", onFocus);
    dialogEl?.addEventListener("input", onInput);
    dialogEl?.addEventListener("focusout", onBlur);
    return () => {
      clearTimeout(later);
      dialogEl?.removeEventListener("focusin", onFocus);
      dialogEl?.removeEventListener("input", onInput);
      dialogEl?.removeEventListener("focusout", onBlur);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      mo?.disconnect();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div ref={backdrop} className="hr-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`hr-dialog${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={title} data-hr-root="" data-testid={testId}>
        <div className="hr-dialog-head">
          <div>
            <h2 className="hr-section">{title}</h2>
            {sub ? <p className="hr-caption" style={{ margin: 0 }}>{sub}</p> : null}
          </div>
          <Btn variant="ghost" size="sm" aria-label={closeLabel ?? t("close")} onClick={onClose}>✕</Btn>
        </div>
        <div className="hr-dialog-body">{children}</div>
        {actions ? <div className="hr-dialog-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/**
 * FilterChip (library 12:16, Type=Filter): «الفرع: الكل». The value is chosen with the kit's
 * Select laid transparently over the chip (popover on desktop, bottom sheet on phones); when a
 * value is set, a separate «×» button clears it. There is deliberately no «تصفية» (Type=Add)
 * chip: no further filters exist to add.
 */
export function FilterChip({ label, value, onChange, options, allLabel: givenAll, clearLabel }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; allLabel?: string; clearLabel?: string }) {
  const { t, L } = useHrI18n();
  const allLabel = givenAll ?? t("all");
  const active = value !== "";
  const current = options.find((o) => o.value === value)?.label ?? allLabel;
  return (
    <span className={`hr-fchip${active ? " is-active" : ""}`}>
      <span className="hr-fchip-main">
        {active ? null : <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z" /></svg>}
        <span className="hr-fchip-label">{label}:</span>
        <span className="hr-fchip-value" aria-hidden="true">{current}</span>
        <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{allLabel}</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </span>
      {active ? <button type="button" className="hr-fchip-clear" aria-label={clearLabel ?? L(`مسح فلتر ${label}`, `Clear ${label} filter`)} onClick={() => onChange("")}>×</button> : null}
    </span>
  );
}

/** A small controlled form for dialogs: fields keyed by name, string values. */
export function useForm<T extends Record<string, string>>(initial: T) {
  const [v, setV] = useState<T>(initial);
  const bind = (k: keyof T) => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value })) });
  return { v, setV, bind, reset: () => setV(initial) };
}

export function ProposalTag() {
  const { t } = useHrI18n();
  return <Flag tone="warning">{t("proposalTag")}</Flag>;
}
