// D22 «بيع مباشر (فاتورة ضريبية بدون عرض سعر)» (owner-approved design 2010:2, 11 Nov 2026): the direct sale made from the
// tax invoice page, where the rep may change every line's price, discount and VAT category («كل شي قابل للتعديل — المحاسب
// يراجع قبل ما يصدر»). The 3-step wizard keeps the catalogue price and one sale discount (direct-sale.ts priceDirectSale);
// this file prices the invoice page's lines.
//
//   · each line is one SKU in whole units, as an order line must be (a SKU twice is refused: one line per SKU);
//   · the line's unit price (default the SKU's list price), discount % (default 0) and VAT category / rate (default S 15 %)
//     are the rep's; the arithmetic is the invoice's own (pricing.ts parseLines / priceInvoice, E-10), so the draft the
//     accountant receives carries exactly these figures;
//   · the approval (owner, 11 Nov 2026: one 45 % threshold for quotations and direct sales, SystemConfig
//     .quoteDiscountApprovalPercent) is decided on the EFFECTIVE discount of each line against its list value —
//     1 − lineNet ÷ (list price × units) — so a price typed below the list is a discount like any other. The sale waits
//     when any line's effective discount is above the threshold and the rep cannot approve it; above DISCOUNT_MAX it is
//     refused (no approval passes the ceiling).
import { latinNumberText, normalizeTypedNumber } from "@/lib/numbers/typed-number";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { DEFAULT_VAT_RATE, EXEMPTION_REASONS, parseLines, priceInvoice, type RawLine } from "@/lib/services/invoicing/pricing";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

/**
 * Who may ASK for a VAT-treatment change on a draft (P0 C5: sales › invoice_tax_override — the authorised finance officer).
 * Asking is all it gives: the change applies only once a second person (sales › invoice_tax_override_approve, never the
 * requester) approves it (tax-override.ts). D22's direct change by the holder is gone (owner, 11 Nov 2026).
 */
export const mayOverrideTax = (permissions: Permissions | Record<string, unknown>) => hasSubPrivilege(permissions as Permissions, "sales", "invoice_tax_override");

/** The refusal of a non-standard line (C6 wording). */
export const taxLocked = (i: number) => refuse(400, "TAX_LOCKED",
  `البند ${i + 1}: الضريبة «أساسية ${DEFAULT_VAT_RATE}٪» ثابتة — تغييرها يكون بطلب على المسودة مع سببه، ويوافق عليه شخص ثاني.`,
  `Line ${i + 1}: VAT is a fixed standard ${DEFAULT_VAT_RATE}% — a change is a request on the draft, with its reason, approved by a second person.`, { index: i });

/**
 * Every line S at the default rate (DEFAULT_VAT_RATE) unless `approved(line, index)` says an approved override covers it
 * (an existing draft's — tax-override.ts). A new document has none: anything else is REFUSED (400 TAX_LOCKED), never
 * silently changed. Pure.
 */
export function assertTaxAllowed(terms: { taxCategory: string; taxRatePercent: string; exemptionReasonCode?: string | null }[], approved: (index: number) => boolean = () => false): void {
  const i = terms.findIndex((t, k) => !isStandard(t) && !approved(k));
  if (i >= 0) throw taxLocked(i);
}
import { DISCOUNT_MAX } from "./discount-limits";
import { aboveCeiling, aboveLimit, percentToBp } from "./discount-measure";
import { effectiveDiscount, isStandard } from "./discount-rules";
export { effectiveDiscount } from "./discount-rules";

type Db = Prisma.TransactionClient | typeof prisma;
/** The same cap as the wizard (direct-sale.ts MAX_DIRECT_SALE_LINES). */
const MAX_DIRECT_SALE_LINES = 50;

