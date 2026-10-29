// «الأصول الثابتة» — the depreciation schedule (pure: no database; unit-tested in tests/accounting/unit/fixed-assets.test.ts).
//
// The council's convention (chief accountant, IAS 16.55 / IFRS for SMEs 17.20 — depreciation begins when the asset is
// available for use and ceases when it is derecognised): DAILY PRO-RATA WITHIN THE CALENDAR MONTH. A month counts as
// the share of its days the asset was in service — from the in-service date (inclusive) to the end of the month or the
// disposal date (inclusive). Runs stay monthly; only the first and the last month are partial. Why not «a full month
// from the next month» or a half-month rule: the daily share is exact, needs no policy election to explain to an
// auditor, and gives the disposal its depreciation «up to the disposal date» without a special case. The difference
// from the conventions is immaterial for a café / roastery register.
//
// The schedule is CUMULATIVE: for any day D it says the accumulated depreciation the asset should carry at the end of
// D (`accumulatedTarget`). A run (or a disposal) records target(D) − recorded; rounding (HALF-UP, 2 dp — ../money) is
// applied to the cumulative figure, so the rounding never drifts and the last month lands exactly on cost − residual.
//
//   STRAIGHT_LINE      target(D) = basisAccumulated + (cost − residual − basisAccumulated) × elapsed / remaining,
//                      elapsed / remaining in day-weighted months from the basis date (the in-service date, or the
//                      day an addition took effect) to D / to the end of the useful life.
//   DECLINING_BALANCE  each month the larger of (council F2 — the standard switch to straight line):
//                        • declining: net book value × annual rate ÷ 12 × the month's in-service share;
//                        • straight line on what is left: (net book value − residual) × the month's share ÷ the
//                          day-weighted months left to the end of the useful life (this month included);
//                      rounded per month, never below the residual value. Once the straight-line figure is the larger
//                      one it stays so, and the remaining amount spreads evenly to the end of the life — no spike in
//                      the last month (which, as a guard against cents of rounding, writes down to the residual).
//
// An addition (a capital improvement) starts a new basis on its date: the accumulated depreciation then (whether run or
// not) is the new basisAccumulated, and the new remaining depreciable amount is spread over the remaining life —
// prospectively, as IAS 16 / SME s.17.19 treat a change in estimate.
import { Decimal, ZERO, roundMoney } from "../money";
import { addDaysUtc, dayText } from "../dates";

export type DepreciationMethod = "STRAIGHT_LINE" | "DECLINING_BALANCE";
export const METHODS: DepreciationMethod[] = ["STRAIGHT_LINE", "DECLINING_BALANCE"];

export type Schedule = {
  method: DepreciationMethod;
  /** Annual rate (%) for DECLINING_BALANCE; ignored otherwise. */
  decliningRatePercent: Decimal | null;
  inServiceDate: Date;
  usefulLifeMonths: number;
  cost: Decimal;
  residualValue: Decimal;
  /** The day the current basis starts (the in-service date, or an addition's date / the go-live day of an opening asset). */
  basisDate: Date;
  /** The accumulated depreciation at the start of basisDate. */
  basisAccumulated: Decimal;
};

const D = (v: Decimal | string | number) => new Decimal(v);

export function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Calendar months later, the day clamped to the month's length (31 Jan + 1 → 28 / 29 Feb). */
export function addMonthsUtc(d: Date, n: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const target = new Date(Date.UTC(y, m, 1));
  const day = Math.min(d.getUTCDate(), daysInMonth(target.getUTCFullYear(), target.getUTCMonth()));
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day));
}

export const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
export const periodKeyOf = (d: Date) => dayText(d).slice(0, 7);
const dayCount = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
const minDate = (a: Date, b: Date) => (a <= b ? a : b);
const maxDate = (a: Date, b: Date) => (a >= b ? a : b);

/** The last day of the useful life: the in-service date plus the life in months, less one day. */
export function lifeEnd(s: Pick<Schedule, "inServiceDate" | "usefulLifeMonths">): Date {
  return addDaysUtc(addMonthsUtc(s.inServiceDate, s.usefulLifeMonths), -1);
}

