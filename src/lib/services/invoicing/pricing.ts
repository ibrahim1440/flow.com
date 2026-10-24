// Sales invoicing A2 — the invoice arithmetic, defined once. Pure: no database, safe in unit tests and in
// client components (the editor previews the same figures the server stores and the database re-checks).
//
// ── The rule (E-10, ZATCA XML implementation standard v1.2; batch-zatca/PLAN.md §4.5, decision R-1) ──
//   line gross    = round(qty × unit price)                       half-up, 2 dp
//   line discount = round(line gross × discount %)
//   line net      = line gross − line discount                    (BT-131, "line extension amount")
//   line VAT      = round(line net × rate)                        INFORMATIONAL (KSA-11): shown, never summed
//   document VAT  = Σ over (category, rate) of round(Σ line net × rate)   ← rounded ONCE per category, on the total
//   taxable       = Σ line net;  payable = taxable + document VAT
// The quotation engine (services/sales/quotes.ts priceQuote) sums rounded line VAT; this engine deliberately does
// not reuse it, so an invoice and its quotation may differ by 0.01 on VAT (the INV299 case). Prices are VAT-exclusive
// in A2 (the inclusive mode, T-1, is not offered). The database checks the same arithmetic at issue
// (sinv_invoice_guard), so a figure computed anywhere else is refused.
import { Decimal, ZERO, roundMoney, toDecimal, MoneyError } from "@/lib/accounting/money";

export { Decimal };

export const INVOICE_CURRENCY = "SAR";
export const DEFAULT_VAT_RATE = "15";
export const DEFAULT_TERMS_DAYS = 30;
const HUNDRED = new Decimal(100);

export const TAX_CATEGORIES = ["S", "Z", "E", "O"] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

/** UNCL5305 categories and the KSA exemption reason codes the editor offers (verify on zatca.gov.sa before A4). */
export const TAX_CATEGORY_LABELS: Record<TaxCategory, { ar: string; en: string }> = {
  S: { ar: "خاضع للنسبة الأساسية", en: "Standard rate" },
  Z: { ar: "خاضع لنسبة الصفر", en: "Zero rated" },
  E: { ar: "معفى", en: "Exempt" },
  O: { ar: "خارج نطاق الضريبة", en: "Out of scope" },
};
export const EXEMPTION_REASONS: { code: string; category: Exclude<TaxCategory, "S">; ar: string; en: string }[] = [
  { code: "VATEX-SA-32", category: "Z", ar: "صادرات السلع من المملكة", en: "Export of goods" },
  { code: "VATEX-SA-33", category: "Z", ar: "صادرات الخدمات من المملكة", en: "Export of services" },
  { code: "VATEX-SA-34-1", category: "Z", ar: "النقل الدولي للسلع", en: "International transport of goods" },
  { code: "VATEX-SA-35", category: "Z", ar: "الأدوية والمعدات الطبية", en: "Medicines and medical equipment" },
  { code: "VATEX-SA-29", category: "E", ar: "الخدمات المالية", en: "Financial services" },
  { code: "VATEX-SA-30", category: "E", ar: "العقارات السكنية", en: "Qualifying residential real estate" },
  { code: "VATEX-SA-OOS", category: "O", ar: "خارج نطاق ضريبة القيمة المضافة", en: "Out of scope of VAT" },
];

export const NOTE_REASONS = ["RETURN", "PRICE_ADJUSTMENT", "DISCOUNT", "CANCELLATION", "AMENDMENT", "OTHER"] as const;
export type NoteReason = (typeof NOTE_REASONS)[number];
export const NOTE_REASON_LABELS: Record<NoteReason, { ar: string; en: string }> = {
  RETURN: { ar: "إرجاع بضاعة", en: "Goods returned" },
  PRICE_ADJUSTMENT: { ar: "تعديل السعر", en: "Price adjustment" },
  DISCOUNT: { ar: "خصم لاحق", en: "Discount after issue" },
  CANCELLATION: { ar: "إلغاء التوريد أو جزء منه", en: "Supply cancelled (in full or in part)" },
  AMENDMENT: { ar: "تصحيح بيانات الفاتورة", en: "Correction of the invoice" },
  OTHER: { ar: "سبب آخر", en: "Other reason" },
};

