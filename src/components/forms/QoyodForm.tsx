"use client";

// Qoyod-style create forms (batch 22 WP-J; QOYOD-REF §8.0) — presentation only: the labelled single-column header with a
// party side card, «إضافة المزيد» with its Shift+A shortcut, totals and «ملخص الضريبة», the collapsibles and the split
// primary button. Nothing here decides what a viewer may do (the APIs and the route guard do). Prefix `qf-`.
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./qoyod-form.css";

/** One header row: the visible label at the inline start, the control after it (stacked on a phone). */
export function FormField({ label, required, htmlFor, help, error, children, testId }: { label: string; required?: boolean; htmlFor?: string; help?: ReactNode; error?: string | null; children: ReactNode; testId?: string }) {
  return (
    <div className="qf-field" data-testid={testId}>
      <label className="qf-label" htmlFor={htmlFor}>{label}{required ? <span className="qf-req" aria-hidden="true">*</span> : null}{required ? <span className="qc-sr"> (required)</span> : null}</label>
      <div className="qf-control">{children}</div>
      {error ? <span className="qf-error" role="alert">{error}</span> : help ? <span className="qf-help">{help}</span> : null}
    </div>
  );
}

/** The header block: the fields (≈60 %) and, beside them, the party side card (when given). */
export function FormHead({ children, side }: { children: ReactNode; side?: ReactNode }) {
  return <div className={`qf-head${side ? "" : " is-single"}`}><div className="qf-fields">{children}</div>{side ?? null}</div>;
}

export type SideRow = { k: string; v: ReactNode; tone?: "good" | "bad"; testId?: string };
/** «تفاصيل بيانات المورد / العميل / الجهة»: filled when the party is picked. */
export function PartyCard({ title, rows, empty, action, testId = "qf-party" }: { title: string; rows: SideRow[] | null; empty: string; action?: ReactNode; testId?: string }) {
  return (
    <aside className="qf-side" data-testid={testId} aria-label={title}>
      <h3><span>{title}</span>{action ?? null}</h3>
      {rows && rows.length ? (
        <dl>{rows.map((r) => <div key={r.k} style={{ display: "contents" }}><dt>{r.k}</dt><dd className={r.tone ? `is-${r.tone}` : undefined} data-testid={r.testId}>{r.v}</dd></div>)}</dl>
      ) : <p className="qf-side-empty">{empty}</p>}
    </aside>
  );
}

/** Shift+A anywhere on the form adds a line — except while typing text (a text field keeps its capital A). */
export function useShiftA(add: () => void, enabled = true) {
  const ref = useRef(add);
  useEffect(() => { ref.current = add; }, [add]);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || (e.key !== "A" && e.key !== "a")) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "TEXTAREA" || t.isContentEditable || (t.tagName === "INPUT" && !(t as HTMLInputElement).inputMode?.includes("decimal") && !["checkbox", "radio", "date", "file", "button"].includes((t as HTMLInputElement).type)));
      if (typing) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** «⇧A إضافة المزيد +». */
export function AddMore({ onClick, label, testId, disabled }: { onClick: () => void; label: string; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" className="hr-btn is-primary qf-add" onClick={onClick} disabled={disabled} data-testid={testId} aria-keyshortcuts="Shift+A">
      <span className="qf-kbd" aria-hidden="true">⇧A</span><span>{label}</span><span aria-hidden="true">+</span>
    </button>
  );
}

/** الإجمالي قبل الضريبة · ضريبة القيمة المضافة · ─ · الإجمالي (or any rows; the last `grand` one is bold). */
export function Totals({ rows, testId = "qf-totals" }: { rows: { k: string; v: string; grand?: boolean; testId?: string }[]; testId?: string }) {
  return <div className="qf-totals" data-testid={testId}>{rows.map((r) => <div key={r.k} className={r.grand ? "is-grand" : undefined}><span>{r.k}</span><span data-testid={r.testId}>{r.v}</span></div>)}</div>;
}

/** «ملخص الضريبة»: one row per VAT category (S / Z / E / O …): the taxable base and the VAT. */
export function TaxSummary({ title, head, rows, testId = "qf-tax" }: { title: string; head: [string, string, string]; rows: { key: string; label: string; base: string; vat: string }[]; testId?: string }) {
  if (!rows.length) return null;
  return (
    <div className="qf-tax" data-testid={testId}>
      <h4>{title}</h4>
      <table><thead><tr><th>{head[0]}</th><th className="num">{head[1]}</th><th className="num">{head[2]}</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key}><td>{r.label}</td><td className="num">{r.base}</td><td className="num">{r.vat}</td></tr>)}</tbody></table>
    </div>
  );
}

/** A closed-by-default section after the totals («المرفقات», «معلومات إضافية» …). */
export function Collapse({ title, count, children, defaultOpen, testId }: { title: string; count?: ReactNode; children: ReactNode; defaultOpen?: boolean; testId?: string }) {
  return (
    <details className="qf-collapse" open={defaultOpen} data-testid={testId}>
      <summary>{title}{count !== undefined && count !== null ? <span className="qf-count">{count}</span> : null}</summary>
      <div className="qf-collapse-body">{children}</div>
    </details>
  );
}

export type SplitItem = { label: string; onClick: () => void; testId?: string; disabled?: boolean };
/** «حفظ وموافقة ▾»: the primary and a menu of the same act chained with one more step (Q-F2). */
export function SplitButton({ label, onClick, busy, disabled, items, testId, menuLabel }: { label: string; onClick: () => void; busy?: boolean; disabled?: boolean; items: SplitItem[]; testId?: string; menuLabel: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="qf-split" ref={box}>
      <button type="button" className="hr-btn is-primary" onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined} data-testid={testId}>{busy ? "…" : null}{label}</button>
      {items.length ? <button type="button" className="hr-btn is-primary qf-split-toggle" aria-haspopup="menu" aria-expanded={open} aria-label={menuLabel} disabled={disabled || busy} onClick={() => setOpen((x) => !x)} data-testid={testId ? `${testId}-more` : undefined}>▾</button> : null}
      {open ? (
        <div className="qf-split-menu" role="menu">
          {items.map((i) => <button key={i.label} type="button" role="menuitem" disabled={i.disabled} onClick={() => { setOpen(false); i.onClick(); }} data-testid={i.testId}>{i.label}</button>)}
        </div>
      ) : null}
    </div>
  );
}

/** Two-way segmented choice («المدين ثم الدائن / الترتيب الأصلي»). */
export function Seg<T extends string>({ value, options, onChange, label, testId }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; testId?: string }) {
  return (
    <div className="qf-seg" role="group" aria-label={label} data-testid={testId}>
      {options.map((o) => <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} data-testid={testId ? `${testId}-${o.value}` : undefined}>{o.label}</button>)}
    </div>
  );
}
