// Variance and forecast arithmetic for the monthly cash budget. Pure and integer-only.
//
//   variance            = actual − planned (same basis, same period)
//   variance %          = variance ÷ |planned| × 100, only when planned ≠ 0
//   planned 0, actual ≠0 → "UNBUDGETED" (no percentage, never ∞)
//   both 0              → "NO_ACTIVITY" (no percentage, no error)
//   forecast at completion (FAC) = actual to date + remaining forecast not in actuals
//   remaining forecast  = open commitments + additional forecast items not linked to them
//
// Direction depends on the line: more money OUT than planned is an overrun; less money IN
// than planned is a shortfall. Less money out than planned is "below budget" — not
// "savings", because it may just be a payment that has not happened yet.

import type { Minor } from "./money";

export type LineKind = "RECEIPT" | "PAYMENT";

export type VarianceState =
  | "UNBUDGETED"
  | "NO_ACTIVITY"
  | "ON_PLAN"
  | "OVERRUN"
  | "BELOW_BUDGET"
  | "SHORTFALL"
  | "ABOVE_PLAN";

export type Variance = {
  planned: Minor;
  actual: Minor;
  variance: Minor;
  /** Signed percent ×100 (−20.00% = −2000), null when undefined. */
  percentBp: number | null;
  state: VarianceState;
  /** True when the direction is unfavourable (overrun / shortfall / unbudgeted spend). */
  adverse: boolean;
};

/** Signed percentage in hundredths of a percent, rounded half away from zero. */
export function percentBp(variance: Minor, planned: Minor): number | null {
  if (planned === 0) return null;
  const num = BigInt(variance) * BigInt(10_000);
  const den = BigInt(Math.abs(planned));
  const q = num / den;
  const r = num % den;
  const twice = (r < BigInt(0) ? -r : r) * BigInt(2);
  const adj = twice >= den ? (num < BigInt(0) ? -BigInt(1) : BigInt(1)) : BigInt(0);
  return Number(q + adj);
}

export function computeVariance(kind: LineKind, planned: Minor, actual: Minor): Variance {
  const variance = actual - planned;
  if (planned === 0 && actual === 0) {
    return { planned, actual, variance: 0, percentBp: null, state: "NO_ACTIVITY", adverse: false };
  }
  if (planned === 0) {
    return { planned, actual, variance, percentBp: null, state: "UNBUDGETED", adverse: kind === "PAYMENT" };
  }
  const pct = percentBp(variance, planned);
  let state: VarianceState = "ON_PLAN";
  if (variance > 0) state = kind === "PAYMENT" ? "OVERRUN" : "ABOVE_PLAN";
  if (variance < 0) state = kind === "PAYMENT" ? "BELOW_BUDGET" : "SHORTFALL";
  return { planned, actual, variance, percentBp: pct, state, adverse: state === "OVERRUN" || state === "SHORTFALL" };
}

/** Aggregate from amounts — never from summing or averaging the line percentages. */
export function aggregateVariance(kind: LineKind, rows: { planned: Minor; actual: Minor }[]): Variance {
  const planned = rows.reduce((a, r) => a + r.planned, 0);
  const actual = rows.reduce((a, r) => a + r.actual, 0);
  return computeVariance(kind, planned, actual);
}

export type AlertThresholds = { amount: Minor; percentBp: number; mode: "EITHER" | "BOTH" };

export function crossesThreshold(v: Variance, t: AlertThresholds): boolean {
  if (!v.adverse) return false;
  const amountHit = Math.abs(v.variance) >= t.amount;
  // Unbudgeted spend has no percentage: judge it on amount alone.
  if (v.percentBp === null) return amountHit;
  const pctHit = Math.abs(v.percentBp) >= t.percentBp;
  return t.mode === "BOTH" ? amountHit && pctHit : amountHit || pctHit;
}

export type ForecastRow = {
  actualToDate: Minor;
  openCommitments: Minor;
  additionalForecast: Minor;
};

export function forecastAtCompletion(r: ForecastRow): { remainingForecast: Minor; fac: Minor } {
  const remainingForecast = r.openCommitments + r.additionalForecast;
  return { remainingForecast, fac: r.actualToDate + remainingForecast };
}

export function formatPercentBp(bp: number | null, lang: "ar" | "en" = "en"): string {
  if (bp === null) return "—";
  const v = (bp / 100).toFixed(2);
  const s = bp > 0 ? `+${v}%` : `${v}%`;
  return lang === "ar" ? s.replace("-", "−") : s.replace("-", "−");
}