export const INVOICE_KINDS = ["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];
export const INVOICE_FAMILIES = ["STANDARD", "SIMPLIFIED"] as const;
export type InvoiceFamily = (typeof INVOICE_FAMILIES)[number];
export type InvoiceStatus = "DRAFT" | "ISSUED" | "CANCELLED";

/** ZATCA document type codes (InvoiceTypeCode) and the 7-character subtype name. */
export const ZATCA_TYPE_CODE: Record<InvoiceKind, string> = { INVOICE: "388", CREDIT_NOTE: "381", DEBIT_NOTE: "383" };
export const ZATCA_SUBTYPE: Record<InvoiceFamily, string> = { STANDARD: "0100000", SIMPLIFIED: "0200000" };

export const KIND_LABELS: Record<InvoiceKind, Record<InvoiceFamily, { ar: string; en: string }>> = {
  INVOICE: { STANDARD: { ar: "فاتورة ضريبية", en: "Tax invoice" }, SIMPLIFIED: { ar: "فاتورة ضريبية مبسطة", en: "Simplified tax invoice" } },
  CREDIT_NOTE: { STANDARD: { ar: "إشعار دائن", en: "Credit note" }, SIMPLIFIED: { ar: "إشعار دائن مبسط", en: "Simplified credit note" } },
  DEBIT_NOTE: { STANDARD: { ar: "إشعار مدين", en: "Debit note" }, SIMPLIFIED: { ar: "إشعار مدين مبسط", en: "Simplified debit note" } },
};

export type InvoiceLineInput = {
  quantity: Decimal;
  unitPrice: Decimal;
  discountPercent: Decimal;
  taxCategory: TaxCategory;
  taxRatePercent: Decimal;
};

export type PricedInvoiceLine = { gross: Decimal; discountAmount: Decimal; lineNet: Decimal; lineTax: Decimal; lineTotal: Decimal };

export type TaxBreakdownRow = { category: TaxCategory; rate: string; taxable: string; tax: string; exemptionReasonCode: string | null; exemptionReason: string | null };

export type PricedInvoice = {
  lines: PricedInvoiceLine[];
  /** Σ line gross (before discounts) — shown so the discount stays visible. */
  grossTotal: Decimal;
  discountTotal: Decimal;
  lineExtensionTotal: Decimal;
  taxableTotal: Decimal;
  taxTotal: Decimal;
  grandTotal: Decimal;
  breakdown: TaxBreakdownRow[];
  /** Σ informational line VAT − document VAT (E-10 vs the per-line sum; usually 0, at most a few halalas). */
  lineVatDifference: Decimal;
};

export function priceInvoiceLine(l: InvoiceLineInput): PricedInvoiceLine {
  const gross = roundMoney(l.quantity.times(l.unitPrice));
  const discountAmount = roundMoney(gross.times(l.discountPercent).dividedBy(HUNDRED));
  const lineNet = gross.minus(discountAmount);
  const lineTax = roundMoney(lineNet.times(l.taxRatePercent).dividedBy(HUNDRED));
  return { gross, discountAmount, lineNet, lineTax, lineTotal: lineNet.plus(lineTax) };
}

/** E-10: VAT per (category, rate) on the category's taxable total, rounded once. */
export function priceInvoice(lines: (InvoiceLineInput & { exemptionReasonCode?: string | null; exemptionReason?: string | null })[]): PricedInvoice {
  const priced = lines.map(priceInvoiceLine);
  const groups = new Map<string, { category: TaxCategory; rate: Decimal; net: Decimal; code: string | null; reason: string | null }>();
  lines.forEach((l, i) => {
    const key = `${l.taxCategory}|${l.taxRatePercent.toFixed(2)}`;
    const g = groups.get(key) ?? { category: l.taxCategory, rate: l.taxRatePercent, net: ZERO, code: l.exemptionReasonCode ?? null, reason: l.exemptionReason ?? null };
    g.net = g.net.plus(priced[i].lineNet);
    groups.set(key, g);
  });
  const breakdown: TaxBreakdownRow[] = [];
  let taxTotal = ZERO;
  for (const g of [...groups.values()].sort((a, b) => a.category.localeCompare(b.category) || b.rate.comparedTo(a.rate))) {
    const tax = roundMoney(g.net.times(g.rate).dividedBy(HUNDRED));
    taxTotal = taxTotal.plus(tax);
    breakdown.push({ category: g.category, rate: g.rate.toFixed(2), taxable: g.net.toFixed(2), tax: tax.toFixed(2), exemptionReasonCode: g.category === "S" ? null : g.code, exemptionReason: g.category === "S" ? null : g.reason });
  }
  const sum = (pick: (p: PricedInvoiceLine) => Decimal) => priced.reduce((s, p) => s.plus(pick(p)), ZERO);
  const lineExtensionTotal = sum((p) => p.lineNet);
  return {
    lines: priced,
    grossTotal: sum((p) => p.gross),
    discountTotal: sum((p) => p.discountAmount),
    lineExtensionTotal,
    taxableTotal: lineExtensionTotal,
    taxTotal,
    grandTotal: lineExtensionTotal.plus(taxTotal),
    breakdown,
    lineVatDifference: sum((p) => p.lineTax).minus(taxTotal),
  };
}

// ── Validation ───────────────────────────────────────────────────────────────────────────────────────

/** KSA VAT registration number: 15 digits, starting and ending with 3 (BR-KSA-39 / -40). */
export function isKsaVatNumber(v: unknown): v is string {
  return typeof v === "string" && /^3\d{13}3$/.test(v);
}

const arabicDigits = (s: string) => s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
export const normDigits = (v: unknown): string => (typeof v === "string" ? arabicDigits(v).replace(/\s+/g, "") : "");

export type LineProblem = { index: number; code: string; ar: string; en: string };

/** A line as the editor sends it. Amounts as decimal strings. */
export type RawLine = {
  description?: unknown; descriptionEn?: unknown; productSkuId?: unknown; orderItemId?: unknown; deliveryId?: unknown; originalLineId?: unknown;
  skuCode?: unknown; quantity?: unknown; unit?: unknown; unitPrice?: unknown; discountPercent?: unknown;
  taxCategory?: unknown; taxRatePercent?: unknown; exemptionReasonCode?: unknown; exemptionReason?: unknown;
};

export type CleanLine = InvoiceLineInput & {
  description: string; descriptionEn: string | null; productSkuId: string | null; orderItemId: string | null; deliveryId: string | null;
  originalLineId: string | null; skuCode: string | null; unit: "UNIT" | "KG"; exemptionReasonCode: string | null; exemptionReason: string | null;
};

const txt = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const idOrNull = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
function dec(v: unknown, places: number): Decimal | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? arabicDigits(v).trim() : "";
  if (!/^\d{1,13}(\.\d+)?$/.test(s)) return null;
  try {
    const d = toDecimal(s);
    return d.equals(d.toDecimalPlaces(places)) ? d : null;
  } catch (e) {
    if (e instanceof MoneyError) return null;
    throw e;
  }
}

