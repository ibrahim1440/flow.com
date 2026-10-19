// Pure logic behind the Direction 2.1 Select / Combobox (src/components/ui/Select.tsx):
// reading <option>/<optgroup> children, the diacritic- and case-insensitive filter, and the
// keyboard model. No DOM here, so tests/ui/unit/select.test.ts can drive it under node:test.
import { Children, Fragment, isValidElement, type ReactNode } from "react";

export type SelectOption = {
  value: string;
  label: string;
  /** Secondary line under the label (`<option data-hint="…">`). */
  hint?: string;
  disabled: boolean;
  /** The `<optgroup label>` the option sits in, if any. */
  group?: string;
};

type ElementProps = { children?: ReactNode; value?: unknown; disabled?: boolean; label?: unknown; "data-hint"?: unknown };

/** The visible text of a React node, as the browser would show it inside an <option>. */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<ElementProps>(node)) return textOf(node.props.children);
  return "";
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Flatten the children of a native <select> into a list of options, the way the browser does:
 * fragments and arrays are walked, <optgroup> contributes its label (and disables its
 * options when disabled), and an <option> without a value submits its text.
 */
export function flattenOptions(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  const walk = (node: ReactNode, group?: string, groupDisabled = false) => {
    Children.forEach(node, (child) => {
      if (!isValidElement<ElementProps>(child)) return;
      if (child.type === Fragment) return walk(child.props.children, group, groupDisabled);
      if (child.type === "optgroup") {
        return walk(child.props.children, collapse(textOf(child.props.label as ReactNode)), groupDisabled || !!child.props.disabled);
      }
      if (child.type === "option") {
        const label = collapse(child.props.label != null ? textOf(child.props.label as ReactNode) : textOf(child.props.children));
        const value = child.props.value != null ? String(child.props.value) : label;
        const hintRaw = child.props["data-hint"];
        const hint = hintRaw == null || hintRaw === "" || hintRaw === false ? undefined : String(hintRaw);
        out.push({ value, label, hint, disabled: groupDisabled || !!child.props.disabled, group });
        return;
      }
      // Any other element (e.g. a component returning options) is walked for options.
      if (child.props && "children" in child.props) walk(child.props.children, group, groupDisabled);
    });
  };
  walk(children);
  return out;
}

/** An empty-value option whose label is only a dash or dots reads as the «اختر…» placeholder. */
export function isPlaceholderOption(o: SelectOption | undefined): boolean {
  return !!o && o.value === "" && /^[\s\-–—·.…]*$/.test(o.label);
}

/**
 * The option a native <select> would display for `value`: the matching option, otherwise —
 * as React does for a controlled select whose value matches nothing — the first enabled one.
 */
export function displayedOption(options: SelectOption[], value: string): SelectOption | undefined {
  return options.find((o) => o.value === value) ?? options.find((o) => !o.disabled) ?? options[0];
}

// ── Search ────────────────────────────────────────────────────────────────────────────

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
/**
 * Fold text for matching: case, Latin accents (é → e), Arabic harakat / tatweel / Quranic
 * marks, hamza carriers (أ إ آ ٱ → ا, ؤ → و, ئ → ي), ى → ي, ة → ه, Arabic-Indic digits → 0-9.
 */
export function normalizeSearch(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ؐ-ًؚ-ٰٟـۖ-ۭ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/[ئى]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) - (d >= "۰" ? 0x06f0 : 0x0660))))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Every word of the query must appear in the option's label or secondary line. */
export function matchesQuery(o: { label: string; hint?: string; value?: string }, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const hay = normalizeSearch(`${o.label} ${o.hint ?? ""}`);
  return q.split(" ").every((w) => hay.includes(w));
}

export function filterOptions<T extends { label: string; hint?: string }>(options: T[], query: string): T[] {
  return query.trim() ? options.filter((o) => matchesQuery(o, query)) : options;
}

/** A search box is shown when the list is longer than this. */
export const SEARCH_THRESHOLD = 7;

// ── Keyboard model ────────────────────────────────────────────────────────────────────

type Activatable = { disabled?: boolean };

