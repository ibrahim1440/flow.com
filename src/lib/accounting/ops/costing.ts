// Accounting A3 — the COSTING RULE, defined once (council 01: perpetual weighted average; council invariant 3:
// money is Decimal, rounded once, centrally). Pure: no database, safe in unit tests.
//
//   • A holder (green lot, material, roast, finished lot) keeps qty (4 dp) and value (SAR, 2 dp). Its average unit
//     cost is value / qty (kept to 6 dp for display and as the movement's snapshot).
//   • A RECEIPT adds its value (rounded once, HALF-UP to 2 dp) — the average moves.
//   • An ISSUE takes value × (issued qty / qty on hand), rounded once; issuing everything that is left (or more
//     than the books hold) takes the WHOLE remaining value, so rounding never leaves a residue in an empty holder
//     and the sub-ledger equals the sum of the amounts the ledger was given, to the halala.
//   • Roasting: the roasted cost is the green cost; normal loss is absorbed (the roasted kg simply cost more). Only
//     the loss ABOVE the owner's threshold (% of green) is expensed, at the green cost of the lost kilograms.
import { Decimal } from "@prisma/client/runtime/client";
import { roundMoney, toDecimal, ZERO, allocateMoney, type MoneyInput } from "../money";

export { Decimal, ZERO };

