"use client";
/**
 * Direction 2.1 · Select and Combobox — the app's one dropdown.
 *
 * `Select` is a drop-in for a native `<select>`: same props, same `<option>` / `<optgroup>`
 * children, same `onChange(e)` with a real `ChangeEvent<HTMLSelectElement>`. A visually hidden
 * native `<select>` stays in the form and remains the source of truth — it carries `name`,
 * `value` / `defaultValue`, `required`, `form` and the handlers — so FormData, constraint
 * validation and every payload are unchanged. What the person sees is a `role="combobox"`
 * button that opens:
 *   • on desktop, a popover list under the field (top layer, so dialogs and scroll boxes
 *     never clip it), with an olive ✓ on the chosen option;
 *   • on a phone (≤ 640 px or a coarse pointer), a bottom sheet titled with the field's
 *     label, large rows, a close button and a focus trap (the shell's «المزيد» sheet style).
 * A search box appears above lists longer than seven options (Arabic + Latin, diacritic- and
 * case-insensitive). `<option data-hint="…">` adds a secondary line under the label.
 *
 * `Combobox` replaces `<input list>` + `<datalist>`: a real text input whose suggestions show
 * under the field (desktop) or in the sheet (phone). Choosing a suggestion writes its value
 * into the input and fires the input's own `onChange`, exactly like picking from a datalist.
 *
 * Keyboard (WAI-ARIA APG select-only combobox): ↓ ↑ Enter Space open; ↓ ↑ PgUp PgDn Home End
 * move; Enter chooses; Esc closes; letters type ahead (or go into the search box).
 * Pure logic lives in ./select-logic.ts (unit-tested in tests/ui/unit/select.test.ts).
 */
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from "react";
import { useI18n } from "@/lib/i18n/context";
import {
  SEARCH_THRESHOLD, displayedOption, filterOptions, flattenOptions, isPlaceholderOption, moveActive,
  selectKey, typeahead, edgeActive, type SelectOption,
} from "./select-logic";
import "./select.css";

// ── Shared helpers ────────────────────────────────────────────────────────────────────

