"use client";
/**
 * Shared page chrome (Qoyod-parity program) — the four pieces every accountant-workspace page reuses, drawn in the
 * Direction 2.1 tokens (they render inside the shell's `.d21` scope; nothing here hard-codes a colour):
 *
 *   <PageCrumb items={[…]} />            «القسم / الصفحة» (lists), «القسم / القائمة / REF» (records); `home` → «الصفحة الرئيسية / …» (dashboard only)
 *   <FilterCard onApply onReset>…</FilterCard>   the filter card: fields, «بحث» + «إعادة تعيين» (lists) · variant="dashboard": «تصفية»
 *     <MultiPick …/>  <DateRange …/>     its two standard fields (branch / location multi-select, date range)
 *     useFilters(initial)                draft vs applied filter state (the card edits the draft; «تصفية» applies it)
 *   <SectionBar title …/> · <Section title …>…</Section>   the dark section title bar (and a section under it)
 *   lists:      <ListPageSize {...pager}/> above the table («في الصفحة [15]») · <ListFooter {...pager}/> below («يتم عرض 15 من 42»)
 *   dashboard:  <TablePager {...pager}/> («السابق · صفحة 1 من 3 · [10] · التالي») · usePaging(rows, 15 | 10)
 *
 * The API is documented in the program's CHROME.md. Presentation only: none of these decide what a viewer may see.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { Ico } from "@/components/shell/icons";
import { useWorkspaceMode } from "@/components/shell/workspace-mode";
import "./chrome.css";

const useL = () => {
  const { lang } = useI18n();
  return useCallback((ar: string, en: string) => (lang === "en" ? en : ar), [lang]);
};

// ── Breadcrumb ────────────────────────────────────────────────────────────────────────────────────────────────

export type CrumbItem = { label: string; href?: string | null };

/**
 * The page trail, as Qoyod draws it: «القسم / الصفحة» on a list («المبيعات / فواتير المبيعات»), «القسم / القائمة / REF»
 * on a record. Only the dashboard starts with «الصفحة الرئيسية» (`home`). The last item is the current page (no link).
 * In the accountant workspace the shell's top bar already draws this trail from the sidebar tree; use this component
 * for an in-page trail only (e.g. a record page that adds its reference), never on the same line as the top bar's.
 */
