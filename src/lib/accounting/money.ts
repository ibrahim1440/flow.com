// Accounting core A1 — THE money rule, defined once (council invariant 3).
//
// Money is numeric(18,2) in the database and Decimal here, never a JS number. Every amount that reaches the
// ledger goes through roundMoney: HALF-UP to 2 decimal places (0.005 → 0.01, -0.005 → -0.01: half away from
// zero, which is what PostgreSQL's numeric rounding does too). Pure: no database, safe in unit tests and in
// client components.
import { Decimal } from "@prisma/client/runtime/client";

export { Decimal };

/** What a caller may hand the engine as an amount: a decimal string ("1250.50"), a Decimal, or an integer. */
export type MoneyInput = string | Decimal | number | bigint;

export const ZERO = new Decimal(0);
const MAX = new Decimal("9999999999999999.99"); // numeric(18,2)
const STRICT = /^-?\d{1,16}(\.\d+)?$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Parse an amount EXACTLY (no rounding). Strings must be plain decimals (no thousands separators, no
 * exponent); a JS number is accepted only when it is a safe integer — a float such as 0.1 is refused, because
 * it is already wrong before it arrives.
 */
export function toDecimal(v: MoneyInput): Decimal {
  if (v instanceof Decimal) return v;
  if (typeof v === "bigint") return new Decimal(v.toString());
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new MoneyError(`An amount given as a JS number must be a whole number (got ${v}); pass a decimal string.`);
    return new Decimal(v);
  }
  if (typeof v !== "string") throw new MoneyError("An amount is a decimal string.");
  const t = v.trim();
  if (!STRICT.test(t)) throw new MoneyError(`Not a decimal amount: "${v}".`);
  return new Decimal(t);
}

/** Round half-up to 2 decimal places — the ONE rounding rule of the ledger. */
export function roundMoney(v: MoneyInput): Decimal {
  const d = toDecimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (d.abs().greaterThan(MAX)) throw new MoneyError("The amount exceeds numeric(18,2).");
  return d;
}

/** Already a 2-decimal amount (nothing would be lost by storing it)? */
export function isMoneyExact(v: MoneyInput): boolean {
  const d = toDecimal(v);
  return d.equals(d.toDecimalPlaces(2));
}

export function sumMoney(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((s, v) => s.plus(toDecimal(v)), ZERO);
}

/** A Decimal as 2-decimal text, never "-0.00". */
export function fix2(d: Decimal): string {
  return d.isZero() ? "0.00" : d.toFixed(2);
}

/** "1234.50" — the canonical text of an amount (2 decimals, no grouping). */
export function moneyText(v: MoneyInput): string {
  return roundMoney(v).toFixed(2);
}

/**
 * VAT inside a VAT-inclusive (gross) amount: gross × rate / (100 + rate), rounded once (A2 uses it per line).
 * rate is a percentage ("15").
 */
export function vatFromGross(gross: MoneyInput, ratePct: MoneyInput): Decimal {
  const r = toDecimal(ratePct);
  return roundMoney(toDecimal(gross).times(r).dividedBy(r.plus(100)));
}

/** VAT on a net amount: net × rate / 100, rounded once. */
export function vatOnNet(net: MoneyInput, ratePct: MoneyInput): Decimal {
  return roundMoney(toDecimal(net).times(toDecimal(ratePct)).dividedBy(100));
}

/**
 * Split `total` across `weights` so the parts are 2-decimal amounts that sum EXACTLY to the rounded total
 * (largest-remainder; ties to the earliest). For discounts and allocations in later phases.
 */
export function allocateMoney(total: MoneyInput, weights: MoneyInput[]): Decimal[] {
  const t = roundMoney(total);
  if (weights.length === 0) return [];
  if (t.isNegative()) return allocateMoney(t.negated(), weights).map((x) => x.negated());
  const w = weights.map(toDecimal);
  const sw = w.reduce((s, x) => s.plus(x), ZERO);
  if (sw.isZero()) throw new MoneyError("Allocation weights sum to zero.");
  const cents = t.times(100);
  const raw = w.map((x) => cents.times(x).dividedBy(sw));
  const floor = raw.map((x) => x.toDecimalPlaces(0, Decimal.ROUND_FLOOR));
  let left = cents.minus(floor.reduce((s, x) => s.plus(x), ZERO)).toNumber();
  const order = raw.map((x, i) => ({ i, rem: x.minus(floor[i]) })).sort((a, b) => b.rem.comparedTo(a.rem) || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    floor[o.i] = floor[o.i].plus(1);
    left -= 1;
  }
  return floor.map((c) => c.dividedBy(100));
}