export type LineTerms = {
  productSkuId: string; quantityUnits: number; unitPrice: string; discountPercent: string;
  taxCategory: "S" | "Z" | "E" | "O"; taxRatePercent: string; exemptionReasonCode: string | null;
};
/** The invoice header the rep filled on the page (all optional: the draft's defaults apply). */
export type SaleHeader = { family: "STANDARD" | "SIMPLIFIED" | null; buyer: Record<string, unknown> | null; supplyDate: string | null; paymentTermsDays: string | null; notes: string | null; branchId: string | null | undefined };
/** dealId (D22, أبو فهد B2): the deal the rep chose in «تربطه بصفقة؟» — a string joins that OPEN deal (it is won), null opens a
 *  new WON deal; absent (a sale recorded before the picker) keeps the old link (the customer's newest open deal). */
export type SaleTerms = { lines: LineTerms[]; header: SaleHeader; dealId?: string | null };

export type TermsQuote = {
  lines: { productSkuId: string; skuCode: string; name: string; listPrice: string; unitPrice: string; quantityUnits: number; discountPercent: string; lineGross: string; lineNet: string; effectiveDiscount: string; taxCategory: LineTerms["taxCategory"]; taxRatePercent: string }[];
  subtotal: string; discount: string; net: string; tax: string; gross: string;
  /** The highest line's effective discount against the list (the figure the approval is decided on). */
  discountPercent: string;
  threshold: number; max: number;
};

const refuse = (status: number, code: string, ar: string, en: string, extra: Record<string, unknown> = {}) =>
  ({ _appCode: status, code, message: ar, errorAr: ar, error: ar, errorEn: en, ...extra });
const CATS = ["S", "Z", "E", "O"] as const;
const money2 = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(latinNumberText(String(v))); // P2 ERR-17: the one reading
  return Number.isFinite(n) ? String(n) : "x";
};

/** Does this request carry invoice-page terms (any line with a price / discount / tax, or a header)? Pure. */
export function hasTerms(input: { lines?: unknown; invoice?: unknown }): boolean {
  if (input.invoice && typeof input.invoice === "object") return true;
  return Array.isArray(input.lines) && input.lines.some((l) => l && typeof l === "object" && ["unitPrice", "discountPercent", "taxCategory", "taxRatePercent"].some((k) => k in (l as object)));
}

/** The header as given (strings trimmed; nothing validated here — the draft validates it as any draft). Pure. */
export function parseHeader(raw: unknown): SaleHeader {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) || null : typeof v === "number" ? String(v) : null);
  return {
    family: r.family === "SIMPLIFIED" ? "SIMPLIFIED" : r.family === "STANDARD" ? "STANDARD" : null,
    buyer: r.buyer && typeof r.buyer === "object" && !Array.isArray(r.buyer) ? (r.buyer as Record<string, unknown>) : null,
    supplyDate: str(r.supplyDate, 10), paymentTermsDays: str(r.paymentTermsDays, 3), notes: str(r.notes, 2000),
    // "" / absent = the default location; null = «غير محدد»; an id = that location (the draft checks it).
    branchId: r.branchId === undefined || r.branchId === "" ? undefined : r.branchId === null ? null : String(r.branchId),
  };
}

