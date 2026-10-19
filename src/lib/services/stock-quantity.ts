// Pure (no database import): strict stock-quantity parsing, shared by the receiving routes and tests.
/** Units counted in whole items: a fractional quantity of these is refused. */
export const DISCRETE_UNITS = ["PIECE", "UNIT"] as const;
const DECIMAL = /^\d+(\.\d{1,4})?$/;
export const MAX_STOCK_QUANTITY = 1_000_000;

/**
 * Strict stock-quantity parsing for receipts and opening balances (re-review P3-B). Accepts a JSON
 * number or a plain decimal string (`^\d+(\.\d{1,4})?$`); refuses booleans, arrays, hex,
 * exponents, NaN / Infinity, negatives, more than 4 decimal places (so the movement and the balance
 * always agree), values above 1,000,000, and fractions of a discrete unit (PIECE, UNIT).
 */
export function parseStockQuantity(v: unknown, opts: { allowZero: boolean; unitOfMeasure?: string }): { ok: true; value: number } | { ok: false; message: string } {
  let text: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { ok: false, message: "must be a finite number" };
    text = String(v);
  } else if (typeof v === "string") {
    text = v.trim();
  } else {
    return { ok: false, message: "must be a number" };
  }
  if (!DECIMAL.test(text)) return { ok: false, message: "must be a plain decimal number with at most 4 decimal places" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, message: "must be a finite number" };
  if (opts.allowZero ? value < 0 : value <= 0) return { ok: false, message: opts.allowZero ? "must be zero or more" : "must be greater than zero" };
  if (value > MAX_STOCK_QUANTITY) return { ok: false, message: `must not exceed ${MAX_STOCK_QUANTITY.toLocaleString("en")}` };
  if (opts.unitOfMeasure && (DISCRETE_UNITS as readonly string[]).includes(opts.unitOfMeasure) && !Number.isInteger(value)) return { ok: false, message: `must be a whole number for a material counted in ${opts.unitOfMeasure.toLowerCase()}s` };
  return { ok: true, value };
}

/** Below this, a count equals the system balance and nothing is booked (1 g / 0.001 unit). */
export const ADJUSTMENT_NOOP_THRESHOLD = 0.001;
