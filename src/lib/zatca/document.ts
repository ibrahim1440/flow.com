// ZATCA Phase 2 (A4) — an issued SalesInvoice (its frozen snapshot) → the UBL generator's input. Pure.
import type { UblDocument, UblParty } from "./ubl";

type Dec = { toString(): string };
export type IssuedForUbl = {
  number: string | null; uuid: string; kind: string; family: string; status: string;
  issueDate: Date | null; issueTime: string | null; supplyDate: Date | null; supplyEndDate: Date | null;
  reasonCode: string | null; reason: string | null;
  buyer: unknown; seller: unknown;
  lineExtensionTotal: Dec; taxableTotal: Dec; taxTotal: Dec; grandTotal: Dec; taxBreakdown: unknown;
  lines: { description: string; quantity: Dec; unit: string; unitPrice: Dec; discountAmount: Dec; taxCategory: string; taxRatePercent: Dec; exemptionReasonCode: string | null; exemptionReason: string | null; lineNet: Dec; lineTax: Dec; lineTotal: Dec }[];
  originalInvoice?: { number: string | null } | null;
};

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function partyOf(raw: unknown): UblParty {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    name: str(r.name) ?? "", vatNumber: str(r.vatNumber), crNumber: str(r.crNumber), otherId: str(r.otherId),
    buildingNo: str(r.buildingNo), street: str(r.street), district: str(r.district), city: str(r.city),
    postalCode: str(r.postalCode), additionalNo: str(r.additionalNo), countryCode: str(r.countryCode) ?? "SA",
  };
}

/** What a document needs before it can be signed for ZATCA, in words (the issue is refused otherwise). */
export function ublProblems(d: IssuedForUbl): { code: string; ar: string; en: string }[] {
  const out: { code: string; ar: string; en: string }[] = [];
  const s = partyOf(d.seller), b = partyOf(d.buyer);
  const add = (code: string, ar: string, en: string) => out.push({ code, ar, en });
  if (!s.street || !s.buildingNo || !s.district || !s.city || !s.postalCode) add("SELLER_ADDRESS", "أكمل العنوان الوطني للمنشأة (الشارع، رقم المبنى، الحي، المدينة، الرمز البريدي) في إعدادات الفوترة.", "Complete the seller's national address (street, building number, district, city, postal code) in the invoicing settings.");
  if (s.buildingNo && !/^\d{4}$/.test(s.buildingNo)) add("SELLER_BUILDING", "رقم مبنى المنشأة 4 أرقام.", "The seller's building number is 4 digits.");
  if (s.postalCode && !/^\d{5}$/.test(s.postalCode)) add("SELLER_POSTAL", "الرمز البريدي للمنشأة 5 أرقام.", "The seller's postal code is 5 digits.");
  if (!s.crNumber) add("SELLER_CRN", "أدخل رقم السجل التجاري (الرقم الموحد) للمنشأة في إعدادات الفوترة.", "Enter the seller's commercial registration (unified) number in the invoicing settings.");
  if (d.family === "STANDARD" && (!b.street || !b.buildingNo || !b.district || !b.city || !b.postalCode)) add("BUYER_ADDRESS", "الفاتورة الضريبية تتطلب العنوان الوطني للمشتري كاملًا (الشارع، رقم المبنى، الحي، المدينة، الرمز البريدي).", "A tax invoice needs the buyer's full national address (street, building number, district, city, postal code).");
  if (d.kind !== "INVOICE" && !d.originalInvoice?.number) add("ORIGINAL", "الإشعار يشير إلى رقم الفاتورة الأصلية.", "A note refers to the original invoice number.");
  return out;
}

export function ublInput(d: IssuedForUbl, chain: { icv: bigint; pih: string }): UblDocument {
  const breakdown = Array.isArray(d.taxBreakdown) ? (d.taxBreakdown as Record<string, unknown>[]) : [];
  return {
    number: d.number!, uuid: d.uuid, kind: d.kind as UblDocument["kind"], family: d.family as UblDocument["family"],
    issueDate: day(d.issueDate)!, issueTime: d.issueTime!, supplyDate: day(d.supplyDate), supplyEndDate: day(d.supplyEndDate),
    originalNumber: d.originalInvoice?.number ?? null, reasonCode: d.reasonCode, reason: d.reason,
    seller: partyOf(d.seller), buyer: partyOf(d.buyer),
    lines: d.lines.map((l) => ({
      description: l.description, quantity: l.quantity.toString(), unit: l.unit, unitPrice: l.unitPrice.toString(), discountAmount: l.discountAmount.toString(),
      taxCategory: l.taxCategory, taxRatePercent: l.taxRatePercent.toString(), exemptionReasonCode: l.exemptionReasonCode, exemptionReason: l.exemptionReason,
      lineNet: l.lineNet.toString(), lineTax: l.lineTax.toString(), lineTotal: l.lineTotal.toString(),
    })),
    breakdown: breakdown.map((b) => ({ category: String(b.category), rate: String(b.rate), taxable: String(b.taxable), tax: String(b.tax), exemptionReasonCode: (b.exemptionReasonCode as string | null) ?? null, exemptionReason: (b.exemptionReason as string | null) ?? null })),
    totals: { lineExtension: d.lineExtensionTotal.toString(), taxable: d.taxableTotal.toString(), tax: d.taxTotal.toString(), grand: d.grandTotal.toString() },
    icv: chain.icv, pih: chain.pih,
  };
}

export const sellerOf = (d: { seller: unknown }) => partyOf(d.seller);