/** The lines as terms: one SKU per line, whole units, the rep's price / discount / VAT (defaults filled from the SKU). */
export function parseLineTerms(raw: unknown, list: Map<string, { price: number }>, defaultDiscount = "0"): LineTerms[] {
  if (!Array.isArray(raw) || raw.length === 0) throw refuse(400, "NO_LINES", "أضف صنف واحد على الأقل.", "Add at least one item.");
  if (raw.length > MAX_DIRECT_SALE_LINES) throw refuse(400, "TOO_MANY_LINES", `الحد ${MAX_DIRECT_SALE_LINES} صنف.`, `At most ${MAX_DIRECT_SALE_LINES} items.`);
  const seen = new Set<string>();
  return raw.map((l0, i) => {
    const l = (l0 ?? {}) as Record<string, unknown>;
    const id = typeof l.productSkuId === "string" ? l.productSkuId.trim() : "";
    if (!id) throw refuse(400, "LINE_INVALID", `البند ${i + 1}: اختر الصنف.`, `Line ${i + 1}: choose the product.`, { index: i });
    if (seen.has(id)) throw refuse(400, "DUPLICATE_SKU", `البند ${i + 1}: الصنف مكرر — زِد الكمية في بنده بدل ما تكرره.`, `Line ${i + 1}: the product is repeated — raise the quantity on its line instead.`, { index: i });
    seen.add(id);
    const units = Number(normalizeTypedNumber(l.quantityUnits ?? l.quantity)); // P2 ERR-17
    if (!Number.isInteger(units) || units <= 0 || units > 100000) throw refuse(400, "QTY_INVALID", `البند ${i + 1}: الكمية لازم رقم صحيح أكبر من صفر.`, `Line ${i + 1}: the quantity must be a whole number above zero.`, { index: i });
    const sku = list.get(id);
    const price = money2(l.unitPrice);
    const disc = money2(l.discountPercent);
    const cat = (CATS as readonly string[]).includes(String(l.taxCategory)) ? (l.taxCategory as LineTerms["taxCategory"]) : "S";
    const rate = money2(l.taxRatePercent);
    return {
      productSkuId: id, quantityUnits: units,
      unitPrice: price ?? (sku ? sku.price.toFixed(2) : "0"),
      discountPercent: disc ?? defaultDiscount,
      taxCategory: cat, taxRatePercent: cat === "S" ? rate ?? "15" : "0",
      exemptionReasonCode: cat === "S" ? null : typeof l.exemptionReasonCode === "string" && l.exemptionReasonCode ? l.exemptionReasonCode : EXEMPTION_REASONS.find((x) => x.category === cat)?.code ?? null,
    };
  });
}

/** The invoice lines of the terms (what the draft will hold), for pricing.ts. Pure. */
export function invoiceRawLines(terms: LineTerms[], names: Map<string, { name: string; skuCode: string }>): RawLine[] {
  return terms.map((t) => ({
    description: names.get(t.productSkuId)?.name ?? t.productSkuId, skuCode: names.get(t.productSkuId)?.skuCode ?? null, productSkuId: t.productSkuId,
    quantity: String(t.quantityUnits), unit: "UNIT", unitPrice: t.unitPrice, discountPercent: t.discountPercent,
    taxCategory: t.taxCategory, taxRatePercent: t.taxRatePercent, exemptionReasonCode: t.exemptionReasonCode,
  })) as unknown as RawLine[];
}