/** Parse and check the lines of a draft. `forIssue` adds what an issued document needs (categories, reasons). */
export function parseLines(raw: unknown, opts: { forIssue?: boolean } = {}): { lines: CleanLine[]; problems: LineProblem[] } {
  const list = Array.isArray(raw) ? raw : [];
  const problems: LineProblem[] = [];
  const p = (index: number, code: string, ar: string, en: string) => problems.push({ index, code, ar, en });
  if (list.length > 200) p(-1, "TOO_MANY_LINES", "الحد الأقصى 200 بند.", "At most 200 lines.");
  const lines: CleanLine[] = [];
  list.slice(0, 200).forEach((r0, i) => {
    const r = (r0 && typeof r0 === "object" ? r0 : {}) as RawLine;
    const description = txt(r.description, 300);
    if (!description) p(i, "DESCRIPTION", "اكتب وصف البند.", "Describe the line.");
    const quantity = dec(r.quantity, 3);
    if (!quantity || quantity.lessThanOrEqualTo(0)) p(i, "QUANTITY", "الكمية رقم أكبر من صفر (3 منازل عشرية على الأكثر).", "The quantity is a number above zero (at most 3 decimals).");
    const unitPrice = dec(r.unitPrice, 2);
    if (!unitPrice) p(i, "PRICE", "سعر الوحدة رقم موجب بمنزلتين عشريتين على الأكثر.", "The unit price is a positive number with at most 2 decimals.");
    const discountPercent = r.discountPercent === undefined || r.discountPercent === null || r.discountPercent === "" ? new Decimal(0) : dec(r.discountPercent, 2);
    if (!discountPercent || discountPercent.greaterThan(100)) p(i, "DISCOUNT", "نسبة الخصم من 0 إلى 100.", "The discount is 0 to 100 percent.");
    const taxCategory = (typeof r.taxCategory === "string" && (TAX_CATEGORIES as readonly string[]).includes(r.taxCategory) ? r.taxCategory : "S") as TaxCategory;
    const rate = r.taxRatePercent === undefined || r.taxRatePercent === null || r.taxRatePercent === "" ? new Decimal(taxCategory === "S" ? DEFAULT_VAT_RATE : 0) : dec(r.taxRatePercent, 2);
    if (!rate || rate.greaterThan(100)) p(i, "RATE", "نسبة الضريبة من 0 إلى 100.", "The VAT rate is 0 to 100.");
    const exemptionReasonCode = txt(r.exemptionReasonCode, 40) || null;
    const exemptionReason = txt(r.exemptionReason, 300) || (exemptionReasonCode ? EXEMPTION_REASONS.find((e) => e.code === exemptionReasonCode)?.ar ?? null : null);
    if (opts.forIssue && rate) {
      if (taxCategory === "S" && rate.lessThanOrEqualTo(0)) p(i, "RATE_S", "البند الخاضع للنسبة الأساسية نسبته أكبر من صفر.", "A standard-rated line has a rate above zero.");
      if (taxCategory !== "S" && !rate.isZero()) p(i, "RATE_ZEO", "البند المعفى أو الصفري أو خارج النطاق نسبته صفر.", "A zero-rated, exempt or out-of-scope line has a 0% rate.");
      if (taxCategory !== "S" && !exemptionReason) p(i, "EXEMPTION_REASON", "اذكر سبب الإعفاء أو نسبة الصفر.", "State the exemption reason.");
    }
    const unit = r.unit === "KG" ? "KG" : "UNIT";
    lines.push({
      description, descriptionEn: txt(r.descriptionEn, 300) || null,
      productSkuId: idOrNull(r.productSkuId), orderItemId: idOrNull(r.orderItemId), deliveryId: idOrNull(r.deliveryId), originalLineId: idOrNull(r.originalLineId),
      skuCode: txt(r.skuCode, 60) || null,
      quantity: quantity ?? new Decimal(0), unitPrice: unitPrice ?? new Decimal(0), discountPercent: discountPercent ?? new Decimal(0),
      taxCategory, taxRatePercent: rate ?? new Decimal(0), exemptionReasonCode: taxCategory === "S" ? null : exemptionReasonCode,
      exemptionReason: taxCategory === "S" ? null : exemptionReason, unit,
    });
  });
  return { lines, problems };
}

