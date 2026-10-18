// Native HR — money. Decimal from the Prisma runtime (not the generated client) so the pure
// payroll engine compiles and tests without a database, exactly like the commission engine.
import { Decimal } from "@prisma/client/runtime/client";

export { Decimal };

type In = string | number | Decimal;

export const D = (v: In) => new Decimal(v);
export const ZERO = D(0);

/** Half-up to 2 decimals (halalas). Every amount stored or shown passes through this. */
export function round2(v: Decimal): Decimal {
  return v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function sum(values: Decimal[]): Decimal {
  return values.reduce((a, b) => a.plus(b), ZERO);
}

/** Parse an amount from user input: a string or number with at most 2 decimals, > 0 unless allowed. */
export function parseAmount(v: unknown, opts: { allowZero?: boolean } = {}): Decimal {
  if (typeof v !== "string" && typeof v !== "number") throw new RangeError("Amount is required.");
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new RangeError("Amount must be a positive number with at most two decimals.");
  const d = D(s);
  if (!opts.allowZero && d.lessThanOrEqualTo(0)) throw new RangeError("Amount must be greater than zero.");
  return d;
}

export const money = (v: Decimal | string | number) => round2(D(v)).toFixed(2);
