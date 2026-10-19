/**
 * Count sessions — the pure rules (no database), unit-tested in tests/ops/unit/inventory-counts.test.ts.
 *
 * A count session (InventoryCountSession / InventoryCountLine) is a count sheet: lines are added,
 * counted, reviewed, and the session is posted in one approved step. Posting books every
 * non-zero variance through the shared adjustment service, so these rules decide only WHAT is
 * booked; the service decides HOW (row lock, movement, balance, person audit).
 */
import { ADJUSTMENT_NOOP_THRESHOLD } from "@/lib/services/stock-quantity";

export type CountCategory = "RAW_MATERIAL" | "PACKAGING_MATERIAL";
export const COUNT_CATEGORIES: readonly CountCategory[] = ["RAW_MATERIAL", "PACKAGING_MATERIAL"];
export const isCountCategory = (v: unknown): v is CountCategory =>
  typeof v === "string" && (COUNT_CATEGORIES as readonly string[]).includes(v);

/** At most this many items on one count sheet (a full green + packaging count is ~50). */
export const MAX_COUNT_LINES = 300;

export type CountLineLike = { systemQty: number; countedQty: number | null };

const round4 = (n: number) => Number(n.toFixed(4)) + 0; // + 0: never -0

/**
 * The variance a count observed: counted − system balance at the moment of counting
 * (`systemQty` is re-captured each time a counted quantity is entered). Null while uncounted.
 */
export function lineVariance(l: CountLineLike): number | null {
  if (l.countedQty === null || l.countedQty === undefined) return null;
  return round4(l.countedQty - l.systemQty);
}

/** Does this variance book anything? The same 0.001 no-op threshold as a single count. */
export const isBookable = (variance: number | null): variance is number =>
  variance !== null && Math.abs(variance) >= ADJUSTMENT_NOOP_THRESHOLD;

/**
 * The balance a posted line leaves: the observed variance applied to the balance as it stands
 * when the session is posted — `current + (counted − systemAtCount)`.
 *
 * Why not simply `counted`: stock keeps moving while a count is reviewed. If 5 kg of the lot is
 * roasted between counting it (12 kg found, 12.6 kg in the system → −0.6 kg) and posting the
 * session, the balance is 7.6 kg at posting; writing «12» would silently undo the roast. The count
 * proved a −0.6 kg discrepancy, and that is what is booked: 7.6 − 0.6 = 7.0 kg. When nothing moved,
 * `current === systemAtCount` and the result is exactly the counted quantity.
 */
export function postedBalance(current: number, variance: number): number {
  return round4(current + variance);
}

/** Did the balance move between the count and now? (shown on the review as «تغيّر منذ الجرد»). */
export const movedSinceCount = (current: number, systemQty: number) =>
  Math.abs(round4(current - systemQty)) >= ADJUSTMENT_NOOP_THRESHOLD;

export type CountSummary = {
  lines: number;
  counted: number;
  uncounted: number;
  /** Counted lines whose variance books an adjustment. */
  withVariance: number;
  /** Sum of positive / negative variances, per category (units differ between categories). */
  gains: Record<CountCategory, number>;
  losses: Record<CountCategory, number>;
};

export function summarizeCount(lines: (CountLineLike & { category: CountCategory })[]): CountSummary {
  const s: CountSummary = {
    lines: lines.length, counted: 0, uncounted: 0, withVariance: 0,
    gains: { RAW_MATERIAL: 0, PACKAGING_MATERIAL: 0 }, losses: { RAW_MATERIAL: 0, PACKAGING_MATERIAL: 0 },
  };
  for (const l of lines) {
    const v = lineVariance(l);
    if (v === null) { s.uncounted++; continue; }
    s.counted++;
    if (!isBookable(v)) continue;
    s.withVariance++;
    if (v > 0) s.gains[l.category] = round4(s.gains[l.category] + v);
    else s.losses[l.category] = round4(s.losses[l.category] + v);
  }
  return s;
}

/**
 * Can the session be posted? Every line counted (an item not counted is removed from the sheet,
 * not silently skipped — the sheet is the record of what was counted), at least one line, OPEN.
 */
export function postBlocker(status: string, s: CountSummary): string | null {
  if (status !== "OPEN") return "COUNT_NOT_OPEN";
  if (s.lines === 0) return "COUNT_EMPTY";
  if (s.uncounted > 0) return "COUNT_INCOMPLETE";
  return null;
}