export type BuyerParticulars = {
  name: string; nameEn: string | null; vatNumber: string | null; crNumber: string | null; otherId: string | null;
  buildingNo: string | null; street: string | null; district: string | null; city: string | null; postalCode: string | null; additionalNo: string | null;
  countryCode: string; address: string | null; phone: string | null;
};

export function parseBuyer(raw: unknown, fallback?: Partial<BuyerParticulars>): BuyerParticulars {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof BuyerParticulars, max = 120) => (k in r ? txt(r[k], max) || null : ((fallback?.[k] as string | null | undefined) ?? null));
  return {
    name: pick("name", 200) ?? "", nameEn: pick("nameEn", 200), vatNumber: normDigits(pick("vatNumber", 30) ?? "") || null, crNumber: normDigits(pick("crNumber", 30) ?? "") || null,
    otherId: pick("otherId", 40), buildingNo: pick("buildingNo", 10), street: pick("street"), district: pick("district"), city: pick("city"),
    postalCode: normDigits(pick("postalCode", 10) ?? "") || null, additionalNo: pick("additionalNo", 10), countryCode: (pick("countryCode", 2) ?? "SA").toUpperCase() || "SA",
    address: pick("address", 300), phone: pick("phone", 40),
  };
}

/** What a document needs before it can be issued (the database checks the same; this answers in words). */
export function issueProblems(input: {
  kind: InvoiceKind; family: InvoiceFamily; buyer: BuyerParticulars; seller: { name: string | null; vatNumber: string | null };
  supplyDate: string | null; lines: CleanLine[]; reasonCode: string | null; reason: string | null; grandTotal: Decimal;
}): { code: string; ar: string; en: string }[] {
  const out: { code: string; ar: string; en: string }[] = [];
  const add = (code: string, ar: string, en: string) => out.push({ code, ar, en });
  if (!input.seller.name) add("SELLER_NAME", "أدخل اسم المنشأة القانوني في إعدادات الفوترة.", "Enter the seller's legal name in the invoicing settings.");
  if (!isKsaVatNumber(input.seller.vatNumber)) add("SELLER_VAT", "أدخل الرقم الضريبي للمنشأة (15 رقمًا يبدأ وينتهي بـ 3) في إعدادات الفوترة.", "Enter the seller's VAT number (15 digits, starting and ending with 3) in the invoicing settings.");
  if (!input.buyer.name) add("BUYER_NAME", "اسم المشتري مطلوب.", "The buyer's name is required.");
  if (input.family === "STANDARD") {
    if (!isKsaVatNumber(input.buyer.vatNumber)) add("BUYER_VAT", "الفاتورة الضريبية تتطلب الرقم الضريبي للمشتري: 15 رقمًا يبدأ وينتهي بـ 3.", "A tax invoice needs the buyer's VAT number: 15 digits, starting and ending with 3.");
    if (!input.supplyDate) add("SUPPLY_DATE", "تاريخ التوريد مطلوب في الفاتورة الضريبية.", "A tax invoice states the supply date.");
  } else if (input.buyer.vatNumber && !isKsaVatNumber(input.buyer.vatNumber)) {
    add("BUYER_VAT", "الرقم الضريبي للمشتري غير صحيح: 15 رقمًا يبدأ وينتهي بـ 3.", "The buyer's VAT number is not valid: 15 digits, starting and ending with 3.");
  }
  if (input.lines.length === 0) add("NO_LINES", "أضف بندًا واحدًا على الأقل.", "Add at least one line.");
  if (input.kind !== "INVOICE") {
    if (!input.reasonCode || !(NOTE_REASONS as readonly string[]).includes(input.reasonCode)) add("REASON_CODE", "اختر سبب الإصدار.", "Choose the reason code.");
    if (!input.reason || input.reason.trim().length < 3) add("REASON", "اكتب سبب إصدار الإشعار.", "State the reason for the note.");
  }
  if (input.grandTotal.lessThanOrEqualTo(0)) add("ZERO_TOTAL", "إجمالي المستند يجب أن يكون أكبر من صفر.", "The document total must be above zero.");
  return out;
}

