// Money for the finance module: integer halalas (1 SAR = 100 halalas) in every calculation.
//
// Floating point never touches an amount. Values come in as Prisma.Decimal / strings from
// the database (Decimal(18,2)) or as user-typed strings, are parsed digit-by-digit into an
// integer, and go back out as fixed two-decimal strings. Number.MAX_SAFE_INTEGER halalas is
// ~90 trillion SAR, far beyond anything this business will store.

export type Minor = number;

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXT_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Normalise Arabic-Indic digits, Arabic decimal/thousands separators and spaces. */
export function normaliseDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const a = ARABIC_INDIC.indexOf(ch);
    const e = EXT_ARABIC_INDIC.indexOf(ch);
    if (a >= 0) out += String(a);
    else if (e >= 0) out += String(e);
    else if (ch === "٫") out += ".";
    else if (ch === "٬" || ch === "،") out += ",";
    else out += ch;
  }
  return out;
}

/**
 * Parse a decimal string with at most two fraction digits into halalas.
 * Accepts "1,234.50", "-12", "(45.00)" (accounting negative), Arabic-Indic digits.
 * Returns null for anything else — including a third decimal place, which would otherwise
 * be silently rounded.
 */
export function parseMoney(raw: unknown): Minor | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    // Numbers are accepted only when they are already exact to the halala.
    const s = raw.toFixed(2);
    if (Math.abs(Number(s) - raw) > 1e-9) return null;
    return parseMoney(s);
  }
  if (raw === null || raw === undefined) return null;
  let s = normaliseDigits(String(raw)).trim().replace(/\s/g, "").replace(/SAR|ر\.?س\.?|﷼/gi, "");
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); }
  else if (s.startsWith("+")) s = s.slice(1);
  if (s.endsWith("-")) { negative = !negative; s = s.slice(0, -1); }
  // Thousands separators only in valid positions.
  if (s.includes(",")) {
    if (!/^\d{1,3}(,\d{3})*(\.\d*)?$/.test(s)) return null;
    s = s.replace(/,/g, "");
  }
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(whole * 100 + frac)) return null;
  const v = whole * 100 + frac;
  return negative ? -v : v;
}

/** Decimal(18,2) value from the database (Prisma.Decimal, string or number) to halalas. */
export function toMinor(value: { toString(): string } | string | number | null | undefined): Minor {
  if (value === null || value === undefined) return 0;
  const s = typeof value === "number" ? value.toFixed(2) : value.toString();
  // Prisma.Decimal may print "1e+3" style for large values; normalise via fixed notation.
  const fixed = /e/i.test(s) ? Number(s).toFixed(2) : s;
  const neg = fixed.startsWith("-");
  const body = neg ? fixed.slice(1) : fixed;
  const [w, f = ""] = body.split(".");
  if (f.length > 2 && /[1-9]/.test(f.slice(2))) {
    throw new Error(`Amount ${s} has more than two decimal places`);
  }
  const v = Number(w) * 100 + Number((f.slice(0, 2)).padEnd(2, "0"));
  return neg ? -v : v;
}

/** Halalas to the fixed "1234.50" string Prisma accepts for Decimal columns. */
export function fromMinor(minor: Minor): string {
  if (!Number.isSafeInteger(minor)) throw new Error("Amount is not an integer number of halalas");
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

/**
 * Display: "SAR 1,234.50" / "1,234.50 ر.س" — formatting only, never re-parsed.
 *
 * Digits are Latin 0–9 in both languages (the ERP-wide convention for the Arabic UI;
 * Intl with "ar-SA" would emit Arabic-Indic digits on some platforms and not others).
 * In Arabic the signed number is wrapped in a left-to-right isolate so "−450.00" is not
 * reordered to "450.00−" by the bidirectional algorithm.
 */
export function formatSAR(minor: Minor, lang: "ar" | "en" = "en", opts: { sign?: boolean; plain?: boolean } = {}): string {
  const abs = Math.abs(minor);
  const n = Math.floor(abs / 100).toLocaleString("en-US");
  const f = String(abs % 100).padStart(2, "0");
  const sign = minor < 0 ? "−" : opts.sign && minor > 0 ? "+" : "";
  const num = `${sign}${n}.${f}`;
  if (opts.plain) return lang === "ar" && sign ? `⁦${num}⁩` : num;
  return lang === "ar" ? `⁦${num}⁩ ر.س` : `SAR ${num}`;
}

export function sumMinor(values: Minor[]): Minor {
  let t = 0;
  for (const v of values) t += v;
  return t;
}

/**
 * Split `total` across `weights` so the parts sum to `total` exactly.
 *
 * Largest-remainder method on exact integer arithmetic: each share is floor(total·w/W);
 * the halalas left over go one at a time to the largest fractional remainders, ties broken
 * by position (earlier first). Deterministic for the same input, always exact.
 */
export function splitByWeights(total: Minor, weights: number[]): Minor[] {
  if (total < 0) return splitByWeights(-total, weights).map((v) => -v);
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new Error("Weights must be non-negative integers");
  }
  const W = weights.reduce((a, b) => a + b, 0);
  if (W === 0) return weights.map(() => 0);
  const shares: Minor[] = [];
  const rems: { i: number; r: bigint }[] = [];
  let used = 0;
  const T = BigInt(total);
  const WB = BigInt(W);
  weights.forEach((w, i) => {
    const num = T * BigInt(w);
    const q = num / WB;
    shares.push(Number(q));
    used += Number(q);
    rems.push({ i, r: num % WB });
  });
  let left = total - used;
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (let k = 0; left > 0; k++, left--) shares[rems[k % rems.length].i] += 1;
  return shares;
}

/** Percent strings with up to four decimals ("65", "12.5", "7.0000") to basis-points×100 integers. */
export function parsePercentScaled(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = normaliseDigits(String(raw)).trim().replace("%", "");
  const m = /^(\d{1,3})(?:\.(\d{0,4}))?$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]) * 10_000 + Number((m[2] ?? "").padEnd(4, "0"));
  if (v <= 0 || v > 1_000_000) return null;
  return v; // 100% === 1_000_000
}

export const PERCENT_SCALE = 1_000_000;

export function formatPercentScaled(scaled: number): string {
  const whole = Math.floor(scaled / 10_000);
  const frac = String(scaled % 10_000).padStart(4, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
