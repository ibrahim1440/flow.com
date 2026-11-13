/**
 * P2 ERR-17: ONE reading of a number a person typed, on every form (deal value, quote quantity and price, collection
 * and correction amounts, direct-sale quantity, the round counter…). Before, each form had its own parser: Arabic-Indic
 * digits were accepted in some fields, refused in others and turned into 0 in the round counter.
 *
 *   «١٥٬٠٠٠٫٥٥» → «15000.55»   Arabic-Indic / Persian digits → 0–9, «٫» → «.», «٬ ،» → «,»
 *   «15,000.5»  → «15000.5»    thousands commas are dropped — only when they group by three («1,5» stays and is refused)
 *   direction marks (RLM/LRM/ALM) are dropped; spaces are NOT — « 5 » and «1 500» stay refused, as before
 *
 * It only rewrites the text; whether the figure is acceptable (sign, decimals, bounds) stays each field's own rule.
 * Anything that is not a string comes back unchanged.
 */
const AR0 = 0x0660, FA0 = 0x06f0;

export function latinNumberText(raw: string): string {
  let s = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    if (c >= AR0 && c <= AR0 + 9) s += String(c - AR0);
    else if (c >= FA0 && c <= FA0 + 9) s += String(c - FA0);
    else if (ch === "٫") s += ".";
    else if (ch === "٬" || ch === "،") s += ",";
    else if (ch === "−") s += "-";
    else s += ch;
  }
  s = s.replace(/[\u200e\u200f\u061c]/g, "");
  // Thousands commas only when they really group by three: «15,000.5» → «15000.5»; «1,5» is left to be refused.
  if (s.includes(",") && /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  return s;
}

export function normalizeTypedNumber<T>(v: T): T | string {
  return typeof v === "string" ? latinNumberText(v) : v;
}