// ── Dates, numbers ───────────────────────────────────────────────────────────────────────────────────

const RIYADH_OFFSET_MS = 3 * 3_600_000;
/** The Riyadh calendar day ("YYYY-MM-DD") and time ("HH:MM:SS") of an instant — ZATCA IssueDate / IssueTime (AST). */
export function riyadhStamp(at: Date): { day: string; time: string } {
  const r = new Date(at.getTime() + RIYADH_OFFSET_MS).toISOString();
  return { day: r.slice(0, 10), time: r.slice(11, 19) };
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/** The document number the database will write: series-NNNNNN. */
export function formatNumber(series: string, seq: number): string {
  return `${series}-${String(seq).padStart(6, "0")}`;
}

export const SERIES_RE = /^[A-Z0-9]{1,10}$/;
export function seriesFor(kind: InvoiceKind, prefixes: { invoice?: string | null; creditNote?: string | null; debitNote?: string | null }): string {
  if (kind === "CREDIT_NOTE") return prefixes.creditNote || "CN";
  if (kind === "DEBIT_NOTE") return prefixes.debitNote || "DN";
  return prefixes.invoice || "INV";
}

/** Two-decimal text, never "-0.00". */
export const m2 = (d: Decimal | { toString(): string } | null | undefined): string => {
  if (d === null || d === undefined) return "0.00";
  const x = d instanceof Decimal ? d : new Decimal(d.toString());
  return x.isZero() ? "0.00" : x.toFixed(2);
};