/** A quantity as stored: 4 decimals, HALF-UP. JS numbers (the operational kg columns are Float) go through toFixed. */
export function qty4(v: number | string | Decimal): Decimal {
  if (v instanceof Decimal) return v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("A quantity must be finite.");
    return new Decimal(v.toFixed(6)).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  }
  return new Decimal(v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/** value / qty to 6 dp (0 for an empty holder). */
export function unitCost(value: MoneyInput | Decimal, qty: Decimal): Decimal {
  if (qty.lte(0)) return ZERO;
  return toDecimal(value as MoneyInput).dividedBy(qty).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

export type Holder = { qty: Decimal; value: Decimal };
export type Applied = { qty: Decimal; value: Decimal; unitCost: Decimal; after: Holder & { avgCost: Decimal } };

/** A receipt of `q` at a total value `v` (≥ 0). */
export function receive(h: Holder, q: Decimal, v: MoneyInput | Decimal): Applied {
  if (q.isNegative()) throw new RangeError("A receipt quantity is not negative.");
  const val = roundMoney(v as MoneyInput);
  if (val.isNegative()) throw new RangeError("A receipt value is not negative.");
  const qty = h.qty.plus(q);
  // A value with nothing to hold it (a zero-quantity receipt into an empty holder) is not a receipt: refuse.
  if (qty.lte(0) && !val.isZero()) throw new RangeError("A value cannot be received into an empty holder without a quantity.");
  const value = h.value.plus(val);
  return { qty: q, value: val, unitCost: q.gt(0) ? unitCost(val, q) : ZERO, after: { qty, value, avgCost: unitCost(value, qty) } };
}

/**
 * An issue of `q` (> 0) at the moving average. `closeOut`: the operational holder is now empty (a lot shipped in
 * full, a roast fully packed) — take everything the books hold, whatever the residue of quantity rounding.
 */
export function issue(h: Holder, q: Decimal, opts: { closeOut?: boolean } = {}): Applied {
  if (q.isNegative()) throw new RangeError("An issue quantity is not negative.");
  const all = opts.closeOut || q.gte(h.qty);
  const value = all ? h.value : h.qty.isZero() ? ZERO : roundMoney(h.value.times(q).dividedBy(h.qty));
  const outQty = all ? (opts.closeOut ? h.qty : Decimal.min(q, h.qty)) : q;
  const afterQty = h.qty.minus(outQty);
  const afterValue = h.value.minus(value);
  return { qty: outQty, value, unitCost: unitCost(h.value, h.qty), after: { qty: afterQty, value: afterValue, avgCost: unitCost(afterValue, afterQty) } };
}

/**
 * A value change without a quantity change (a price variance on an invoice, a revaluation). A holder holding stock
 * absorbs it, down to zero at most; the rest (or all of it, when the holder is empty) is returned as `rest` —
 * the caller expenses it (INVENTORY_VARIANCE).
 */
export function revalue(h: Holder, delta: MoneyInput | Decimal): { absorbed: Decimal; rest: Decimal; after: Holder & { avgCost: Decimal } } {
  const d = roundMoney(delta as MoneyInput);
  if (h.qty.lte(0)) return { absorbed: ZERO, rest: d, after: { ...h, avgCost: ZERO } };
  const absorbed = d.isNegative() ? Decimal.max(d, h.value.negated()) : d;
  const value = h.value.plus(absorbed);
  return { absorbed, rest: d.minus(absorbed), after: { qty: h.qty, value, avgCost: unitCost(value, h.qty) } };
}

/** The part of a price variance that follows the stock still on hand (received q, on hand now). */
export function varianceOnHand(variance: MoneyInput | Decimal, received: Decimal, onHand: Decimal): Decimal {
  const v = roundMoney(variance as MoneyInput);
  if (received.lte(0) || onHand.lte(0)) return ZERO;
  if (onHand.gte(received)) return v;
  return roundMoney(v.times(onHand).dividedBy(received));
}

export type RoastCost = {
  greenKg: Decimal;
  roastedKg: Decimal;
  lossKg: Decimal;
  lossPct: Decimal;
  normalLossKg: Decimal;
  abnormalLossKg: Decimal;
  greenCost: Decimal;
  /** Debited to roasted stock: green cost − abnormal loss. */
  roastedCost: Decimal;
  /** Debited to ROAST_LOSS. */
  abnormalCost: Decimal;
  roastedUnitCost: Decimal;
};

/**
 * A roast's cost (council 01: roasted cost/kg = green cost ÷ roasted kg; the loss is absorbed unless abnormal).
 * thresholdPct = null: every loss is normal. A roast with no roasted output expenses its whole green cost.
 */
export function roastCost(greenKg: Decimal, roastedKg: Decimal, greenCost: MoneyInput | Decimal, thresholdPct: Decimal | null): RoastCost {
  const g = roundMoney(greenCost as MoneyInput);
  const lossKg = Decimal.max(greenKg.minus(roastedKg), ZERO);
  const lossPct = greenKg.gt(0) ? lossKg.times(100).dividedBy(greenKg).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : ZERO;
  let normalLossKg = lossKg, abnormalLossKg = ZERO, abnormalCost = ZERO;
  if (roastedKg.lte(0)) {
    normalLossKg = ZERO; abnormalLossKg = lossKg; abnormalCost = g;
  } else if (thresholdPct !== null && greenKg.gt(0)) {
    const allowed = greenKg.times(thresholdPct).dividedBy(100);
    if (lossKg.gt(allowed)) {
      normalLossKg = allowed.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      abnormalLossKg = lossKg.minus(normalLossKg);
      abnormalCost = roundMoney(g.times(abnormalLossKg).dividedBy(greenKg));
    }
  }
  const roastedCost = g.minus(abnormalCost);
  return { greenKg, roastedKg, lossKg, lossPct, normalLossKg, abnormalLossKg, greenCost: g, roastedCost, abnormalCost, roastedUnitCost: unitCost(roastedCost, roastedKg) };
}

/** Split an amount across weights so the parts sum exactly (largest remainder) — re-exported for the events. */
export function split(total: Decimal, weights: Decimal[]): Decimal[] {
  if (!weights.length) return [];
  if (weights.every((w) => w.isZero())) return allocateMoney(total.toFixed(2), weights.map(() => "1"));
  return allocateMoney(total.toFixed(2), weights.map((w) => w.toFixed(6)));
}

// ─── AP math ─────────────────────────────────────────────────────────────────────────────────────

/** VAT on a net line (rate %, rounded once per LINE — never on the header). */
export function lineVat(net: Decimal, ratePct: Decimal): Decimal {
  return roundMoney(net.times(ratePct).dividedBy(100));
}

export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** The aging bucket of an open item on `asOf` (both business days): days past the due date. */
export function agingBucket(dueDate: Date, asOf: Date): AgingBucket {
  const days = Math.floor((asOf.getTime() - dueDate.getTime()) / 86_400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}
