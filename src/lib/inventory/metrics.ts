/**
 * Inventory metrics — pure formulas over the ledger (no database), unit-tested in
 * tests/ops/unit/inventory-metrics.test.ts. Every figure here is DERIVED from recorded
 * InventoryMovement rows, lot / material balances and bills of materials; nothing is estimated
 * or stored. Where the history cannot support a figure the result is `null` and the screen shows
 * «—» (never a guess, never a zero that would read as "no consumption").
 *
 * The figures (Figma 216:2 — 251:2482 green coffee, 253:2987 packaging, 266:5230 finished stock):
 *
 *   ROAST RATE (kg/day, per bean and overall), window W = 14 days:
 *     consumed = −Σ quantityChanged of RAW_MATERIAL movements with sourceDocType ROASTING_BATCH
 *                and timestamp in (now − W, now]
 *       (a roast's draw is an OUT with a negative quantityChanged; the restock of a cancelled roast
 *        is an IN with the same source and nets it back — a cancelled roast consumed nothing)
 *     rate = consumed / W
 *     INSUFFICIENT (null) when the item's history starts inside the window — its first lot was
 *     received, or its first ledger movement was written, less than W days ago — because dividing
 *     a few days of roasting by 14 would understate the rate.
 *
 *   COVERAGE (days of stock) = balance / rate
 *     null when the rate is null; "no consumption" (Infinity) when the rate is 0; otherwise the
 *     number of whole days (floored) the current balance lasts at the 14-day rate.
 *
 *   PACKAGING USAGE (per material, pieces), window 7 days:
 *     used = −Σ quantityChanged of PACKAGING_MATERIAL movements with sourceDocType BOM_CONSUMPTION
 *            in (now − 7d, now]  (a reversed draw nets back). Same INSUFFICIENT rule.
 *     material coverage (days) = onHand / (used / 7).
 *
 *   PACKS COVERABLE (per SKU) = min over the SKU's MATERIAL BOM lines of
 *     floor(material onHand / quantityPerUnit); the material that attains the minimum is the limit.
 *     null for a SKU with no material line (nothing in packaging stock limits it).
 */

export const ROAST_WINDOW_DAYS = 14;
export const PACK_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

export type MovementLike = {
  type: string;
  category: string;
  sourceDocType: string;
  referenceEntityId: string | null;
  quantityChanged: number;
  timestamp: Date | string;
};

const t = (d: Date | string) => (d instanceof Date ? d.getTime() : Date.parse(d));
const fin = (n: number) => (Number.isFinite(n) ? n : 0);
const round = (n: number, d = 4) => Number(n.toFixed(d));

/** Is a movement inside the window (now − days, now]? */
export function inWindow(ts: Date | string, now: Date, days: number): boolean {
  const x = t(ts);
  return x > now.getTime() - days * DAY_MS && x <= now.getTime();
}

/**
 * Net quantity drawn by a source within the window: −Σ quantityChanged of the matching movements
 * (positive = consumed). `ids` limits it to some entities (a bean's lots); omit for all.
 */
export function netDrawn(
  movements: MovementLike[],
  opts: { category: string; source: string; now: Date; days: number; ids?: ReadonlySet<string> },
): number {
  let sum = 0;
  for (const m of movements) {
    if (m.category !== opts.category || m.sourceDocType !== opts.source) continue;
    if (opts.ids && (!m.referenceEntityId || !opts.ids.has(m.referenceEntityId))) continue;
    if (!inWindow(m.timestamp, opts.now, opts.days)) continue;
    sum -= fin(m.quantityChanged);
  }
  return round(sum);
}

/** Does the history of an item reach back to the start of the window? */
export function hasFullHistory(historyStart: Date | string | null | undefined, now: Date, days: number): boolean {
  if (!historyStart) return false;
  return t(historyStart) <= now.getTime() - days * DAY_MS;
}

/** Average daily draw over the window, or null when the history is shorter than the window. */
export function dailyRate(drawn: number, historyStart: Date | string | null | undefined, now: Date, days: number): number | null {
  if (!hasFullHistory(historyStart, now, days)) return null;
  return round(Math.max(0, drawn) / days, 4);
}

/**
 * Days of stock at a daily rate: null (insufficient history), Infinity (no consumption in the
 * window — shown «لا استهلاك»), or whole days (floored; a balance of 0 covers 0 days).
 */
export function coverageDays(balance: number, rate: number | null): number | null {
  if (rate === null) return null;
  if (rate <= 0) return Infinity;
  return Math.floor(Math.max(0, fin(balance)) / rate);
}

/**
 * The coverage bar of the green-coffee table: a display scale, not a figure. Full at 6 weeks;
 * danger below 7 days, warning below 14 (two roasting weeks), neutral beyond.
 */
export const COVERAGE_BAR_FULL_DAYS = 42;
export function coverageTone(days: number | null): "danger" | "warning" | undefined {
  if (days === null || days === Infinity) return undefined;
  if (days < 7) return "danger";
  if (days < 14) return "warning";
  return undefined;
}
export function coverageBarPct(days: number | null): number {
  if (days === null) return 0;
  if (days === Infinity) return 0;
  return Math.max(0, Math.min(100, (days / COVERAGE_BAR_FULL_DAYS) * 100));
}

export type BomMaterialLine = { materialItemId: string; quantityPerUnit: number };
export type MaterialStock = { id: string; quantityOnHand: number };

/** Whole sellable units the packaging stock can still pack for one SKU, and what limits it. */
export function packsCoverable(bom: BomMaterialLine[], stock: Map<string, MaterialStock>): { units: number; limitingMaterialId: string } | null {
  let best: { units: number; limitingMaterialId: string } | null = null;
  for (const line of bom) {
    if (!(line.quantityPerUnit > 0)) continue;
    const onHand = Math.max(0, fin(stock.get(line.materialItemId)?.quantityOnHand ?? 0));
    // 1e-9 guards a float quotient like 419.99999 for 420 exactly.
    const units = Math.floor(onHand / line.quantityPerUnit + 1e-9);
    if (!best || units < best.units) best = { units, limitingMaterialId: line.materialItemId };
  }
  return best;
}

/** Group key for green-coffee lots that are the same coffee (the frame groups lots by bean). */
export function beanGroupKey(b: { beanType: string; country?: string | null; process?: string | null }): string {
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(b.beanType)}|${norm(b.country)}|${norm(b.process)}`;
}