/** Day-weighted months in [from, to] (both inclusive): each calendar month counts its covered days ÷ its days. */
export function monthsBetween(from: Date, to: Date): Decimal {
  if (to < from) return ZERO;
  let total = ZERO;
  for (let m = monthStart(from); m <= to; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const a = maxDate(from, m), b = minDate(to, monthEnd(m));
    total = total.plus(D(dayCount(a, b)).div(daysInMonth(m.getUTCFullYear(), m.getUTCMonth())));
  }
  return total;
}

/** The depreciable amount still ahead of the basis (never negative). */
export function depreciableFromBasis(s: Schedule): Decimal {
  const v = s.cost.minus(s.residualValue).minus(s.basisAccumulated);
  return v.isNegative() ? ZERO : v;
}

/** The accumulated depreciation the asset should carry at the end of `day` (2 dp; never above cost − residual). */
export function accumulatedTarget(s: Schedule, day: Date): Decimal {
  if (day < s.basisDate) return s.basisAccumulated;
  const depreciable = depreciableFromBasis(s);
  if (depreciable.isZero()) return s.basisAccumulated;
  const end = lifeEnd(s);
  const full = s.basisAccumulated.plus(depreciable);
  if (day >= end || s.basisDate > end) return full;
  if (s.method === "DECLINING_BALANCE") return decliningTarget(s, day, end);
  const remaining = monthsBetween(s.basisDate, end);
  if (remaining.isZero()) return full;
  const elapsed = monthsBetween(s.basisDate, day);
  return Decimal.min(full, s.basisAccumulated.plus(roundMoney(depreciable.times(elapsed).div(remaining))));
}

function decliningTarget(s: Schedule, day: Date, end: Date): Decimal {
  const rate = D(s.decliningRatePercent ?? 0).div(100).div(12);
  let acc = s.basisAccumulated;
  const floor = s.cost.minus(s.residualValue);
  const stop = minDate(day, end);
  for (let m = monthStart(s.basisDate); m <= stop; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const a = maxDate(s.basisDate, m), b = minDate(stop, monthEnd(m));
    const left = floor.minus(acc);
    if (!left.gt(0)) break;
    // The last day of the useful life: what is left is written down to the residual value.
    if (b.getTime() === end.getTime()) { acc = floor; break; }
    const nbv = s.cost.minus(acc);
    const share = D(dayCount(a, b)).div(daysInMonth(m.getUTCFullYear(), m.getUTCMonth()));
    const declining = nbv.times(rate).times(share);
    const monthsLeft = monthsBetween(a, end);
    const straight = monthsLeft.gt(0) ? left.times(share).div(monthsLeft) : left;
    acc = acc.plus(Decimal.min(left, roundMoney(Decimal.max(declining, straight))));
  }
  return acc;
}

/** What to record for [recordedThrough + 1, to]: target(to) − recorded (never below zero). */
export function chargeThrough(s: Schedule, recorded: Decimal, to: Date): Decimal {
  const v = accumulatedTarget(s, to).minus(recorded);
  return v.isNegative() ? ZERO : v;
}

/** Fully depreciated: the accumulated depreciation reached cost − residual. */
export const isFullyDepreciated = (cost: Decimal, residual: Decimal, accumulated: Decimal) => !accumulated.lt(cost.minus(residual));

/** The month-by-month projection from `from` (a month) for `months` months: charge, accumulated, net book value. */
export function projection(s: Schedule, recorded: Decimal, recordedThrough: Date | null, from: Date, months: number) {
  const out: { periodKey: string; charge: string; accumulated: string; nbv: string }[] = [];
  let acc = recorded;
  for (let i = 0; i < months; i++) {
    const end = monthEnd(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1)));
    if (recordedThrough && end <= recordedThrough) continue;
    const t = accumulatedTarget(s, end);
    const charge = t.minus(acc).isNegative() ? ZERO : t.minus(acc);
    acc = acc.plus(charge);
    out.push({ periodKey: periodKeyOf(end), charge: charge.toFixed(2), accumulated: acc.toFixed(2), nbv: s.cost.minus(acc).toFixed(2) });
  }
  return out;
}

/** The default declining-balance rate for a life: double the straight-line rate (200 % ÷ years), at most 100 %. */
export function doubleDecliningRate(lifeMonths: number): Decimal {
  return Decimal.min(D(100), D(200).times(12).div(lifeMonths).toDecimalPlaces(4, Decimal.ROUND_HALF_UP));
}
