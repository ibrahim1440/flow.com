// Sales invoicing A2 — what the printed tax invoice / credit / debit note says (Figma ZT-04 AR 1284:46933,
// ZT-04 EN 1372:3876, ZT-05 simplified 1209:3743, ZT-06a credit note 1209:3865, ZT-02 draft preview 1209:3455).
// Pure and client-safe; DocumentSheet lays it out. An ISSUED document prints its frozen snapshot only (E-4).
import { formatQuantity, type DocCell, type DocColumn, type DocLang } from "./quote-document";

export type InvoicePrintLine = {
  description: string; descriptionEn?: string | null; skuCode: string | null; quantity: string; unit: string; unitPrice: string;
  discountAmount: string; discountPercent: string; taxCategory: string; taxRatePercent: string; lineNet: string; lineTax: string; lineTotal: string;
};

const L = (lang: DocLang, ar: string, en: string) => (lang === "ar" ? ar : en);
const nf = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const amount = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : nf.format(Number(v)));

export const TITLES: Record<string, Record<string, { ar: string; en: string }>> = {
  INVOICE: { STANDARD: { ar: "فاتورة ضريبية", en: "Tax Invoice" }, SIMPLIFIED: { ar: "فاتورة ضريبية مبسطة", en: "Simplified Tax Invoice" } },
  CREDIT_NOTE: { STANDARD: { ar: "إشعار دائن", en: "Credit Note" }, SIMPLIFIED: { ar: "إشعار دائن مبسط", en: "Simplified Credit Note" } },
  DEBIT_NOTE: { STANDARD: { ar: "إشعار مدين", en: "Debit Note" }, SIMPLIFIED: { ar: "إشعار مدين مبسط", en: "Simplified Debit Note" } },
};
export function documentTitle(kind: string, family: string, lang: DocLang): { main: string; alt: string } {
  const t = TITLES[kind]?.[family] ?? TITLES.INVOICE.STANDARD;
  return { main: lang === "ar" ? t.ar : t.en, alt: lang === "ar" ? t.en : t.ar };
}

export function invoiceColumns(lang: DocLang): DocColumn[] {
  return [
    { key: "index", label: "#", numeric: false, muted: true },
    { key: "description", label: L(lang, "الوصف", "Description"), numeric: false },
    { key: "quantity", label: L(lang, "الكمية", "Qty"), numeric: true },
    { key: "unitPrice", label: L(lang, "سعر الوحدة", "Unit price"), numeric: true },
    { key: "discount", label: L(lang, "الخصم", "Discount"), numeric: true },
    { key: "net", label: L(lang, "قبل الضريبة", "Before VAT"), numeric: true },
    { key: "vat", label: L(lang, "الضريبة", "VAT"), numeric: true },
    { key: "total", label: L(lang, "الإجمالي", "Total"), numeric: true },
  ];
}

const CATEGORY_SHORT: Record<string, { ar: string; en: string }> = { Z: { ar: "صفرية", en: "Zero" }, E: { ar: "معفاة", en: "Exempt" }, O: { ar: "خارج النطاق", en: "Out of scope" } };

export function invoiceCells(l: InvoicePrintLine, index: number, lang: DocLang): DocCell[] {
  const unit = l.unit === "KG" ? L(lang, "كغ", "kg") : L(lang, "عبوة", "unit");
  const name = lang === "en" && l.descriptionEn ? l.descriptionEn : l.description;
  return [
    { main: String(index) },
    { main: name, sub: l.skuCode, subMono: true },
    { main: `${formatQuantity(l.quantity)} ${unit}` },
    { main: amount(l.unitPrice) },
    { main: Number(l.discountAmount) > 0 ? amount(l.discountAmount) : "—", sub: Number(l.discountAmount) > 0 ? `${Number(l.discountPercent)}%` : null },
    { main: amount(l.lineNet) },
    { main: amount(l.lineTax), sub: l.taxCategory === "S" ? `${Number(l.taxRatePercent)}%` : L(lang, CATEGORY_SHORT[l.taxCategory]?.ar ?? l.taxCategory, CATEGORY_SHORT[l.taxCategory]?.en ?? l.taxCategory) },
    { main: amount(l.lineTotal) },
  ];
}

/** «الرياض 12214 · حي العليا · شارع التحلية · مبنى 2190» — the structured national address, as ZT-04 draws it. */
export function addressLine(a: { city?: string | null; postalCode?: string | null; district?: string | null; street?: string | null; buildingNo?: string | null; address?: string | null }, lang: DocLang): string | null {
  const parts = [
    [a.city, a.postalCode].filter(Boolean).join(" "),
    a.district ? `${L(lang, "حي", "District")} ${a.district}` : null,
    a.street || null,
    a.buildingNo ? `${L(lang, "مبنى", "Building")} ${a.buildingNo}` : null,
  ].filter((x): x is string => !!x && x.trim() !== "");
  return parts.length ? parts.join(" · ") : a.address ?? null;
}

export function legalLine(lang: DocLang, hasStandard: boolean): string {
  return L(lang, `المبالغ بالريال السعودي.${hasStandard ? " ضريبة القيمة المضافة 15% على السطور القياسية." : ""}`, `Amounts in Saudi riyals.${hasStandard ? " VAT 15% on standard-rated lines." : ""}`);
}
