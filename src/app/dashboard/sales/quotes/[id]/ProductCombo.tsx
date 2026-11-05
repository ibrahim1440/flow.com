"use client";
// Quotes v2 (owner-approved Figma page 11, «٤ · خانة المنتج», 5 Nov 2026): the line's product is a list WITH a search —
// type and pick — instead of one long dropdown. Same choices as before: the sellable SKUs (GET /api/products), or
// «— وصف حر —» for something outside the catalogue. Picking a SKU fills the unit price and the unit (the caller's
// chooseSku); the employee can still change both. Keyboard: ↑/↓ to move, Enter to pick, Esc to close.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatMoney } from "@/lib/format/money";

export type ComboSku = { id: string; skuCode: string; name: string | null; nameAr: string | null; unitOfMeasure: string; price: number; availableUnits?: number };

const FREE = "__free__";

/**
 * One box for the line's product (owner, round 2: «نفس فيجما»): a catalogue product, or free text typed in the same box —
 * `freeText` is the line's description when it has no SKU; typing and leaving the box (or picking «— وصف حر —»)
 * keeps what was typed as the description.
 */
export function ProductCombo({ skus, value, ar, label, onPick, testId, freeText, onFreeText }: {
  skus: ComboSku[]; value: string; ar: boolean; label: string; onPick: (skuId: string) => void; testId?: string;
  freeText?: string; onFreeText?: (text: string) => void;
}) {
  const L = (a: string, e: string) => (ar ? a : e);
  const nameOf = (s: ComboSku) => (ar ? s.nameAr : null) ?? s.name ?? s.skuCode;
  const chosen = skus.find((s) => s.id === value) ?? null;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  // The list is placed with fixed coordinates: the lines table scrolls sideways (overflow), which would cut it off.
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = input.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.max(r.width, Math.min(360, window.innerWidth - 16));
      const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
      const up = window.innerHeight - r.bottom < 220 && r.top > window.innerHeight - r.bottom;
      setPos({ top: up ? r.top - 4 : r.bottom + 4, left, width, up });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);

  const norm = (s: string) => s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).toLowerCase().trim();
  const matches = useMemo(() => {
    const t = norm(q);
    const list = t ? skus.filter((s) => [s.name, s.nameAr, s.skuCode].some((x) => x && norm(x).includes(t))) : skus;
    return list.slice(0, 50);
  }, [q, skus]);
  // The options in order: the matching SKUs, then «— وصف حر —».
  const options = useMemo(() => [...matches.map((s) => s.id), FREE], [matches]);

  // The latest «close» for the outside-click listener (it reads the typed text).
  const closeLatest = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) closeLatest.current(); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  function pick(id: string) {
    onPick(id === FREE ? "" : id);
    if (id === FREE && onFreeText) onFreeText(q.trim() || freeText || "");
    setOpen(false);
    setQ("");
  }
  /** Leaving the box: text typed on a line with no product stays as its description. */
  function closeKeepingText() {
    if (!chosen && onFreeText && q.trim() && q.trim() !== (freeText ?? "")) onFreeText(q.trim());
    setOpen(false);
    setQ("");
  }

  useEffect(() => { closeLatest.current = closeKeepingText; });

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!open) setOpen(true); setActive((a) => Math.min(a + 1, options.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { if (open) { e.preventDefault(); pick(options[active] ?? FREE); } }
    else if (e.key === "Escape") { if (open) { e.preventDefault(); setOpen(false); setQ(""); } }
    else if (e.key === "Tab") { if (open) closeKeepingText(); }
  }

  const shown = open ? q : chosen ? nameOf(chosen) : (freeText ?? "");
  return (
    <div className="q-combo" ref={wrap}>
      <input
        ref={input}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        className="qi prodsel"
        value={shown}
        placeholder={chosen ? nameOf(chosen) : value ? L("اكتب اسم المنتج…", "Type a product…") : L("— وصف حر — (اكتب لتختار منتج)", "— free text — (type to pick a product)")}
        onFocus={() => { if (!chosen && freeText) setQ(freeText); setOpen(true); setActive(0); }}
        onClick={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={onKey}
        data-testid={testId}
      />
      <span className="q-combo-chev" aria-hidden><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg></span>
      {open ? (
        <ul id={listId} role="listbox" className="q-combo-list" aria-label={label}
          style={pos ? { position: "fixed", top: pos.up ? undefined : pos.top, bottom: pos.up ? window.innerHeight - pos.top : undefined, left: pos.left, width: pos.width, insetInlineStart: "auto", insetInlineEnd: "auto", minWidth: 0 } : { visibility: "hidden" }}>
          {matches.map((s, i) => (
            <li key={s.id} id={`${listId}-${i}`} role="option" aria-selected={s.id === value}
              className={i === active ? "is-active" : undefined}
              onMouseDown={(e) => { e.preventDefault(); pick(s.id); }} onMouseEnter={() => setActive(i)}>
              <span className="q-combo-main"><b><bdi>{nameOf(s)}</bdi></b><span className="q-combo-sub"><bdi dir="ltr">{s.skuCode}</bdi>{typeof s.availableUnits === "number" ? <> · {L("في المخزون", "in stock")} <bdi className="n">{s.availableUnits}</bdi></> : null}</span></span>
              <span className="q-combo-price"><bdi className="n">{formatMoney(String(s.price ?? 0))}</bdi> {L("ر.س", "SAR")}</span>
            </li>
          ))}
          {matches.length === 0 ? <li className="q-combo-none" role="presentation">{L("ما فيه منتج بهذا الاسم.", "No product by that name.")}</li> : null}
          <li id={`${listId}-${matches.length}`} role="option" aria-selected={!value}
            className={`q-combo-free${active === matches.length ? " is-active" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); pick(FREE); }} onMouseEnter={() => setActive(matches.length)}>
            {q.trim() ? L(`— وصف حر: «${q.trim()}»`, `— free text: «${q.trim()}»`) : L("— وصف حر — (منتج غير موجود في الكتالوج)", "— free text — (not in the catalogue)")}
          </li>
        </ul>
      ) : null}
    </div>
  );
}
