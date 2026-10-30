/**
 * Arabic search normalisation (batch 24 WP-A, Ctrl K record search).
 *
 * A rep types «مؤسسه الواحه» and expects «مؤسسة الواحة»; types «أحمد» and expects «احمد»; types
 * «٠٥٥» and expects the phone 055…. Both sides of the comparison go through the same folding:
 *   · أ إ آ ٱ → ا · ة → ه · ى → ي;
 *   · tatweel (ـ) and the harakat (U+064B–U+0652, U+0670) are dropped;
 *   · Latin letters are lower-cased; Arabic-Indic and Persian digits become 0–9.
 *
 * The SQL side (`SQL_FOLD_FROM` / `SQL_FOLD_TO`) is the same table as `translate()` arguments, so a
 * stored name is folded in the query exactly as the typed text is folded here. Pure: unit-tested.
 */
const FOLD: Record<string, string> = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ة": "ه", "ى": "ي" };
const DROP = /[ـً-ْٰ]/g;

/**
 * `translate(lower(x), FROM, TO)`: the first six letters fold, then the Arabic-Indic and Persian digits become 0–9
 * (a name stored as «مطعم ٢» is found by «2» and by «٢»), and the rest (tatweel, harakat) are removed.
 */
const AR_DIGITS = "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669";
const FA_DIGITS = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
export const SQL_FOLD_FROM = `أإآٱةى${AR_DIGITS}${FA_DIGITS}\u0640\u064B\u064C\u064D\u064E\u064F\u0650\u0651\u0652\u0670`;
export const SQL_FOLD_TO = "ااااهي01234567890123456789";

export function toLatinDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

export function foldArabic(s: string): string {
  return toLatinDigits(s).toLowerCase().replace(DROP, "").replace(/[أإآٱةى]/g, (c) => FOLD[c] ?? c).replace(/\s+/g, " ").trim();
}

/**
 * The digits of a phone-like query, or null when it is not one (fewer than 3 digits, or letters mixed in).
 * A Saudi number is stored as «055…», «+966 55…» or «96655…»: the leading 0 / 966 is dropped so any of
 * the three finds the others.
 */
export function phoneDigits(q: string): string | null {
  const t = toLatinDigits(q).trim();
  if (!/^[+\d\s()-]+$/.test(t)) return null;
  let d = t.replace(/\D/g, "");
  if (d.length < 3) return null;
  if (d.startsWith("00966")) d = d.slice(5);
  else if (d.startsWith("966")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return d.length >= 3 ? d : null;
}

/** «0551234567» / «+966 55 123 4567» → «966551234567» for wa.me; null when it is not a usable number. */
export function waNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = toLatinDigits(phone).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("966")) return d.length >= 11 ? d : null;
  if (d.startsWith("05") && d.length === 10) return `966${d.slice(1)}`;
  if (d.startsWith("5") && d.length === 9) return `966${d}`;
  return d.length >= 10 ? d : null;
}

/** A dialable `tel:` target: digits and a leading +, nothing else. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const t = toLatinDigits(phone).trim();
  const d = t.replace(/[^\d+]/g, "");
  return d.replace(/\D/g, "").length >= 3 ? `tel:${d}` : null;
}