/** Move the active index by `delta`, skipping disabled options; stops at the ends. */
export function moveActive(options: Activatable[], from: number, delta: number): number {
  if (!options.length) return -1;
  const step = delta < 0 ? -1 : 1;
  let i = from < 0 ? (step > 0 ? -1 : options.length) : from;
  let moved = 0;
  let last = from >= 0 && !options[from]?.disabled ? from : -1;
  const want = Math.abs(delta) || 1;
  while (moved < want) {
    i += step;
    if (i < 0 || i >= options.length) break;
    if (!options[i].disabled) { last = i; moved++; }
  }
  return last >= 0 ? last : edgeActive(options, step > 0 ? "first" : "last");
}

export function edgeActive(options: Activatable[], edge: "first" | "last"): number {
  if (edge === "first") return options.findIndex((o) => !o.disabled);
  for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
  return -1;
}

/**
 * Type-ahead: the next enabled option (after `from`, wrapping) whose label starts with the
 * typed buffer. A buffer of one repeated letter cycles through the options with that letter.
 */
export function typeahead(options: { label: string; disabled?: boolean }[], buffer: string, from: number): number {
  const b = normalizeSearch(buffer);
  if (!b || !options.length) return -1;
  const same = b.split("").every((c) => c === b[0]);
  const needle = same && b.length > 1 ? b[0] : b;
  const start = same || from < 0 ? from + 1 : from;
  for (let k = 0; k < options.length; k++) {
    const i = (Math.max(start, 0) + k) % options.length;
    const o = options[i];
    if (!o.disabled && normalizeSearch(o.label).startsWith(needle)) return i;
  }
  return -1;
}

export type KeyState = { open: boolean; active: number };
export type KeyResult = KeyState & {
  /** Index of the option to commit as the new value. */
  commit?: number;
  /** The key was consumed; the caller should preventDefault. */
  handled: boolean;
  /** A printable character to feed into type-ahead. */
  typeahead?: string;
};

/**
 * The select-only combobox keyboard (WAI-ARIA APG «Select-Only Combobox»):
 * closed — ↓ ↑ Enter Space Alt+↓ open, Home/End open on the first/last, a letter opens with
 * type-ahead; open — ↓ ↑ PageDown PageUp Home End move, Enter (and Space without a search
 * box) chooses, Esc closes, Tab closes.
 */
export function selectKey(
  state: KeyState,
  key: string,
  options: Activatable[],
  ctx: { selected: number; searchable: boolean; alt?: boolean; ctrlOrMeta?: boolean },
): KeyResult {
  const { open, active } = state;
  const from = active >= 0 ? active : ctx.selected;
  if (!open) {
    switch (key) {
      case "ArrowDown": case "ArrowUp": case "Enter": case " ":
        return { open: true, active: ctx.selected >= 0 ? ctx.selected : edgeActive(options, "first"), handled: true };
      case "Home": return { open: true, active: edgeActive(options, "first"), handled: true };
      case "End": return { open: true, active: edgeActive(options, "last"), handled: true };
      default:
        if (key.length === 1 && !ctx.ctrlOrMeta && key !== " ") return { open: true, active: from, handled: true, typeahead: key };
        return { ...state, handled: false };
    }
  }
  switch (key) {
    case "ArrowDown": return { open, active: ctx.alt ? from : moveActive(options, from, 1), handled: true };
    case "ArrowUp":
      if (ctx.alt) return { open: false, active: from, commit: from >= 0 ? from : undefined, handled: true };
      return { open, active: moveActive(options, from, -1), handled: true };
    case "PageDown": return { open, active: moveActive(options, from, 10), handled: true };
    case "PageUp": return { open, active: moveActive(options, from, -10), handled: true };
    case "Home": return ctx.searchable ? { ...state, handled: false } : { open, active: edgeActive(options, "first"), handled: true };
    case "End": return ctx.searchable ? { ...state, handled: false } : { open, active: edgeActive(options, "last"), handled: true };
    case "Enter":
      return { open: false, active, commit: active >= 0 && !options[active]?.disabled ? active : undefined, handled: true };
    case " ":
      if (ctx.searchable) return { ...state, handled: false };
      return { open: false, active, commit: active >= 0 && !options[active]?.disabled ? active : undefined, handled: true };
    case "Escape": return { open: false, active, handled: true };
    case "Tab": return { open: false, active, handled: false };
    default:
      if (!ctx.searchable && key.length === 1 && !ctx.ctrlOrMeta) return { ...state, handled: true, typeahead: key };
      return { ...state, handled: false };
  }
}