export function PageCrumb({ items, home = false, homeHref, homeLabel, testId = "page-crumb" }: { items: CrumbItem[]; home?: boolean; homeHref?: string; homeLabel?: string; testId?: string }) {
  const L = useL();
  const ws = useWorkspaceMode();
  const all: CrumbItem[] = home ? [{ label: homeLabel ?? L("الصفحة الرئيسية", "Home"), href: homeHref ?? ws.home }, ...items] : items;
  return (
    <nav className="qc-crumb" aria-label={L("مسار الصفحة", "Page path")} data-testid={testId}>
      <ol>
        {all.map((c, i) => {
          const last = i === all.length - 1;
          return (
            <li key={`${i}-${c.label}`}>
              {!last && c.href ? <Link href={c.href}>{c.label}</Link> : <span aria-current={last ? "page" : undefined}>{c.label}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
/** @deprecated the first name of `PageCrumb` (it no longer adds «الصفحة الرئيسية» unless `home`). */
export const HomeCrumb = PageCrumb;

// ── Filter card ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Draft / applied filter state. The card's fields edit `draft`; «تصفية» copies it to `applied` (what the page
 * fetches with); «إعادة تعيين» puts both back to `initial`. `dirty` is true while the draft differs from what is applied.
 */
export function useFilters<T extends Record<string, unknown>>(initial: T) {
  const first = useRef(initial);
  const [draft, setDraft] = useState<T>(initial);
  const [applied, setApplied] = useState<T>(initial);
  const set = useCallback(<K extends keyof T>(k: K, v: T[K]) => setDraft((d) => ({ ...d, [k]: v })), []);
  const apply = useCallback(() => setApplied(draft), [draft]);
  const reset = useCallback(() => { setDraft(first.current); setApplied(first.current); }, []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  return { draft, applied, set, setDraft, apply, reset, dirty };
}

/**
 * The filter card: its fields (children), then the two buttons. Enter in a field applies too.
 *   variant "list" (default, every list page): «بحث» (primary) + «إعادة تعيين» (dark).
 *   variant "dashboard" («لوحة المتابعة» only): «تصفية» (primary) + «إعادة تعيين» (red outline).
 */
export function FilterCard({ children, onApply, onReset, busy, applyLabel, resetLabel, variant = "list", testId = "filter-card" }: {
  children: ReactNode; onApply: () => void; onReset: () => void; busy?: boolean; applyLabel?: string; resetLabel?: string; variant?: "list" | "dashboard"; testId?: string;
}) {
  const L = useL();
  const dash = variant === "dashboard";
  return (
    <form className="qc-filter" role="search" aria-label={L("التصفية", "Filters")} data-testid={testId}
      onSubmit={(e) => { e.preventDefault(); onApply(); }}>
      <div className="qc-filter-fields">{children}</div>
      <div className="qc-filter-actions">
        <button type="submit" className="d21-btn p" disabled={busy} aria-busy={busy || undefined} data-testid={`${testId}-apply`}>
          <Ico name={dash ? "filter" : "search"} small />{applyLabel ?? (dash ? L("تصفية", "Filter") : L("بحث", "Search"))}
        </button>
        <button type="button" className={`d21-btn qc-reset${dash ? " is-outline" : ""}`} onClick={onReset} disabled={busy} data-testid={`${testId}-reset`}>
          {resetLabel ?? L("إعادة تعيين", "Reset")}
        </button>
      </div>
    </form>
  );
}

export type PickOption = { value: string; label: string };

/**
 * A multi-select drawn as chips (Qoyod's branch / location picker): the chosen options as removable chips and a
 * button opening a checkbox list. An empty selection means «الكل».
 */
export function MultiPick({ label, options, value, onChange, allLabel, testId = "multipick" }: {
  label: string; options: PickOption[]; value: string[]; onChange: (v: string[]) => void; allLabel?: string; testId?: string;
}) {
  const L = useL();
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  const [q, setQ] = useState("");
  const chosen = options.filter((o) => value.includes(o.value));
  const shown = q.trim() ? options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase())) : options;
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="qc-field qc-pick" ref={box} data-testid={testId}>
      <span className="qc-label" id={`${id}-l`}>{label}</span>
      <div className="qc-pick-box">
        <div className="qc-chips">
          {chosen.length === 0 ? <span className="qc-chip is-all">{allLabel ?? L("الكل", "All")}</span> : chosen.map((o) => (
            <span key={o.value} className="qc-chip">
              {o.label}
              <button type="button" onClick={() => toggle(o.value)} aria-label={L(`إزالة ${o.label}`, `Remove ${o.label}`)}><Ico name="close" small /></button>
            </span>
          ))}
        </div>
        <button type="button" className="qc-pick-btn" aria-haspopup="listbox" aria-expanded={open} aria-labelledby={`${id}-l`}
          onClick={() => setOpen((v) => !v)} data-testid={`${testId}-open`}>
          <Ico name="chevd" small />
        </button>
      </div>
      {open ? (
        <div className="qc-pick-pop" role="listbox" aria-multiselectable="true" aria-labelledby={`${id}-l`}>
          {options.length > 7 ? <input type="search" className="qc-pick-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("بحث…", "Search…")} aria-label={L(`بحث في ${label}`, `Search ${label}`)} autoFocus /> : null}
          {shown.length === 0 ? <p className="qc-muted">{L("لا توجد خيارات.", "No options.")}</p> : shown.map((o) => (
            <label key={o.value} className="qc-pick-opt" role="option" aria-selected={value.includes(o.value)}>
              <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** «من — إلى»: two date fields (YYYY-MM-DD). The page decides what an empty side means. */
export function DateRange({ label, from, to, onChange, testId = "daterange" }: {
  label?: string; from: string; to: string; onChange: (r: { from: string; to: string }) => void; testId?: string;
}) {
  const L = useL();
  const id = useId();
  return (
    <fieldset className="qc-field qc-range" data-testid={testId}>
      <legend className="qc-label">{label ?? L("الفترة", "Period")}</legend>
      <div className="qc-range-in">
        <label htmlFor={`${id}-f`} className="qc-sr">{L("من", "From")}</label>
        <input id={`${id}-f`} type="date" value={from} max={to || undefined} onChange={(e) => onChange({ from: e.target.value, to })} data-testid={`${testId}-from`} />
        <span aria-hidden className="qc-range-sep">—</span>
        <label htmlFor={`${id}-t`} className="qc-sr">{L("إلى", "To")}</label>
        <input id={`${id}-t`} type="date" value={to} min={from || undefined} onChange={(e) => onChange({ from, to: e.target.value })} data-testid={`${testId}-to`} />
      </div>
    </fieldset>
  );
}

// ── Section title bar ─────────────────────────────────────────────────────────────────────────────────────────

/** The dark section title bar (Qoyod's navy bar, in the Direction 2.1 deep ink with the olive accent line). */
export function SectionBar({ title, actions, level = 2, tone = "dark", id }: { title: ReactNode; actions?: ReactNode; level?: 2 | 3; tone?: "dark" | "mid"; id?: string }) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <div className={`qc-bar${tone === "mid" ? " is-mid" : ""}`}>
      <H id={id}>{title}</H>
      {actions ? <div className="qc-bar-actions">{actions}</div> : null}
    </div>
  );
}

/** A section: the title bar and its body, labelled by the bar. */
export function Section({ title, actions, children, testId, tone, className = "" }: { title: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string; tone?: "dark" | "mid"; className?: string }) {
  const id = useId();
  return (
    <section className={`qc-section ${className}`.trim()} aria-labelledby={id} data-testid={testId}>
      <SectionBar title={title} actions={actions} id={id} tone={tone} />
      <div className="qc-section-body">{children}</div>
    </section>
  );
}

// ── Table paging ──────────────────────────────────────────────────────────────────────────────────────────────

export const PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * «السابق · صفحة 1 من 3 (42 إجمالي) · [10] · التالي». Controlled: `page` is 1-based. Works for client-side rows
 * (see `usePaging`) and for a server's `total`.
 */
export function TablePager({ page, pageSize, total, onPage, onPageSize, sizes = PAGE_SIZES, noun, testId = "pager" }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize: (n: number) => void;
  sizes?: readonly number[]; noun?: string; testId?: string;
}) {
  const L = useL();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(1, page), pages);
  const id = useId();
  return (
    <div className="qc-pager" role="navigation" aria-label={L("التنقل بين الصفحات", "Pagination")} data-testid={testId}>
      <button type="button" className="d21-btn sm" onClick={() => onPage(cur - 1)} disabled={cur <= 1} data-testid={`${testId}-prev`}>{L("السابق", "Previous")}</button>
      <div className="qc-pager-mid" aria-live="polite">
        <b>{L(`صفحة ${cur} من ${pages}`, `Page ${cur} of ${pages}`)}</b>
        <small>{L(`(${total} إجمالي ${noun ?? "السجلات"})`, `(${total} ${noun ?? "records"} in total)`)}</small>
      </div>
      <label htmlFor={id} className="qc-sr">{L("عدد الصفوف في الصفحة", "Rows per page")}</label>
      <select id={id} className="qc-pager-size" value={pageSize} onChange={(e) => { onPageSize(Number(e.target.value)); onPage(1); }} data-testid={`${testId}-size`}>
        {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <button type="button" className="d21-btn sm" onClick={() => onPage(cur + 1)} disabled={cur >= pages} data-testid={`${testId}-next`}>{L("التالي", "Next")}</button>
    </div>
  );
}

export const LIST_PAGE_SIZES = [15, 30, 50, 100] as const;
type PagerProps = { page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize: (n: number) => void };

/** «في الصفحة [15]» — the list page-size control, above the table (Qoyod). */
export function ListPageSize({ pageSize, onPageSize, onPage, sizes = LIST_PAGE_SIZES, testId = "list-size" }: Pick<PagerProps, "pageSize" | "onPageSize" | "onPage"> & { sizes?: readonly number[]; testId?: string }) {
  const L = useL();
  const id = useId();
  return (
    <div className="qc-size" data-testid={testId}>
      <label htmlFor={id}>{L("في الصفحة", "Per page")}</label>
      <select id={id} className="qc-pager-size" value={pageSize} onChange={(e) => { onPageSize(Number(e.target.value)); onPage(1); }}>
        {sizes.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
  );
}

/**
 * The list footer, below the table: «يتم عرض 15 من 42 …» (or «لا توجد أي …» when empty), with «السابق / التالي»
 * only when there is more than one page.
 */
export function ListFooter({ page, pageSize, total, onPage, noun, emptyText, testId = "list-footer" }: PagerProps & { noun?: string; emptyText?: string; testId?: string }) {
  const L = useL();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(1, page), pages);
  const shown = Math.max(0, Math.min(pageSize, total - (cur - 1) * pageSize));
  return (
    <div className="qc-foot" data-testid={testId}>
      <span className="qc-foot-line" aria-live="polite">
        {total === 0 ? (emptyText ?? L(`لا توجد أي ${noun ?? "سجلات"}`, `No ${noun ?? "records"}`))
          : pages === 1 ? L(`يتم عرض ${total} ${noun ?? "سجل"}`, `Showing ${total} ${noun ?? "records"}`)
          : L(`يتم عرض ${shown} من ${total} ${noun ?? "سجل"} · صفحة ${cur} من ${pages}`, `Showing ${shown} of ${total} ${noun ?? "records"} · page ${cur} of ${pages}`)}
      </span>
      {pages > 1 ? (
        <span className="qc-foot-nav">
          <button type="button" className="d21-btn sm" onClick={() => onPage(cur - 1)} disabled={cur <= 1} data-testid={`${testId}-prev`}>{L("السابق", "Previous")}</button>
          <button type="button" className="d21-btn sm" onClick={() => onPage(cur + 1)} disabled={cur >= pages} data-testid={`${testId}-next`}>{L("التالي", "Next")}</button>
        </span>
      ) : null}
    </div>
  );
}

/**
 * Client-side paging of `rows`: the current page's rows and the pager props (for `<ListPageSize>` + `<ListFooter>` on a
 * list, `<TablePager>` on a dashboard widget). Lists default to 15 rows (Qoyod); the dashboard widgets pass 10.
 */
export function usePaging<T>(rows: readonly T[], initialSize = 15) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(page, pages);
  const pageRows = useMemo(() => rows.slice((cur - 1) * pageSize, cur * pageSize), [rows, cur, pageSize]);
  return { pageRows, pager: { page: cur, pageSize, total, onPage: setPage, onPageSize: setPageSize } };
}
