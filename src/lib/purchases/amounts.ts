// Phase 2 — the purchase invoice form's amounts, computed EXACTLY as the server does (quantity × unit cost rounded
// once HALF-UP to the halala; VAT per line, rounded once — src/lib/accounting/ops/purchase-invoice.ts and
// costing.ts lineVat), with integer arithmetic so the screen never shows a total the save would not produce.
// Pure: no imports, safe in the browser and in unit tests. (BigInt(…) rather than literals: the target is ES2017.)
const B0 = BigInt(0), B2 = BigInt(2), B10 = BigInt(10), B100 = BigInt(100);

/** Arabic-Indic digits and grouping separators → a plain decimal string ("١٬٢٣٤٫٥" → "1234.5"), as the API reads it. */
export function plainNumber(v: string | number | null | undefined): string {
  return String(v ?? "").trim().replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/٫/g, ".").replace(/[,،٬\s]/g, "");
}

/** A decimal string → [digits as bigint, scale]; null when it is not a plain non-negative decimal. */
function parse(v: string | number | null | undefined): [bigint, number] | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : plainNumber(v);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return [BigInt(i + f), f.length];
}

/** Round a scaled integer to 2 decimals, HALF-UP. */
function to2(n: bigint, scale: number): bigint {
  if (scale <= 2) return n * B10 ** BigInt(2 - scale);
  const d = B10 ** BigInt(scale - 2);
  return (n + d / B2) / d;
}

const fmt2 = (h: bigint) => `${h / B100}.${String(h % B100).padStart(2, "0")}`;

/** Halalas of an amount (2 dp, HALF-UP), or null. */
export function halalas(v: string | number | null | undefined): bigint | null {
  const p = parse(v);
  return p ? to2(p[0], p[1]) : null;
}

/** quantity × unit cost, rounded once to the halala, as "123.45" (null when either is not a number). */
export function lineNet(quantity: string | number | null | undefined, unitCost: string | number | null | undefined): string | null {
  const q = parse(quantity), u = parse(unitCost);
  if (!q || !u) return null;
  return fmt2(to2(q[0] * u[0], q[1] + u[1]));
}

/** VAT of a net at a rate (%), rounded once to the halala. */
export function lineVatText(net: string | null | undefined, ratePct: string | number | null | undefined): string {
  const n = parse(net), r = parse(ratePct);
  if (!n || !r) return "0.00";
  return fmt2(to2(n[0] * r[0], n[1] + r[1] + 2));
}

/** a + b + … of amounts given as decimal strings. */
export function sumAmounts(list: (string | null | undefined)[]): string {
  return fmt2(list.reduce<bigint>((s, v) => s + (halalas(v) ?? B0), B0));
}

/** The unit cost a stored line implies (net ÷ quantity), trimmed to at most 6 decimals. */
export function impliedUnitCost(net: string | number | null | undefined, quantity: string | number | null | undefined): string {
  const n = Number(net), q = Number(quantity);
  if (!Number.isFinite(n) || !Number.isFinite(q) || q <= 0) return "";
  return String(Number((n / q).toFixed(6)));
}
