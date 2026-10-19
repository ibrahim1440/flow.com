// The quotation document (Figma QP-05 1295:987, QP-03 1295:754, EN 1373:791): what each part of
// the printed page says, as plain data. Pure and client-safe, so the column mapping and the
// formatting are asserted without a browser (tests/print/unit/quote-document.test.ts), and the
// sheet component only lays the result out.
//
// Nothing here computes an amount. Every figure is read from a line that the server priced:
// the issued snapshot (frozen at issue) or, for a draft, the live lines the API reports
// (GET /api/sales/quotes/[id] → liveDocument). The document prints them as they are.
import { formatMoney } from "../format/money";

export type DocLang = "ar" | "en";

/** One line of the document, in the shape `issuedSnapshot.lines` has always had. */
export type QuoteDocLine = {
  position: number;
  skuCode: string | null;
  name: string | null;
  nameAr: string | null;
  description: string | null;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxRatePercent: string;
  gross: string;
  discountAmount: string;
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
};

/** The stored unit, as the frames write it («1,200 كغ», «800 عبوة»). */
export const UNIT_LABELS: Record<string, { en: string; ar: string }> = {
  KG: { en: "kg", ar: "كغ" },
  UNIT: { en: "pack", ar: "عبوة" },
  GRAM: { en: "g", ar: "غ" },
};

export const unitLabel = (unit: string, lang: DocLang) => UNIT_LABELS[unit]?.[lang] ?? unit;

/** The columns of the lines table, in the owner's order (amendment §9, ZT addendum §17). */
export const QUOTE_LINE_COLUMNS = [
  "index", "description", "quantity", "unitPrice", "discount", "beforeTax", "tax", "total",
] as const;
export type QuoteColumnKey = (typeof QUOTE_LINE_COLUMNS)[number];

const COLUMN_LABELS: Record<QuoteColumnKey, { ar: string; en: string }> = {
  index: { ar: "#", en: "#" },
  description: { ar: "الوصف", en: "Description" },
  quantity: { ar: "الكمية", en: "Qty" },
  unitPrice: { ar: "سعر الوحدة", en: "Unit price" },
  discount: { ar: "الخصم", en: "Discount" },
  beforeTax: { ar: "قبل الضريبة", en: "Before VAT" },
  tax: { ar: "الضريبة", en: "VAT" },
  total: { ar: "الإجمالي", en: "Total" },
};

export type DocColumn = {
  key: string;
  label: string;
  /** Figures: aligned to the end edge, in the numeral face. */
  numeric: boolean;
  /** Read in the muted colour (the item number). */
  muted?: boolean;
};

/** One cell: the main text and, under it, a smaller muted line (the SKU, a rate). */
export type DocCell = { main: string; sub?: string | null; subMono?: boolean };

export function quoteLineColumns(lang: DocLang): DocColumn[] {
  return QUOTE_LINE_COLUMNS.map((key) => ({
    key,
    label: COLUMN_LABELS[key][lang],
    numeric: key !== "index" && key !== "description",
    muted: key === "index",
  }));
}

/** `12` / `12.000000` / `12.5` → `12%` / `12%` / `12.5%` (at most two places, as written). */
export function formatPercent(raw: string | number): string {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return "—";
  return `${Number(n.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/** A quantity, grouped, with up to three places (fractional kilograms): `1,200`, `2.5`. */
export function formatQuantity(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

const isPositive = (raw: string) => Number(raw) > 0;

/** The name as it stood when the offer was made; the Arabic name on the Arabic document. */
export function lineName(line: QuoteDocLine, lang: DocLang): string {
  return (lang === "ar" ? line.nameAr : null) || line.name || line.description || "—";
}

/**
 * One line → its cells, in QUOTE_LINE_COLUMNS order:
 *   # · الوصف (name, SKU under it) · الكمية (with the unit) · سعر الوحدة ·
 *   الخصم (amount, rate under it; «—» when none) · قبل الضريبة · الضريبة (amount, rate under it) ·
 *   الإجمالي.
 */
export function quoteLineCells(line: QuoteDocLine, ordinal: number, lang: DocLang): DocCell[] {
  const byKey: Record<QuoteColumnKey, DocCell> = {
    index: { main: String(ordinal) },
    description: { main: lineName(line, lang), sub: line.skuCode || null, subMono: true },
    quantity: { main: `${formatQuantity(line.quantity)} ${unitLabel(line.unit, lang)}` },
    unitPrice: { main: formatMoney(line.unitPrice) },
    discount: isPositive(line.discountAmount)
      ? { main: formatMoney(line.discountAmount), sub: formatPercent(line.discountPercent) }
      : { main: "—" },
    beforeTax: { main: formatMoney(line.lineSubtotal) },
    tax: { main: formatMoney(line.lineTax), sub: formatPercent(line.taxRatePercent) },
    total: { main: formatMoney(line.lineTotal) },
  };
  return QUOTE_LINE_COLUMNS.map((k) => byKey[k]);
}

/** The VAT rate when every line carries the same one (the usual 15%), else null. */
export function uniformTaxRate(lines: Pick<QuoteDocLine, "taxRatePercent">[]): string | null {
  if (lines.length === 0) return null;
  const rates = new Set(lines.map((l) => Number(l.taxRatePercent)));
  if (rates.size !== 1) return null;
  const [rate] = [...rates];
  return Number.isFinite(rate) ? formatPercent(rate) : null;
}

/** The stored IBAN as it is printed: «SA» and the 22 digits in groups of four. */
export function formatIban(iban: string): string {
  return iban.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * «الجمعة 6 نوفمبر 2026» / «Friday, 6 November 2026»: the Gregorian calendar, Latin digits,
 * Riyadh time (a validity date is a Saudi calendar day, wherever the document is printed).
 */
export function longDate(value: string | Date | null | undefined, lang: DocLang): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB-u-ca-gregory", {
    timeZone: "Asia/Riyadh", weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return lang === "ar"
    ? `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`
    : `${get("weekday")}, ${get("day")} ${get("month")} ${get("year")}`;
}