/** Phones and touch tablets get the bottom sheet. */
export const SHEET_QUERY = "(max-width: 640px), (pointer: coarse)";
const subscribeSheet = (cb: () => void) => {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(SHEET_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const sheetNow = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(SHEET_QUERY).matches;
function useSheetMode() {
  return useSyncExternalStore(subscribeSheet, sheetNow, () => false);
}

const STRINGS = {
  ar: { placeholder: "اختر…", search: "بحث", close: "إغلاق", empty: "لا توجد نتائج" },
  en: { placeholder: "Select…", search: "Search", close: "Close", empty: "No matches" },
};

/** Set a form control's value the way the browser would, so React's own onChange fires. */
function setNativeValue(el: HTMLSelectElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value); else el.value = value;
}

const collapse = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** The visible label of a field: aria-label, aria-labelledby, <label for>, a wrapping label,
    or the nearest <label> just before it in its field. Used as the sheet title. */
function fieldLabel(el: HTMLElement | null): string {
  if (!el) return "";
  const aria = el.getAttribute("aria-label");
  if (aria) return collapse(aria);
  const by = el.getAttribute("aria-labelledby");
  if (by) return collapse(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
  const strip = (label: Element) => {
    // The kits' Field puts the caption in .hr-label beside help / error lines.
    const caption = label.querySelector(".hr-label");
    const c = (caption ?? label).cloneNode(true) as HTMLElement;
    c.querySelectorAll("[data-hq-root], select, input, textarea, button, [aria-hidden='true'], .hr-help, .hr-err").forEach((n) => n.remove());
    return collapse(c.textContent).replace(/\s*\*$/, "");
  };
  const labels = (el as HTMLButtonElement).labels;
  if (labels && labels.length) {
    const s = strip(labels[0]);
    if (s) return s;
  }
  let p = el.parentElement;
  for (let depth = 0; p && depth < 3; depth++, p = p.parentElement) {
    const before = Array.from(p.querySelectorAll("label")).filter(
      (l) => !l.contains(el) && !!(l.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
    const last = before[before.length - 1];
    if (last) { const s = strip(last); if (s) return s; }
  }
  return "";
}

function Check() {
  return (
    <svg className="hq-check" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5 10 17.5 19 7" />
    </svg>
  );
}
function Chevron() {
  return (
    <svg className="hq-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

// ── Popup: the desktop popover or the phone sheet ─────────────────────────────────────

type PopupProps = {
  mode: "popover" | "sheet";
  anchorRef: React.RefObject<HTMLElement | null>;
  title: string;
  closeLabel: string;
  onClose: (refocus: boolean) => void;
  /** Rendered above the list (the search box). */
  head?: ReactNode;
  children: ReactNode;
};

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Popup({ mode, anchorRef, title, closeLabel, onClose, head, children }: PopupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  // Top layer: above every dialog and outside every overflow box. Browsers without the
  // Popover API fall back to a fixed layer with a high z-index (select.css).
  useLayoutEffect(() => {
    const el = ref.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    try { el?.showPopover?.(); } catch { /* already open or unsupported */ }
    return () => { try { el?.hidePopover?.(); } catch { /* removed */ } };
  }, []);

  // Desktop: under the field (or above it when there is more room there), start-aligned.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (mode !== "popover" || !anchor) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const rtl = getComputedStyle(anchor).direction === "rtl";
      const width = Math.min(Math.max(r.width, 220), vw - 16);
      let left = rtl ? r.right - width : r.left;
      left = Math.max(8, Math.min(left, vw - width - 8));
      const natural = el.scrollHeight;
      const below = vh - r.bottom - 12, above = r.top - 12;
      const cap = 320;
      const down = below >= Math.min(cap, natural) || below >= above;
      const maxHeight = Math.max(120, Math.min(cap, down ? below : above));
      setPos(down
        ? { left, width, top: r.bottom + 4, maxHeight }
        : { left, width, bottom: vh - r.top + 4, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [mode, anchorRef]);

  // Desktop: a press anywhere outside the field and the list closes it.
  useEffect(() => {
    if (mode !== "popover") return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      closeRef.current(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [mode, anchorRef]);

  // Phone: the page behind the sheet does not scroll.
  useEffect(() => {
    if (mode !== "sheet") return;
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = "hidden";
    return () => { html.style.overflow = prev; };
  }, [mode]);

  // Clicks inside the list never reach a wrapping <label> (which would re-toggle the field).
  const swallow = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (!t.closest("input")) e.preventDefault();
    e.stopPropagation();
  };

  if (mode === "popover") {
    return (
      <div ref={ref} popover="manual" className="hq-pop hq-menu" style={pos} onClick={swallow} data-hq-popup="">
        {head}
        {children}
      </div>
    );
  }

  const trap = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeRef.current(true); return; }
    if (e.key !== "Tab") return;
    e.stopPropagation();
    const list = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1];
    const a = document.activeElement;
    if (e.shiftKey && (a === first || !sheetRef.current?.contains(a))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (a === last || !sheetRef.current?.contains(a))) { e.preventDefault(); first.focus(); }
  };

  return (
    <div ref={ref} popover="manual" className="hq-pop hq-sheet-layer" onClick={swallow} data-hq-popup="">
      <div className="hq-sheet-scrim" aria-hidden="true" onClick={() => closeRef.current(true)} />
      <div ref={sheetRef} className="hq-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trap}>
        <div className="hq-sheet-grip" aria-hidden="true" />
        <div className="hq-sheet-head">
          <h2 id={titleId} className="hq-sheet-title">{title}</h2>
          <button type="button" className="hq-sheet-close" aria-label={closeLabel} onClick={() => closeRef.current(true)}>
            <CloseIcon />
          </button>
        </div>
        {head}
        {children}
      </div>
    </div>
  );
}

function SearchBox({ value, onChange, onKeyDown, label, inputRef, listId, activeId }: {
  value: string; onChange: (v: string) => void; onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  label: string; inputRef: React.RefObject<HTMLInputElement | null>; listId: string; activeId?: string;
}) {
  return (
    <div className="hq-search">
      <SearchIcon />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-label={label}
        placeholder={label}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

type RowOption = { value: string; label: string; hint?: string; disabled?: boolean; group?: string };

function OptionRows({ options, listId, active, selectedValue, onPick, onHover, emptyText, placeholderText }: {
  options: RowOption[]; listId: string; active: number; selectedValue: string | null;
  onPick: (i: number) => void; onHover: (i: number) => void; emptyText: string; placeholderText: string;
}) {
  return (
    <>
      {options.length === 0 ? <div className="hq-empty" role="status">{emptyText}</div> : null}
      {options.map((o, i) => {
        const header = o.group && (i === 0 || options[i - 1].group !== o.group) ? o.group : null;
        const selected = selectedValue !== null && o.value === selectedValue;
        const ph = isPlaceholderOption({ ...o, disabled: !!o.disabled });
        return (
          <div key={`${i}:${o.value}`} role="presentation" className="hq-row-wrap">
            {header ? <div className="hq-group" role="presentation">{header}</div> : null}
            <div
              id={`${listId}-${i}`}
              role="option"
              aria-selected={selected}
              aria-disabled={o.disabled || undefined}
              data-value={o.value}
              data-active={i === active || undefined}
              className="hq-opt"
              aria-label={ph ? placeholderText : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onPointerMove={() => { if (i !== active && !o.disabled) onHover(i); }}
              onClick={() => { if (!o.disabled) onPick(i); }}
            >
              <span className="hq-opt-text">
                <span className={ph ? "hq-opt-label is-placeholder" : "hq-opt-label"}>{ph ? placeholderText : o.label}</span>
                {o.hint ? <span className="hq-opt-hint">{o.hint}</span> : null}
              </span>
              {selected ? <Check /> : <span className="hq-check-space" aria-hidden="true" />}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ── Select ────────────────────────────────────────────────────────────────────────────

export type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "multiple" | "size"> & {
  /** Text shown while the empty «—» option is chosen. Defaults to «اختر…» / "Select…". */
  placeholder?: string;
  /** Title of the phone sheet; defaults to the field's label. */
  sheetTitle?: string;
  /** Force the search box on or off (default: on for more than 7 options). */
  searchable?: boolean;
  /** Extra class for the popover / sheet list. */
  listClassName?: string;
};

const PLACEHOLDER_LIKE = /^(اختر|اختيار|select\b|choose\b|pick\b)/i;

export function Select(props: SelectProps) {
  const {
    children, value, defaultValue, onChange, onInput, onInvalid, name, required, form, autoComplete,
    placeholder, sheetTitle, searchable, listClassName, className, disabled, id,
    onKeyDown, onBlur, onClick, ...rest
  } = props;
  const { lang } = useI18n();
  const S = STRINGS[lang === "en" ? "en" : "ar"];
  const options = useMemo(() => flattenOptions(children), [children]);
  const ariaLabel = rest["aria-label"];
  const nativeRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = `${useId()}-list`;
  const controlled = value !== undefined;
  const [inner, setInner] = useState(() =>
    defaultValue !== undefined && defaultValue !== null ? String(defaultValue) : (options.find((o) => !o.disabled)?.value ?? ""));
  const current = controlled ? String(value ?? "") : inner;
  const shown = displayedOption(options, current);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"popover" | "sheet">("popover");
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [invalid, setInvalid] = useState(false);
  const validating = useRef(false);
  const typed = useRef<{ buf: string; at: number }>({ buf: "", at: 0 });
  const showSearch = searchable ?? options.length > SEARCH_THRESHOLD;
  const visible = useMemo(() => (showSearch ? filterOptions(options, query) : options), [options, query, showSearch]);

  // Uncontrolled: follow the hidden select (a change from a script, a form reset).
  useEffect(() => {
    const el = nativeRef.current;
    if (!el) return;
    const sync = () => { setInner(el.value); if (el.value) setInvalid(false); };
    const onReset = () => setTimeout(sync, 0);
    el.addEventListener("change", sync);
    el.form?.addEventListener("reset", onReset);
    return () => { el.removeEventListener("change", sync); el.form?.removeEventListener("reset", onReset); };
  }, []);

  const shownIndex = shown ? visible.indexOf(shown) : -1;

  const openList = (at?: number) => {
    if (disabled) return;
    setMode(sheetNow() ? "sheet" : "popover");
    setTitle(sheetTitle ?? (fieldLabel(triggerRef.current) || ariaLabel || placeholder || S.placeholder));
    setQuery("");
    const idx = shown ? options.indexOf(shown) : -1;
    setActive(at ?? (idx >= 0 ? idx : edgeActive(options, "first")));
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const commit = (o: SelectOption | undefined) => {
    const el = nativeRef.current;
    if (!o || o.disabled || !el) return;
    if (el.value !== o.value) {
      setNativeValue(el, o.value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (!controlled) setInner(o.value);
    if (o.value) setInvalid(false);
  };

  // Focus: desktop keeps it on the field (or the search box); the sheet takes it, on the list
  // rather than the search box so the phone keyboard does not cover the options.
  useEffect(() => {
    if (!open) return;
    if (mode === "sheet") listRef.current?.focus({ preventScroll: true });
    else if (showSearch) searchRef.current?.focus({ preventScroll: true });
  }, [open, mode, showSearch]);

  // Keep the active option in view.
  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, listId]);

  const handleKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    // In the sheet, Tab belongs to the sheet's focus trap.
    if (open && mode === "sheet" && e.key === "Tab") return;
    const inSearch = e.currentTarget === searchRef.current;
    const res = selectKey({ open, active }, e.key, visible, {
      selected: shownIndex, searchable: open && showSearch && inSearch, alt: e.altKey, ctrlOrMeta: e.ctrlKey || e.metaKey,
    });
    if (!res.handled && !(open && e.key === "Tab")) return;
    if (res.handled) e.preventDefault();
    // Esc / Tab belong to this list, not to a dialog behind it; a letter typed ahead is not a
    // page shortcut (the shell's «c» opens «إنشاء»).
    if ((open && (e.key === "Escape" || e.key === "Tab")) || res.typeahead) e.stopPropagation();
    let nextActive = res.active;
    if (res.typeahead) {
      if (!open && showSearch) {
        openList();
        setQuery(res.typeahead);
        setActive(0);
        return;
      }
      const now = e.timeStamp;
      typed.current = { buf: (now - typed.current.at < 700 ? typed.current.buf : "") + res.typeahead, at: now };
      const hit = typeahead(visible, typed.current.buf, nextActive);
      if (hit >= 0) nextActive = hit;
    }
    if (res.open && !open) { openList(nextActive); return; }
    setActive(nextActive);
    if (res.commit !== undefined) commit(visible[res.commit]);
    if (!res.open && open) close(e.key !== "Tab");
  };

  const isPh = !!shown && shown.value === "" && (isPlaceholderOption(shown) || PLACEHOLDER_LIKE.test(shown.label));
  const label = !shown ? (placeholder ?? S.placeholder) : isPlaceholderOption(shown) ? (placeholder ?? S.placeholder) : shown.label;
  const focusOnTrigger = open && mode === "popover" && !showSearch;
  const activeId = open && active >= 0 && visible[active] ? `${listId}-${active}` : undefined;

  const list = (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label={title || undefined}
      className={`hq-list ${listClassName ?? ""}`}
      tabIndex={mode === "sheet" ? 0 : -1}
      aria-activedescendant={mode === "sheet" ? activeId : undefined}
      onKeyDown={mode === "sheet" ? handleKey : undefined}
    >
      <OptionRows
        options={visible}
        listId={listId}
        active={active}
        selectedValue={shown ? shown.value : null}
        onPick={(i) => { commit(visible[i]); close(true); }}
        onHover={setActive}
        emptyText={S.empty}
        placeholderText={placeholder ?? S.placeholder}
      />
    </div>
  );

  return (
    <span
      className="hq-root"
      data-hq-root=""
      onBlur={(e) => {
        if (!open || mode === "sheet") return;
        const next = e.relatedTarget as Node | null;
        if (next && e.currentTarget.contains(next)) return;
        close(false);
      }}
    >
      <button
        {...(rest as unknown as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={focusOnTrigger ? activeId : undefined}
        aria-required={required || undefined}
        aria-invalid={rest["aria-invalid"] ?? (invalid || undefined)}
        disabled={disabled}
        className={`hq-trigger${className ? ` ${className}` : ""}`}
        data-hq-select=""
        data-value={shown?.value ?? ""}
        data-placeholder={isPh || undefined}
        data-open={open || undefined}
        onClick={(e) => { onClick?.(e as unknown as React.MouseEvent<HTMLSelectElement>); if (open) close(true); else openList(); }}
        onKeyDown={(e) => { onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLSelectElement>); if (!e.defaultPrevented) handleKey(e); }}
        onBlur={onBlur as unknown as React.FocusEventHandler<HTMLButtonElement>}
      >
        <span className="hq-value">{label}</span>
        <Chevron />
      </button>
      <select
        ref={nativeRef}
        className="hq-native"
        aria-hidden="true"
        tabIndex={-1}
        name={name}
        required={required}
        form={form}
        autoComplete={autoComplete}
        disabled={disabled}
        {...(controlled ? { value } : defaultValue !== undefined ? { defaultValue } : {})}
        onChange={onChange}
        onInput={onInput}
        onInvalid={(e) => { validating.current = true; setInvalid(true); onInvalid?.(e); }}
        onFocus={() => {
          // Only constraint validation focuses this control; leave the browser's bubble in
          // place then, otherwise hand focus to the visible field.
          if (validating.current) { validating.current = false; return; }
          triggerRef.current?.focus({ preventScroll: true });
        }}
      >
        {children}
      </select>
      {open ? (
        <Popup
          mode={mode}
          anchorRef={triggerRef}
          title={title}
          closeLabel={S.close}
          onClose={close}
          head={showSearch ? (
            <SearchBox
              value={query}
              onChange={(v) => { setQuery(v); setActive(v ? 0 : Math.max(0, shown ? options.indexOf(shown) : 0)); }}
              onKeyDown={handleKey}
              label={S.search}
              inputRef={searchRef}
              listId={listId}
              activeId={activeId}
            />
          ) : null}
        >
          {list}
        </Popup>
      ) : null}
    </span>
  );
}

// ── Combobox (text input with suggestions; replaces <datalist>) ───────────────────────

export type ComboboxOption = { value: string; label?: string; hint?: string; disabled?: boolean };
export type ComboboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "list"> & {
  options: ComboboxOption[];
  sheetTitle?: string;
  /** Called after a suggestion is chosen (the input's onChange has already fired). */
  onPick?: (option: ComboboxOption) => void;
};

export function Combobox(props: ComboboxProps) {
  const { options, sheetTitle, onPick, onChange, onKeyDown, onClick, onBlur, className, disabled, readOnly, ...rest } = props;
  const { lang } = useI18n();
  const S = STRINGS[lang === "en" ? "en" : "ar"];
  const sheetMode = useSheetMode();
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = `${useId()}-list`;
  const [text, setText] = useState(() => String(rest.value ?? rest.defaultValue ?? ""));
  const current = rest.value !== undefined ? String(rest.value ?? "") : text;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"popover" | "sheet">("popover");
  const [title, setTitle] = useState("");
  const [active, setActive] = useState(-1);
  const rows: RowOption[] = useMemo(() => options.map((o) => ({ ...o, label: o.label ?? o.value })), [options]);
  const exact = rows.find((o) => o.value === current);
  const visible = useMemo(() => (exact ? rows : filterOptions(rows, current)), [rows, current, exact]);

  const openList = (at?: number) => {
    if (disabled || readOnly) return;
    const sheet = sheetNow();
    setMode(sheet ? "sheet" : "popover");
    setTitle(sheetTitle ?? (fieldLabel(inputRef.current) || rest["aria-label"] || rest.placeholder || ""));
    setActive(at ?? (exact ? rows.indexOf(exact) : -1));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus && mode === "sheet") inputRef.current?.focus({ preventScroll: true });
  };
  const writing = useRef(false);
  const write = (v: string) => {
    const el = inputRef.current;
    if (!el) return;
    if (el.value !== v) {
      setNativeValue(el, v);
      writing.current = true;
      try { el.dispatchEvent(new Event("input", { bubbles: true })); } finally { writing.current = false; }
    }
    setText(v);
  };
  const pick = (i: number) => {
    const o = visible[i];
    if (!o || o.disabled) return;
    write(o.value);
    setOpen(false);
    onPick?.(options.find((x) => x.value === o.value) ?? o);
    if (mode === "sheet") inputRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (open && mode === "sheet") listRef.current?.focus({ preventScroll: true });
  }, [open, mode]);
  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, listId]);

  const handleKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) openList(visible.length ? (exact ? rows.indexOf(exact) : edgeActive(visible, "first")) : -1);
        else setActive(moveActive(visible, active, e.altKey ? 0 : 1));
        return;
      case "ArrowUp":
        if (!open) return;
        e.preventDefault();
        setActive(moveActive(visible, active, -1));
        return;
      case "PageDown": if (open) { e.preventDefault(); setActive(moveActive(visible, active, 10)); } return;
      case "PageUp": if (open) { e.preventDefault(); setActive(moveActive(visible, active, -10)); } return;
      case "Enter":
        if (open && active >= 0) { e.preventDefault(); pick(active); }
        else if (open && mode === "sheet") { e.preventDefault(); close(true); }
        return;
      case "Escape":
        if (open) { e.preventDefault(); e.stopPropagation(); close(true); }
        return;
      case "Tab":
        if (open && mode === "popover") setOpen(false);
        return;
    }
  };

  const activeId = open && active >= 0 && visible[active] ? `${listId}-${active}` : undefined;
  const list = (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label={title || undefined}
      className="hq-list"
      tabIndex={mode === "sheet" ? 0 : -1}
      aria-activedescendant={mode === "sheet" ? activeId : undefined}
      onKeyDown={mode === "sheet" ? handleKey : undefined}
    >
      <OptionRows
        options={visible}
        listId={listId}
        active={active}
        selectedValue={exact ? exact.value : null}
        onPick={pick}
        onHover={setActive}
        emptyText={S.empty}
        placeholderText={S.placeholder}
      />
    </div>
  );

  return (
    <span
      className="hq-root"
      data-hq-root=""
      onBlur={(e) => {
        if (!open || mode === "sheet") return;
        const next = e.relatedTarget as Node | null;
        if (next && e.currentTarget.contains(next)) return;
        setOpen(false);
      }}
    >
      <input
        {...rest}
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && mode === "popover" ? activeId : undefined}
        autoComplete="off"
        disabled={disabled}
        // On a phone the input only opens the sheet; typing happens in the sheet's search box.
        readOnly={readOnly || sheetMode}
        inputMode={sheetMode ? "none" : rest.inputMode}
        className={`hq-combo${className ? ` ${className}` : ""}`}
        data-hq-combobox=""
        onChange={(e) => {
          setText(e.target.value);
          onChange?.(e);
          if (!writing.current && !sheetNow() && document.activeElement === e.target) {
            if (!open) openList(-1);
            setActive(-1);
          }
        }}
        onClick={(e) => { onClick?.(e); if (!open) openList(); else if (mode === "popover") setOpen(false); }}
        onKeyDown={(e) => { onKeyDown?.(e); if (!e.defaultPrevented) handleKey(e); }}
        onBlur={onBlur}
      />
      {open ? (
        <Popup
          mode={mode}
          anchorRef={inputRef}
          title={title}
          closeLabel={S.close}
          onClose={(refocus) => close(refocus)}
          head={mode === "sheet" ? (
            <SearchBox
              value={exact ? "" : current}
              onChange={(v) => { write(v); setActive(-1); }}
              onKeyDown={handleKey}
              label={rest.placeholder || S.search}
              inputRef={searchRef}
              listId={listId}
              activeId={activeId}
            />
          ) : null}
        >
          {list}
        </Popup>
      ) : null}
    </span>
  );
}
