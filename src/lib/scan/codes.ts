/**
 * Label codes and scanned text (20261114090000_green_lot_labels). Pure and client-safe: the label, the scan input and
 * the server lookup share it.
 *
 * The barcode payload is a short, stable code — never a name, a price or a person:
 *   · a green lot          GL-00042   ("GreenBean"."labelCode", from a sequence)
 *   · a stock material     MT-00007   ("MaterialItem"."labelCode")
 * Upper-case Latin, digits and one hyphen, so Code 128 prints it compactly and every scanner reads it.
 *
 * A keyboard-wedge scanner TYPES what it reads, through the operating system's keyboard layout: on a computer set to
 * the Arabic layout, «GL-00042» arrives as «لأ/-00042» (Shift+G, Shift+L) or «لم-00042» (unshifted). normalizeScan maps
 * the Arabic (101) layout back to the Latin keys and Arabic-Indic digits to 0–9, so the same sticker scans on both.
 * A QR code holds the lot's page address; parseScan reads the code back out of it.
 */

export type LabelCodeKind = "GREEN_LOT" | "MATERIAL";
export const LABEL_PREFIX: Record<LabelCodeKind, string> = { GREEN_LOT: "GL", MATERIAL: "MT" };

/** «GL-00042» from a number (at least five digits). */
export function formatLabelCode(kind: LabelCodeKind, n: number): string {
  return `${LABEL_PREFIX[kind]}-${String(Math.trunc(n)).padStart(5, "0")}`;
}

/** The trace page a lot's QR code opens, relative to the application's origin. */
export const lotPagePath = (code: string) => `/dashboard/inventory/lots/${encodeURIComponent(code)}`;

// Arabic (101) layout → the Latin key that produces it. Multi-character outputs first (the lam-alef ligatures).
const AR_MULTI: [string, string][] = [["لإ", "T"], ["لأ", "G"], ["لآ", "B"], ["لا", "B"]];
const AR_KEYS: Record<string, string> = {
  // unshifted letters
  "ض": "Q", "ص": "W", "ث": "E", "ق": "R", "ف": "T", "غ": "Y", "ع": "U", "ه": "I", "خ": "O", "ح": "P",
  "ش": "A", "س": "S", "ي": "D", "ب": "F", "ل": "G", "ا": "H", "ت": "J", "ن": "K", "م": "L",
  "ئ": "Z", "ء": "X", "ؤ": "C", "ر": "V", "ى": "N", "ة": "M",
  // shifted letters (marks and punctuation the layout puts on the letter keys)
  "َ": "Q", "ً": "W", "ُ": "E", "ٌ": "R", "إ": "Y", "‘": "U", "÷": "I", "×": "O", "؛": "P",
  "ِ": "A", "ٍ": "S", "]": "D", "[": "F", "أ": "H", "ـ": "J", "،": "K", "/": "L",
  "~": "Z", "ْ": "X", "}": "C", "{": "V", "آ": "N", "’": "M",
};
const DIGITS = "٠١٢٣٤٥٦٧٨٩", DIGITS_FA = "۰۱۲۳۴۵۶۷۸۹";

/**
 * What a scanner (or a person) typed, as the code that was printed: trimmed, control characters dropped, Arabic-Indic
 * digits to 0–9, and — when the text holds Arabic letters — the Arabic keyboard layout mapped back to Latin keys.
 * A URL is kept as it is (its path is read by parseScan).
 */
export function normalizeScan(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let s = raw.replace(/[\u0000-\u001f\u007f‎‏⁦-⁩]/g, "").trim().slice(0, 300);
  s = s.replace(/[٠-٩]/g, (d) => String(DIGITS.indexOf(d))).replace(/[۰-۹]/g, (d) => String(DIGITS_FA.indexOf(d)));
  if (/^https?:\/\//i.test(s)) return s;
  if (/[؀-ۿ‘’÷×~{}[\]]/.test(s) && /[؀-ۿ]/.test(s)) {
    for (const [from, to] of AR_MULTI) s = s.split(from).join(to);
    s = [...s].map((c) => AR_KEYS[c] ?? c).join("");
  }
  return s.toUpperCase();
}

export type ParsedScan =
  | { kind: "GREEN_LOT"; code: string }
  | { kind: "MATERIAL"; code: string }
  /** A retail barcode (EAN-8 / UPC-A / EAN-13 / GTIN-14): a finished product's SKU barcode. */
  | { kind: "EAN"; value: string }
  /** Anything else: looked up as a lot serial number or a material code, exactly (as mapped, and as typed). */
  | { kind: "TEXT"; value: string; raw: string }
  | { kind: "EMPTY" };

const CODE_RE = /^(GL|MT)[-\s_]?0*(\d{1,9})$/;

/** The code a scan names. Reads «GL-00042», «gl42», «GL 42», an Arabic-layout scan, or the lot page URL in a QR code. */
export function parseScan(raw: unknown): ParsedScan {
  let s = normalizeScan(raw);
  if (!s) return { kind: "EMPTY" };
  if (/^HTTPS?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const m = /\/dashboard\/inventory\/lots\/([^/?#]+)/.exec(u.pathname);
      s = m ? decodeURIComponent(m[1]).toUpperCase() : "";
    } catch { s = ""; }
    if (!s) return { kind: "TEXT", value: normalizeScan(raw).slice(0, 120), raw: typed(raw) };
  }
  const m = CODE_RE.exec(s);
  if (m) {
    const kind: LabelCodeKind = m[1] === "GL" ? "GREEN_LOT" : "MATERIAL";
    return { kind, code: formatLabelCode(kind, Number(m[2])) } as ParsedScan;
  }
  if (/^(\d{8}|\d{12,14})$/.test(s)) return { kind: "EAN", value: s };
  return { kind: "TEXT", value: s.slice(0, 120), raw: typed(raw) };
}

const typed = (raw: unknown) => (typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) : "");

/** True for a 13-digit EAN whose check digit is right (the label prints it as EAN-13, anything else as Code 128). */
export function isValidEan13(v: string): boolean {
  if (!/^\d{13}$/.test(v)) return false;
  const d = [...v].map(Number);
  const sum = d.slice(0, 12).reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === d[12];
}
