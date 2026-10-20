"use client";

// A row of stage cards that is a tab list (owner, 20 Oct 2026): each card is a tab, the selected
// card owns the panel under the row. WAI-ARIA tabs pattern with automatic activation — one tab
// stop (roving tabindex), ← / → move and select (mirrored in RTL), Home / End jump to the ends.
// The selected card scrolls into view when the row scrolls sideways (the phone).
// Styling is the caller's: it receives `aria-selected` on each card.
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export type StageTab<K extends string> = { key: K; n: number; label: ReactNode; sub?: ReactNode; warn?: boolean; warnLabel?: string };

export function StageTabs<K extends string>({ items, value, onChange, label, idBase, className, cardClassName, testId, dir }: {
  items: StageTab<K>[];
  value: K;
  onChange: (k: K) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Prefix for the tab ids (`${idBase}-tab-${key}`) and the panel id (`${idBase}-panel`). */
  idBase: string;
  className?: string;
  cardClassName?: string;
  testId?: string;
  dir: "rtl" | "ltr";
}) {
  const row = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  useEffect(() => {
    const el = row.current?.querySelector<HTMLElement>(`[aria-selected="true"]`);
    if (!el || !row.current) return;
    // Bring the selected card into the row's view without moving the page (instant on first paint).
    const r = row.current, a = el.getBoundingClientRect(), b = r.getBoundingClientRect();
    if (a.left < b.left || a.right > b.right) {
      const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      r.scrollBy({ left: a.left < b.left ? a.left - b.left - 16 : a.right - b.right + 16, behavior: first.current || reduce ? "auto" : "smooth" });
    }
    first.current = false;
  }, [value]);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = items.findIndex((t) => t.key === value);
    let next = -1;
    const fwd = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    if (e.key === fwd) next = (i + 1) % items.length;
    else if (e.key === back) next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].key);
    row.current?.querySelector<HTMLElement>(`#${CSS.escape(`${idBase}-tab-${items[next].key}`)}`)?.focus();
  }

  return (
    <div ref={row} role="tablist" aria-label={label} aria-orientation="horizontal" className={className} data-testid={testId} onKeyDown={onKey}>
      {items.map((t) => {
        const sel = t.key === value;
        return (
          <button key={t.key} type="button" role="tab" id={`${idBase}-tab-${t.key}`} aria-selected={sel} aria-controls={`${idBase}-panel`}
            tabIndex={sel ? 0 : -1} className={`${cardClassName ?? ""}${t.warn ? " is-warning" : ""}`} data-testid={`stage-${t.key}`}
            onClick={() => onChange(t.key)}>
            <b>{t.n}</b>
            <span>{t.label}{t.warn && t.warnLabel ? <i className="sr-warn" role="img" aria-label={t.warnLabel} /> : null}{t.sub ? <small>{t.sub}</small> : null}</span>
          </button>
        );
      })}
    </div>
  );
}