/** The price of a direct sale's terms — the invoice arithmetic, line by line, and the approval figure. */
export async function priceTerms(db: Db, raw: unknown, threshold: Prisma.Decimal, defaultDiscount = "0"): Promise<{ quote: TermsQuote; terms: LineTerms[] }> {
  const ids = Array.isArray(raw) ? raw.map((l) => (l && typeof (l as { productSkuId?: unknown }).productSkuId === "string" ? (l as { productSkuId: string }).productSkuId.trim() : "")).filter(Boolean) : [];
  const skus = await db.productSKU.findMany({
    where: { id: { in: ids } },
    select: { id: true, skuCode: true, name: true, nameAr: true, price: true, isActive: true, product: { select: { productNameAr: true, productNameEn: true } } },
  });
  const byId = new Map(skus.map((s) => [s.id, s]));
  const terms = parseLineTerms(raw, new Map(skus.map((s) => [s.id, { price: s.price }])), defaultDiscount);
  assertTaxAllowed(terms);
  for (const t of terms) {
    const s = byId.get(t.productSkuId);
    if (!s || !s.isActive) throw refuse(400, "SKU_UNAVAILABLE", "صنف غير متاح للبيع.", "A product is not available for sale.", { productSkuId: t.productSkuId });
    if (!(s.price > 0)) throw refuse(409, "NO_PRICE", `«${s.nameAr || s.name || s.skuCode}» ما له سعر في قائمة الأسعار.`, `"${s.skuCode}" has no list price.`, { productSkuId: t.productSkuId });
  }
  const names = new Map(skus.map((s) => [s.id, { name: s.nameAr || s.name || s.product.productNameAr || s.product.productNameEn, skuCode: s.skuCode }]));
  const { lines, problems } = parseLines(invoiceRawLines(terms, names));
  if (problems.length) {
    const p = problems[0];
    throw refuse(400, "LINES_INVALID", `${p.index >= 0 ? `البند ${p.index + 1}: ` : ""}${p.ar}`, `${p.index >= 0 ? `Line ${p.index + 1}: ` : ""}${p.en}`, { problems });
  }
  const priced = priceInvoice(lines);
  let top = new Prisma.Decimal(0);
  const out = terms.map((t, i) => {
    const s = byId.get(t.productSkuId)!;
    const list = new Prisma.Decimal(s.price.toFixed(2));
    const listGross = list.times(t.quantityUnits).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const net = new Prisma.Decimal(priced.lines[i].lineNet.toFixed(2));
    const eff = effectiveDiscount(listGross, net);
    if (eff.greaterThan(top)) top = eff;
    const lineGross = new Prisma.Decimal(priced.lines[i].lineNet.plus(priced.lines[i].discountAmount).toFixed(2));
    return {
      productSkuId: t.productSkuId, skuCode: s.skuCode, name: names.get(t.productSkuId)!.name, listPrice: list.toFixed(2), unitPrice: new Prisma.Decimal(t.unitPrice).toFixed(2),
      quantityUnits: t.quantityUnits, discountPercent: new Prisma.Decimal(t.discountPercent).toFixed(2), lineGross: lineGross.toFixed(2), lineNet: net.toFixed(2),
      effectiveDiscount: eff.toFixed(2), taxCategory: t.taxCategory, taxRatePercent: new Prisma.Decimal(t.taxRatePercent).toFixed(2),
    };
  });
  const subtotal = out.reduce((a, l) => a.plus(l.lineGross), new Prisma.Decimal(0));
  return {
    terms,
    quote: {
      lines: out, subtotal: subtotal.toFixed(2), discount: priced.discountTotal.toFixed(2), net: priced.taxableTotal.toFixed(2),
      tax: priced.taxTotal.toFixed(2), gross: priced.grandTotal.toFixed(2), discountPercent: top.toFixed(2),
      threshold: Number(threshold.toString()), max: DISCOUNT_MAX,
    },
  };
}

/** The approval on terms: refused above the ceiling; waits above the threshold for a rep who cannot approve. Pure. */
export function termsApproval(quote: TermsQuote, threshold: Prisma.Decimal, mayApprove: boolean): { percent: Prisma.Decimal; needsApproval: boolean } {
  const top = new Prisma.Decimal(quote.discountPercent);
  // HOTFIX quote-45: the one fixed-point comparison (discount-measure.ts) — strictly above, in basis points.
  if (aboveCeiling(percentToBp(top.toFixed(2)))) {
    const i = quote.lines.findIndex((l) => aboveCeiling(percentToBp(l.effectiveDiscount)));
    throw refuse(400, "DISCOUNT_TOO_HIGH", `البند ${i + 1}: الخصم ${quote.lines[i].effectiveDiscount}٪ من سعر القائمة — أعلى خصم ${DISCOUNT_MAX}٪.`, `Line ${i + 1}: ${quote.lines[i].effectiveDiscount}% off the list price — the most is ${DISCOUNT_MAX}%.`, { index: i });
  }
  return { percent: top, needsApproval: aboveLimit(percentToBp(top.toFixed(2)), threshold.toString()) && !mayApprove };
}
