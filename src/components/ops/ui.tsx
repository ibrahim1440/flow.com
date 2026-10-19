"use client";
// Operations — Direction 2.1 UI kit. The page, table, preview, tab, button, field and status
// primitives are the shared Direction 2.1 ones from the HR kit (scoped by [data-hr-root]);
// this file adds the operations scope (ops.css) and bilingual versions of the states, since
// the operations screens are used in both Arabic and English.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import { Btn, Empty, Notice, dateTimeIn } from "@/components/hr/ui";
import "@/components/hr/hr.css";
import "./ops.css";

export {
  Btn, Dot, Empty, Field, FilterChip, Flag, KV, Notice, PageHeader, StatusDot, Tabs,
  type Tone,
} from "@/components/hr/ui";

/**
 * The operations metric strip (prd-overview / prd-order tiles): label, a number-only value
 * and a caption that carries the unit and the qualifier («كغ · أقدمها منذ 19 ساعة»). The HR
 * kit's Metrics has no caption slot (its third element is a class), so the operations
 * screens get their own; an optional fourth element is the cell's class (e.g. hr-hide-mobile).
 */
export function Metrics({ items, className }: { items: ([string, ReactNode] | [string, ReactNode, ReactNode] | [string, ReactNode, ReactNode, string])[]; className?: string }) {
  return (
    <div className={`hr-metrics ops-metrics${className ? ` ${className}` : ""}`}>
      {items.map(([k, v, cap, cls]) => (
        <div key={k} className={cls}>
          <span className="hr-caption">{k}</span>
          <span className="hr-metric">{v}</span>
          {cap ? <span className="ops-mcap">{cap}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** Timeline (prd-order «سجل الأمر»): a marker per event, the event text, then «when · who». */
export function Timeline({ items }: { items: { key: string; text: ReactNode; when: ReactNode; tone?: "danger" | "success" }[] }) {
  return (
    <ol className="ops-tl">
      {items.map((it) => (
        <li key={it.key} className={it.tone ? `is-${it.tone}` : undefined}>
          <span className="ops-tl-text">{it.text}</span>
          <span className="ops-tl-when">{it.when}</span>
        </li>
      ))}
    </ol>
  );
}

/** prd-order five-stage tracker: title, then two secondary lines; done / current / pending. */
export function Stages({ items }: { items: { key: string; title: string; a?: ReactNode; b?: ReactNode; state: "done" | "current" | "pending" }[] }) {
  return (
    <ol className="ops-stages">
      {items.map((st) => (
        <li key={st.key} className={`is-${st.state}`} aria-current={st.state === "current" ? "step" : undefined}>
          <span className="ops-stage-title">{st.title}</span>
          {st.a ? <span className="ops-stage-a">{st.a}</span> : null}
          {st.b ? <span className="ops-stage-b">{st.b}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** Loss track (prd-order): the product's expected band and a marker at the batch's loss. */
export function LossTrack({ pct, expected, tone }: { pct: number; expected: number; tone?: "danger" }) {
  // The track spans 0–2× the expected loss, so «expected» sits at the middle and the band
  // ±3 points around it; a marker past the end is pinned there.
  const span = Math.max(expected * 2, 1);
  const at = Math.max(0, Math.min(100, (pct / span) * 100));
  const b0 = Math.max(0, ((expected - 3) / span) * 100), b1 = Math.min(100, ((expected + 3) / span) * 100);
  return (
    <span className={`ops-losstrack${tone ? ` tone-${tone}` : ""}`} role="img" aria-label={`${pct.toFixed(1)}%`}>
      <i className="ops-lossband" style={{ insetInlineStart: `${b0}%`, width: `${b1 - b0}%` }} />
      <i className="ops-lossmark" style={{ insetInlineStart: `calc(${at}% - 6px)` }} />
    </span>
  );
}

/** The operations content scope. Wraps every operations page inside the shared shell. */
export function OpsRoot({ children, className = "", wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // N-20 (prd-390a/b/c, orders-390): when the shell's phone header already carries the page's
  // title, the page's own h1 is not drawn a second time — it stays in the document, visually
  // hidden, for assistive technology. Compared by text, so a detail page whose h1 differs from
  // the header (a production order number, a session name) keeps it. A shell without a phone
  // title leaves every h1 as it is.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const sync = () => {
      const header = document.querySelector(".d21-mtop h2")?.textContent?.trim() ?? "";
      for (const h of Array.from(root.querySelectorAll<HTMLElement>(".hr-pagehead > .hr-title"))) {
        h.classList.toggle("ops-dup-title", header !== "" && h.textContent?.trim() === header);
      }
    };
    // Watched narrowly: the shell header alone; the page is watched (for an h1 that renders
    // after its data) only while the header carries a phone title — never on this shell.
    const header = document.querySelector(".d21-mtop");
    if (!header) return;
    const pageMo = new MutationObserver(sync);
    let watchingPage = false;
    const onHeader = () => {
      const has = !!header.querySelector("h2");
      if (has && !watchingPage) { pageMo.observe(root, { childList: true, subtree: true }); watchingPage = true; }
      if (!has && watchingPage) { pageMo.disconnect(); watchingPage = false; }
      sync();
    };
    onHeader();
    const headerMo = new MutationObserver(onHeader);
    headerMo.observe(header, { childList: true, subtree: true, characterData: true });
    return () => { headerMo.disconnect(); pageMo.disconnect(); };
  }, []);
  return (
    <div ref={ref} data-hr-root="" data-ops-root="" className={`${wide ? "ops-wide " : ""}${className}`}>
      {children}
    </div>
  );
}

/** `ar` / `en` pair, picked by the viewer's language. For text that has no translation key. */
export function useL() {
  const { lang } = useI18n();
  return (ar: string, en: string) => (lang === "ar" ? ar : en);
}

export function OpsLoading({ rows = 6, label }: { rows?: number; label?: string }) {
  const { t } = useI18n();
  const text = label ?? t("loading");
  return (
    <div aria-busy="true" aria-label={text} className="hr-stack" style={{ paddingBlock: 8 }}>
      <span className="hr-caption">{text}</span>
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="hr-skel" style={{ width: `${70 + ((i * 7) % 30)}%` }} />)}
    </div>
  );
}

export function OpsError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const L = useL();
  return (
    <div className="hr-notice tone-danger" role="alert" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <div>
        <strong className="d21-bold">{L("تعذّر التحميل.", "Could not load.")}</strong> <span>{message}</span>
        <div className="hr-caption">{L("لم يتغير أي شيء.", "Nothing was changed.")}</div>
      </div>
      {onRetry ? <Btn size="sm" onClick={onRetry}>{L("إعادة المحاولة", "Try again")}</Btn> : null}
    </div>
  );
}

export function OpsEmpty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return <Empty title={title} body={body} action={action} />;
}

/** A success / error banner after an action (replaces the legacy coloured toast boxes). */
export function OpsBanner({ tone, children, onClose }: { tone: "success" | "danger" | "warning" | "info"; children: ReactNode; onClose?: () => void }) {
  const L = useL();
  return (
    <Notice tone={tone}>
      <span style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <span>{children}</span>
        {onClose ? <button type="button" className="hr-btn is-ghost is-sm" aria-label={L("إغلاق", "Close")} onClick={onClose}>✕</button> : null}
      </span>
    </Notice>
  );
}

/** A short progress track (0–100), optionally toned. */
export function Bar({ pct, tone, wide, label }: { pct: number; tone?: "success" | "warning" | "danger"; wide?: boolean; label?: string }) {
  const v = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <span className={`ops-bar${tone ? ` tone-${tone}` : ""}${wide ? " is-wide" : ""}`} role="img" aria-label={label ?? `${Math.round(v)}%`}>
      <span style={{ width: `${v}%` }} />
    </span>
  );
}

/** A section heading with an optional caption and end action. */
export function SecHead({ title, caption, action }: { title: ReactNode; caption?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ops-sechead">
      <h2>{title}</h2>
      {caption ? <p className="hr-caption">{caption}</p> : null}
      {action ?? null}
    </div>
  );
}

/** Grams with their unit: «3200 غ» in Arabic, an LTR-isolated «3200 g» in English (D-1). */
export function Grams({ v, strong }: { v: number | string | null | undefined; strong?: boolean }) {
  const { lang } = useI18n();
  const n = v ?? "—";
  const num = strong ? <strong className="hr-num">{n}</strong> : <span className="hr-num">{n}</span>;
  return lang === "ar" ? <span className="ops-kg">{num} غ</span> : <bdi dir="ltr" className="ops-kg">{num} g</bdi>;
}

/** The gram unit as plain text, for strings built outside JSX. */
export function gUnit(lang: "ar" | "en"): string { return lang === "ar" ? "غ" : "g"; }

/** Whole sellable units: «3 وحدة» / «3 units». */
export function Units({ v, strong }: { v: number | null | undefined; strong?: boolean }) {
  const { t } = useI18n();
  const n = v ?? "—";
  return <span>{strong ? <strong className="hr-num">{n}</strong> : <span className="hr-num">{n}</span>} {t("unitsLabel")}</span>;
}

/** Kilograms with up to three decimals, tabular. */
/** A weight with its unit: «5.00 كغ» in Arabic, an LTR-isolated «5.00 kg» in English (D-1 / D-6). */
export function Kg({ v, digits = 2, strong }: { v: number | string | null | undefined; digits?: number; strong?: boolean }) {
  const { lang } = useI18n();
  const n = typeof v === "number" ? kg(v, digits) : (v ?? "—");
  const num = strong ? <strong className="hr-num">{n}</strong> : <span className="hr-num">{n}</span>;
  return lang === "ar" ? <span className="ops-kg">{num} كغ</span> : <bdi dir="ltr" className="ops-kg">{num} kg</bdi>;
}
/**
 * Operational dates (FREEZE.md owner decision D1, 7 Oct): the short form — «اليوم 14:00», «أمس»,
 * «5 أكتوبر» — and `dd/mm/yyyy` only outside the current year (precision / audit contexts keep the
 * numeric form). Riyadh day boundaries, Latin digits.
 */
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function opsDate(d: Date | string | null | undefined, lang: "ar" | "en" = "ar", withTime = false): string {
  if (!d) return "—";
  const local = dateTimeIn(d); // "YYYY-MM-DD HH:mm" in Riyadh
  const today = dateTimeIn(new Date());
  const [day, time] = [local.slice(0, 10), local.slice(11, 16)];
  const ar = lang === "ar";
  const dayDiff = Math.round((Date.parse(`${today.slice(0, 10)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
  const t = withTime && time ? ` ${time}` : "";
  if (dayDiff === 0) return (ar ? "اليوم" : "Today") + t;
  if (dayDiff === 1) return (ar ? "أمس" : "Yesterday") + t;
  if (dayDiff === -1) return (ar ? "غدًا" : "Tomorrow") + t;
  const [y, m, dd] = day.split("-").map(Number);
  if (String(y) === today.slice(0, 4)) return ar ? `${dd} ${AR_MONTHS[m - 1]}${t}` : `${dd} ${EN_MONTHS[m - 1]}${t}`;
  return `${String(dd).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}${t}`;
}

export const kg = (v: number | string | null | undefined, digits = 2) => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
};

/** A row that opens a preview: click, Enter or Space. */
export function rowOpen(open: () => void) {
  return {
    className: "is-clickable",
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    },
  };
}

/**
 * The operations decision pane (prd-qc / prd-pack / prd-blend). Lives inside an `hr-split`
 * next to the page: docked beside the list at 1440, an overlay drawer over a scrim below 1280
 * (the approved HR preview), and on the phone either a bottom sheet (`phone="sheet"`, prd-390b
 * QC decision) or a full-screen view with a back arrow and a sticky action bar (`phone="page"`,
 * prd-390b packaging).
 *
 * Accessibility: named by its h2 (`aria-labelledby`). Focus moves into the pane on open, Esc
 * closes it (unless `busy`) and focus returns to the opener. Below 1280 — drawer and sheet —
 * it is modal: `aria-modal="true"`, Tab / Shift+Tab cycle inside it, and everything behind it
 * is `inert`. The docked 1440 pane is not modal (the list beside it stays usable).
 *
 * `drawer="open"` (N-05, OG-P3 / G-5 «تبقى القائمة ظاهرة»): at 768–1279 the drawer is NOT
 * modal either — no scrim, no `aria-modal`, nothing inert, Tab is not trapped — exactly like
 * the cupping invite drawer. Esc still closes it and focus still returns to the opener. The
 * phone (below 768) keeps the modal full-screen view.
 */
/** Another modal layer (an HR `Dialog`, the edit-date modal) is open above `self`. */
export function layerAbove(self: Element | null): boolean {
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some((x) => x !== self);
}

export function OpsPane({ title, sub, onClose, children, footer, testId, label, phone = "sheet", busy, drawer = "modal" }: {
  title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode;
  testId?: string; label: string; phone?: "sheet" | "page"; busy?: boolean; drawer?: "modal" | "open";
}) {
  const { t, lang } = useI18n();
  const ref = useRef<HTMLElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const titleId = useId();
  const [modal, setModal] = useState(false);
  useEffect(() => { closeRef.current = onClose; busyRef.current = busy; });
  useEffect(() => {
    const mq = window.matchMedia(drawer === "open" ? "(max-width: 767px)" : "(max-width: 1279px)");
    const on = () => setModal(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [drawer]);
  useEffect(() => {
    let opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus], .hr-preview-body :is(button, input, select, textarea):not([disabled])");
    (first ?? el)?.focus({ preventScroll: true });
    // D-1: Esc closes only the topmost layer. A dialog open above the pane (hold / cancel,
    // edit date) handles its own Esc, so the pane neither closes nor swallows the key.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busyRef.current || layerAbove(ref.current)) return;
      e.stopPropagation(); closeRef.current();
    };
    // A non-modal pane stays open while another row beside it is chosen: the element that
    // last took focus outside the pane (not a dialog above it) is the one focus returns to.
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || target === document.body || el?.contains(target)) return;
      if (target.closest('[role="dialog"], [role="alertdialog"], .hr-dialog-backdrop')) return;
      opener = target;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      // After this commit: the modal effect's cleanup lifts `inert` from the page in the same
      // pass, and an inert opener would refuse focus (the phone view returned focus to body).
      const back = opener;
      setTimeout(() => {
        // Only when focus was left with nowhere to go — never away from a pane opened since.
        const active = document.activeElement;
        if (active && active !== document.body) return;
        if (back && back.isConnected && !back.closest("[inert]")) back.focus({ preventScroll: true });
      }, 0);
    };
  }, []);
  // Modal (drawer / sheet): everything outside the pane and its scrim is inert, and Tab cycles.
  useEffect(() => {
    if (!modal) return;
    const el = ref.current;
    if (!el) return;
    const keep = new Set<Element>([el, scrimRef.current].filter(Boolean) as Element[]);
    const made: Element[] = [];
    for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      for (const sib of Array.from(parent.children)) {
        if (sib === node || keep.has(sib) || sib.hasAttribute("inert") || sib.tagName === "SCRIPT") continue;
        sib.setAttribute("inert", ""); made.push(sib);
      }
    }
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || layerAbove(el)) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]):not(.hq-native), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")).filter((x) => x.offsetParent !== null);
      if (items.length === 0) { e.preventDefault(); el.focus(); return; }
      const firstEl = items[0], lastEl = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === firstEl || !el.contains(active))) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && (active === lastEl || !el.contains(active))) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener("keydown", onTab);
    return () => { document.removeEventListener("keydown", onTab); for (const m of made) m.removeAttribute("inert"); };
  }, [modal]);
  return (
    <>
      <div ref={scrimRef} className={`hr-scrim ops-pane-scrim${drawer === "open" ? " is-open-drawer" : ""}`} aria-hidden="true" onClick={() => { if (!busy) onClose(); }} />
      <aside ref={ref} tabIndex={-1} role="dialog" aria-modal={modal ? "true" : undefined} aria-labelledby={titleId} aria-label={undefined} data-label={label} data-testid={testId}
        className={`hr-preview ops-pane is-${phone}${drawer === "open" ? " is-open-drawer" : ""}`}>
        <span className="ops-pane-grab" aria-hidden="true" />
        <div className="hr-preview-head ops-pane-head">
          {phone === "page" ? (
            <button type="button" className="hr-btn is-ghost is-sm ops-pane-back" aria-label={t("opsBack")} onClick={onClose} disabled={busy}>{lang === "ar" ? "→" : "←"}</button>
          ) : null}
          <h2 className="ops-pane-title" id={titleId}>{title}{sub ? <span className="ops-pane-sub">{sub}</span> : null}</h2>
          <Btn variant="ghost" size="sm" className="ops-pane-close" aria-label={t("opsCloseDetail")} onClick={onClose} disabled={busy}>✕</Btn>
        </div>
        <div className="hr-preview-body ops-pane-body">{children}</div>
        {footer ? <div className="hr-preview-foot ops-pane-foot">{footer}</div> : null}
      </aside>
    </>
  );
}

/**
 * A counted noun with Arabic number agreement (G-10): «بند واحد / بندان / 3 بنود / 11 بندًا».
 * `forms` = [one, two, few (3–10), many (11+), english singular, english plural].
 */
export function countNoun(n: number, lang: "ar" | "en", forms: [string, string, string, string, string, string]): string {
  if (lang === "en") return `${n} ${n === 1 ? forms[4] : forms[5]}`;
  if (n === 0) return `0 ${forms[2]}`; // N-2: «0 أكواب», never the accusative
  if (n === 1) return forms[0];
  if (n === 2) return forms[1];
  const r = n % 100;
  if (r >= 3 && r <= 10) return `${n} ${forms[2]}`;
  // 100, 101, 102, 200…: the singular genitive («100 كوب»), not the accusative «كوبًا».
  if (r <= 2) return `${n} ${forms[3].replace(/ًا$|ً$/, "")}`;
  return `${n} ${forms[3]}`;
}
export const ITEM_FORMS: [string, string, string, string, string, string] = ["بند واحد", "بندان", "بنود", "بندًا", "item", "items"];
export const ORDER_FORMS: [string, string, string, string, string, string] = ["طلب واحد", "طلبان", "طلبات", "طلبًا", "order", "orders"];
export const UNIT_FORMS: [string, string, string, string, string, string] = ["وحدة واحدة", "وحدتان", "وحدات", "وحدة", "unit", "units"];
export const CUP_FORMS: [string, string, string, string, string, string] = ["كوب واحد", "كوبان", "أكواب", "كوبًا", "cup", "cups"];
export const BATCH_FORMS: [string, string, string, string, string, string] = ["دفعة واحدة", "دفعتان", "دفعات", "دفعة", "batch", "batches"];
export const SCORE_FORMS: [string, string, string, string, string, string] = ["تقييم واحد", "تقييمان", "تقييمات", "تقييمًا", "score", "scores"];
export const SCORER_FORMS: [string, string, string, string, string, string] = ["مقيّم واحد", "مقيّمان", "مقيّمين", "مقيّمًا", "scorer", "scorers"];
export const GUEST_FORMS: [string, string, string, string, string, string] = ["ضيف واحد", "ضيفان", "ضيوف", "ضيفًا", "guest", "guests"];

/**
 * «n من m مقيّمين» / "n of m scorers" (E6 close dialog). The noun agrees with m, the counted
 * total, after «من» (genitive): 2 → «مقيّمَين», 3–10 → «مقيّمين», 11–20 → «مقيّمًا».
 * m is the close minimum, 2–20.
 */
export function scorersOf(n: number, m: number, lang: "ar" | "en"): string {
  return nOfM(n, m, lang, ["مقيّم", "مقيّمَين", "مقيّمين", "مقيّمًا", "scorer", "scorers"]);
}
/** «3 من 4 أكواب» / "3 of 4 cups": a scorer's progress through the session's cups (owner decision 3). */
export function cupsOf(n: number, m: number, lang: "ar" | "en"): string {
  return nOfM(n, m, lang, ["كوب", "كوبَين", "أكواب", "كوبًا", "cup", "cups"]);
}
/** «n من m X»: forms = [genitive singular, genitive dual, 3–10 plural, 11+ accusative, en singular, en plural]. */
function nOfM(n: number, m: number, lang: "ar" | "en", f: [string, string, string, string, string, string]): string {
  if (lang === "en") return `${n} of ${m} ${m === 1 ? f[4] : f[5]}`;
  const r = m % 100;
  const noun = m === 1 ? f[0] : m === 2 ? f[1] : r >= 3 && r <= 10 ? f[2] : r <= 2 ? f[0] : f[3];
  return `${n} من ${m} ${noun}`;
}
