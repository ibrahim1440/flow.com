/**
 * The Layout Engine. Millimetres are canonical; the browser receives `@page { size: W mm H mm;
 * margin: 0 }` and each label as an absolutely positioned W × H mm box at (x, y) mm on a page box
 * of exactly the paper size.
 *
 *  • A sheet holds columns × rows labels (capacity from the profile).
 *  • Slots fill row by row from the PHYSICAL top-left of the sheet in every UI language (B-3).
 *  • The start slot (sheets only) leaves the leading slots of page 1 empty, for a partly used sheet.
 *  • A roll is one label per page: the page IS the label.
 *  • Copies of one item are consecutive; totals of labels and pages are reported and capped (B-4).
 *  • Scale (calibration) multiplies the grid around the page origin; offsets then shift it.
 */
import { capacity, gridExtent, orientedPaper, usesStartSlot, FIT_TOLERANCE_MM, type ProfileGeometry, type ProfileInput } from "./profiles";
import { cssMm, round3 } from "./units";

/**
 * Hard engine ceilings. The per-job label cap actually applied is the administrator setting
 * (PrintSettings.maxLabelsPerJob, default 200 — orchestrator decision), 1…JOB_LIMITS.labels.
 */
export const JOB_LIMITS = {
  copiesPerItem: 100,
  items: 500,
  labels: 2000,
  pages: 250,
} as const;
export const DEFAULT_MAX_LABELS_PER_JOB = 200;

export type LayoutProfile = ProfileGeometry & Pick<ProfileInput, "kind">;
export type JobItem<R = string> = { ref: R; copies: number };

export type SlotBox = { slot: number; row: number; col: number; xMm: number; yMm: number; wMm: number; hMm: number };
export type PlacedSlot<R = string> = SlotBox & { ref: R | null; copy: number };
export type LayoutPage<R = string> = { index: number; slots: PlacedSlot<R>[] };

export type LayoutError = { code: "COPIES_RANGE" | "START_SLOT_RANGE" | "NO_ITEMS" | "TOO_MANY_ITEMS" | "TOO_MANY_LABELS" | "TOO_MANY_PAGES"; detail?: Record<string, number> };

/** The physical page as fed to the printer. */
export function pageSize(p: LayoutProfile) {
  return orientedPaper(p);
}

/** `@page` rule for the job. Margin 0: positions are absolute from the paper edge. */
export function pageCss(p: LayoutProfile): string {
  const { w, h } = pageSize(p);
  return `@page { size: ${cssMm(w)} ${cssMm(h)}; margin: 0; }`;
}

/** Labels per page: the grid capacity; 1 on a roll whatever the grid says. */
export function perPage(p: LayoutProfile): number {
  return p.kind === "THERMAL_ROLL" ? 1 : capacity(p);
}

/** Geometry of slot `i` (0-based), after scale and calibration offsets. */
export function slotBox(p: LayoutProfile, i: number): SlotBox {
  const cols = p.kind === "THERMAL_ROLL" ? 1 : p.columns;
  const row = Math.floor(i / cols);
  const col = i % cols;
  const s = p.scalePct / 100;
  return {
    slot: i + 1,
    row,
    col,
    xMm: round3((p.marginLeftMm + col * (p.labelWidthMm + p.gapXMm)) * s + p.offsetXMm),
    yMm: round3((p.marginTopMm + row * (p.labelHeightMm + p.gapYMm)) * s + p.offsetYMm),
    wMm: round3(p.labelWidthMm * s),
    hMm: round3(p.labelHeightMm * s),
  };
}

/** Every slot of one sheet, in fill order. */
export function sheetSlots(p: LayoutProfile): SlotBox[] {
  return Array.from({ length: perPage(p) }, (_, i) => slotBox(p, i));
}

export function totalLabels(items: JobItem<unknown>[]): number {
  return items.reduce((a, it) => a + it.copies, 0);
}

