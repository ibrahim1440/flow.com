/**
 * An amount typed by a person (owner, 10 Nov 2026: «خانة المبلغ تقبل فقط أرقام وفواصل»): only digits, the thousands
 * comma and ONE decimal point (two places). Arabic-Indic digits (٠–٩, ۰–۹) become 0–9, the Arabic separators «٫ ٬»
 * become «. ,»; anything else is dropped as it is typed, so a letter or a symbol never reaches the field.
 */
/**
 * What the server accepts for an amount (POST /api/sales/collections and the correction route import this): a plain
 * figure, at most two decimals, no sign, no commas. The client sends exactly this (gate L1).
 */
export const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Arabic-Indic digits → 0–9, «٫» → «.», «٬ ،» → «,»; everything else unchanged. */
function latinise(raw: string): string {
  let s = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x0660 && c <= 0x0669) s += String(c - 0x0660);
    else if (c >= 0x06f0 && c <= 0x06f9) s += String(c - 0x06f0);
    else if (ch === "٫") s += ".";
    else if (ch === "٬" || ch === "،") s += ",";
    else s += ch;
  }
  return s;
}

export function cleanAmount(raw: string): string {
  let s = latinise(raw).replace(/[^0-9.,]/g, "");
  const dot = s.indexOf(".");
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/[.,]/g, "").slice(0, 2);
  return s.replace(/^,+/, "");
}

/**
 * What the server is sent: the plain figure — commas removed, «.5» → «0.5», «00012» → «12», «12.» → «12» (gate L1).
 * Always matches AMOUNT_PATTERN when amountValue() is not null.
 */
export function amountForServer(s: string): string {
  let plain = s.replace(/,/g, "");
  if (plain.endsWith(".")) plain = plain.slice(0, -1);
  if (plain.startsWith(".")) plain = `0${plain}`;
  return plain.replace(/^0+(?=\d)/, "");
}

/** The amount as a number, or null when it is not one the server would accept (empty, «.», «,,»…). */
export function amountValue(s: string): number | null {
  const plain = amountForServer(s);
  if (!AMOUNT_PATTERN.test(plain)) return null;
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}

/**
 * A PASTED amount (gate L2): accepted only when the whole paste is one clean figure — after the Arabic digits and
 * separators are converted and spaces and thousands commas removed, digits with at most one point and at most two
 * decimals. Anything else is refused (null) and the field is left as it was, never silently rewritten:
 *   «1.500» (three decimals — is it 1.5 or 1,500?), «1.2.3», «1e5», «-500», «12abc34», «SAR 50».
 * The accepted figure comes back as typed text for the field (cleanAmount keeps the commas the person pasted).
 */
export function parsePastedAmount(raw: string): string | null {
  const t = latinise(raw).replace(/[\s\u00a0\u200f\u200e]/g, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)?(\.\d{1,2})?$/.test(t) || !/\d/.test(t)) return null;
  return t;
}
