"use client";
// Station primitives — production simplification Phase A (prototype production-simple.html):
// the info line the system decided, the large number input, the stepper, chips and the
// full-width call to action. Direction 2.1 tokens (station.css), Arabic RTL first, ≥ 44 px.
import type { ReactNode } from "react";
import "./station.css";

export function AutoRow({ title, sub, warn, action, testId }: { title: ReactNode; sub?: ReactNode; warn?: boolean; action?: ReactNode; testId?: string }) {
  return (
    <div className={`st-auto${warn ? " is-warn" : ""}`} data-testid={testId}>
      <span className="st-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {warn ? <><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></> : <path d="M20 6 9 17l-5-5" />}
        </svg>
      </span>
      <div><b>{title}</b>{sub ? <small>{sub}</small> : null}</div>
      {action ? <span className="st-link">{action}</span> : null}
    </div>
  );
}

export function NumIn({ id, label, value, onChange, unit, placeholder, autoFocus, text, small, testId, inputMode = "decimal" }: {
  id: string; label: ReactNode; value: string; onChange: (v: string) => void; unit?: string; placeholder?: string;
  autoFocus?: boolean; text?: boolean; small?: boolean; testId?: string; inputMode?: "decimal" | "numeric" | "tel" | "text";
}) {
  return (
    <div className="st-field">
      <label htmlFor={id}>{label}</label>
      <div className={`st-numin${text ? " is-text" : ""}${small ? " is-sm" : ""}`}>
        <input id={id} inputMode={inputMode} value={value} placeholder={placeholder} autoFocus={autoFocus} data-autofocus={autoFocus ? "" : undefined}
          autoComplete="off" onChange={(e) => onChange(e.target.value)} data-testid={testId} />
        {unit ? <span>{unit}</span> : null}
      </div>
    </div>
  );
}

/** Arabic-Indic digits and the Arabic decimal separator → a number (NaN when empty / invalid). */
export function parseNum(v: string): number {
  const t = v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٫,]/g, ".").trim();
  return t === "" || !/^\d*\.?\d+$|^\d+\.$/.test(t) ? NaN : Number(t);
}

export function Stepper({ value, onChange, min = 0, max, label, testId }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label: string; testId?: string }) {
  return (
    <span className="st-stepper" data-testid={testId}>
      <button type="button" aria-label={`+ ${label}`} disabled={max !== undefined && value >= max} onClick={() => onChange(Math.min(max ?? Infinity, value + 1))}>+</button>
      <output aria-live="polite" aria-label={label}>{value}</output>
      <button type="button" aria-label={`− ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
    </span>
  );
}

export function Chips<T extends string>({ options, value, onChange, label, testId }: { options: { value: T; label: string }[]; value: T | null; onChange: (v: T) => void; label?: string; testId?: string }) {
  return (
    <div className="st-chips" role="group" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button key={o.value} type="button" className="st-chip" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Cta({ children, onClick, disabled, bad, busy, testId }: { children: ReactNode; onClick: () => void; disabled?: boolean; bad?: boolean; busy?: boolean; testId?: string }) {
  return (
    <button type="button" className={`st-cta${bad ? " is-bad" : ""}`} onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined} data-testid={testId}>
      {busy ? "…" : children}
    </button>
  );
}
