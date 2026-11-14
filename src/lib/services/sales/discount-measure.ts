// HOTFIX quote-45 (owner report, 13 Nov 2026 — Q-202611-0022): a line at EXACTLY the approval limit (45.00 %) was
// treated as «فوق الحدّ» by the quotation editor, which compared an unrounded floating-point figure over the whole
// quotation (45.00006 % on 50 × 177.39 at 45 %, the discount rounding up by a halala) while the server measured each line
// against its list price rounded to 2 dp (45.00 %, not above the limit). The rep was left with a disabled «حفظ وإصدار».
//
// ONE measure for the browser and the server, in FIXED POINT — no floating point anywhere:
//   · amounts and percents are parsed as decimal strings into integers (half-up at their scale);
//   · a line is priced exactly as priceLine prices it (gross = qty × price → 2 dp; discount = gross × % → 2 dp; net);
//   · the effective discount of a line is 1 − net ÷ list, in BASIS POINTS (2-dp percent × 100), half-up, never below 0;
//   · «above the limit» is strictly greater, in basis points: 45.00 % at a 45 % limit is NOT above it; 45.01 % is.
// Pure, dependency-free and client-safe (no Decimal, no node:crypto).
import { DISCOUNT_MAX } from "./discount-limits";

type Num = string | number | { toString(): string };

/** A decimal value as an integer at `dp` places, rounded half-up (away from zero) beyond them. Non-numbers → BigInt(0). */
export function scaled(v: Num, dp: number): bigint {
  let s = String(typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(Math.max(dp + 2, 10)) : "0") : v ?? "0").trim();
  if (!/^[-+]?\d*\.?\d*$/.test(s) || s === "" || s === "." || s === "-" || s === "+") return BigInt(0);
  const neg = s.startsWith("-");
  s = s.replace(/^[-+]/, "");
  const [ip = "0", fp = ""] = s.split(".");
  const kept = (fp + "0".repeat(dp + 1)).slice(0, dp + 1); // dp digits + one to round on
  let n = BigInt((ip || "0") + kept.slice(0, dp));
  if (Number(kept[dp]) >= 5) n += BigInt(1);
  return neg ? -n : n;
}

/** Half-up integer division of non-negative a by positive b. */
const divHalfUp = (a: bigint, b: bigint) => (BigInt(2) * a + b) / (BigInt(2) * b);

/** A percent (e.g. "45", "45.004") as basis points of its 2-dp value: 45 → 4500, 45.005 → 4501. */
export const percentToBp = (p: Num): number => Number(scaled(p, 2));

/** The basis points as a 2-dp percent string: 4500 → "45.00". */
export const bpToPercent = (bp: number): string => `${Math.trunc(bp / 100)}.${String(Math.abs(bp % 100)).padStart(2, "0")}`;

/**
 * A line's amount after its own discount, before VAT, in halalas — exactly priceLine's rounding (each step to 2 dp,
 * half-up). quantity ≤ 3 dp, unit price and percent ≤ 2 dp (the columns' scales).
 */
export function lineNetHalalas(quantity: Num, unitPrice: Num, discountPercent: Num): bigint {
  const q = scaled(quantity, 3), p = scaled(unitPrice, 2), d = scaled(discountPercent, 2);
  const grossH = divHalfUp(q * p, BigInt(1000));                 // 5 dp → 2 dp
  const discH = divHalfUp(grossH * d, BigInt(10000));            // gross × % ÷ 100, 2 dp
  return grossH - discH;
}

/**
 * The effective discount below the list, in basis points: 1 − net ÷ list, half-up at 2-dp percent, never below 0.
 * `listValue` is the list price × quantity (any scale ≤ 5 dp); `lineNet` the line's net (≤ 5 dp). null with no list.
 */
export function effectiveDiscountBp(listValue: Num, lineNet: Num): number | null {
  const L = scaled(listValue, 5), N = scaled(lineNet, 5);
  if (L <= BigInt(0)) return null;
  if (N >= L) return 0;
  return Number(divHalfUp((L - N) * BigInt(10000), L));
}

/** The list value of a line (price × quantity) rounded to 2 dp, half-up — as the direct-sale terms round it. */
export function listValue2dp(price: Num, quantity: Num): string {
  const h = divHalfUp(scaled(price, 2) * scaled(quantity, 3), BigInt(1000));
  const neg = h < BigInt(0), a = neg ? -h : h;
  return `${neg ? "-" : ""}${a / BigInt(100)}.${String(a % BigInt(100)).padStart(2, "0")}`;
}

/** Strictly above the limit, in basis points (45.00 at 45 is not above; 45.01 is). */
export const aboveLimit = (effBp: number, limitPercent: Num): boolean => effBp > percentToBp(limitPercent);

/** Above the hard ceiling (60 %) — refused outright. */
export const aboveCeiling = (effBp: number): boolean => aboveLimit(effBp, DISCOUNT_MAX);

export type MeasuredLine = {
  index: number;
  /** null: a custom line (no SKU, or an SKU priced 0) — a manager approves it whatever its discount. */
  effBp: number | null;
  custom: boolean;
  overLimit: boolean;
  overCeiling: boolean;
};

/**
 * Every line of a quotation measured against its list (the editor's live check, the same as the server's rule):
 * `skuPrice` is the catalogue price of the line's SKU (null / 0 → a custom line).
 */
export function measureLines(
  lines: { quantity: Num; unitPrice: Num; discountPercent: Num; skuPrice: Num | null }[],
  limitPercent: Num,
): { lines: MeasuredLine[]; needsApproval: boolean; overCeiling: boolean; maxBp: number } {
  let maxBp = 0;
  const out = lines.map((l, index): MeasuredLine => {
    const price = l.skuPrice == null ? BigInt(0) : scaled(l.skuPrice, 2);
    if (price <= BigInt(0)) return { index, effBp: null, custom: true, overLimit: false, overCeiling: false };
    const listValue5 = price * scaled(l.quantity, 3); // 2 dp × 3 dp = 5 dp
    const netH = lineNetHalalas(l.quantity, l.unitPrice, l.discountPercent);
    const L = listValue5, N = netH * BigInt(1000);
    const effBp = L <= BigInt(0) ? 0 : N >= L ? 0 : Number(divHalfUp((L - N) * BigInt(10000), L));
    if (effBp > maxBp) maxBp = effBp;
    return { index, effBp, custom: false, overLimit: aboveLimit(effBp, limitPercent), overCeiling: aboveCeiling(effBp) };
  });
  return { lines: out, needsApproval: out.some((l) => l.custom || l.overLimit), overCeiling: out.some((l) => l.overCeiling), maxBp };
}