/** Totals without building pages (what the server re-computes before it audits a job). */
export function jobTotals(p: LayoutProfile, items: JobItem<unknown>[], startSlot = 1) {
  const labels = totalLabels(items);
  const cap = perPage(p);
  const lead = usesStartSlot(p) ? startSlot - 1 : 0;
  const pages = labels === 0 ? 0 : Math.ceil((lead + labels) / cap);
  return { labels, pages, perPage: cap, emptyLeading: lead, emptyTrailing: pages * cap - lead - labels };
}

/** Validates copies, start slot and the job caps. Empty array = acceptable. */
export function validateJob(p: LayoutProfile, items: JobItem<unknown>[], startSlot = 1, maxLabels: number = JOB_LIMITS.labels): LayoutError[] {
  const errors: LayoutError[] = [];
  if (items.length === 0) errors.push({ code: "NO_ITEMS" });
  if (items.length > JOB_LIMITS.items) errors.push({ code: "TOO_MANY_ITEMS", detail: { max: JOB_LIMITS.items, got: items.length } });
  if (items.some((it) => !Number.isInteger(it.copies) || it.copies < 1 || it.copies > JOB_LIMITS.copiesPerItem)) {
    errors.push({ code: "COPIES_RANGE", detail: { min: 1, max: JOB_LIMITS.copiesPerItem } });
  }
  const perSheet = perPage(p);
  if (!Number.isInteger(startSlot) || startSlot < 1 || startSlot > (usesStartSlot(p) ? perSheet : 1)) {
    errors.push({ code: "START_SLOT_RANGE", detail: { min: 1, max: usesStartSlot(p) ? perSheet : 1 } });
  }
  if (errors.length) return errors;
  const t = jobTotals(p, items, startSlot);
  const cap = Math.min(maxLabels, JOB_LIMITS.labels);
  if (t.labels > cap) errors.push({ code: "TOO_MANY_LABELS", detail: { max: cap, got: t.labels, pages: t.pages } });
  if (t.pages > JOB_LIMITS.pages) errors.push({ code: "TOO_MANY_PAGES", detail: { max: JOB_LIMITS.pages, got: t.pages, labels: t.labels } });
  return errors;
}

/**
 * Lays the job out: every page with all its slots (empty ones carry ref null, so the preview can
 * draw «empty» before the start slot and after the last label). Throws on an invalid job — call
 * validateJob first where the input is untrusted.
 */
export function paginate<R>(p: LayoutProfile, items: JobItem<R>[], startSlot = 1): LayoutPage<R>[] {
  const errors = validateJob(p, items, startSlot);
  if (errors.length) throw new Error(`Invalid print job: ${errors.map((e) => e.code).join(", ")}`);
  const seq: { ref: R; copy: number }[] = [];
  for (const it of items) for (let c = 1; c <= it.copies; c++) seq.push({ ref: it.ref, copy: c });
  const t = jobTotals(p, items, startSlot);
  const boxes = sheetSlots(p);
  const pages: LayoutPage<R>[] = [];
  for (let pg = 0; pg < t.pages; pg++) {
    pages.push({
      index: pg,
      slots: boxes.map((b, i) => {
        const k = pg * t.perPage + i - t.emptyLeading;
        const hit = k >= 0 && k < seq.length ? seq[k] : null;
        return { ...b, ref: hit ? hit.ref : null, copy: hit ? hit.copy : 0 };
      }),
    });
  }
  return pages;
}

/** Profile-level layout warnings (scale/offset pushing labels off the paper). */
export function layoutWarnings(p: LayoutProfile): string[] {
  const out: string[] = [];
  const paper = pageSize(p);
  const ext = gridExtent(p);
  const s = p.scalePct / 100;
  const right = ext.w * s + p.offsetXMm;
  const bottom = ext.h * s + p.offsetYMm;
  if (right > paper.w + FIT_TOLERANCE_MM || bottom > paper.h + FIT_TOLERANCE_MM) out.push("GRID_OFF_PAPER");
  if (p.marginLeftMm * s + p.offsetXMm < -FIT_TOLERANCE_MM || p.marginTopMm * s + p.offsetYMm < -FIT_TOLERANCE_MM) out.push("GRID_OFF_PAPER");
  if (p.scalePct !== 100) out.push("SCALE_NOT_100");
  return [...new Set(out)];
}
