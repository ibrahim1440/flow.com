// ZATCA Phase 2 (A4) — the UBL 2.1 document of an ISSUED invoice / credit note / debit note (E-Invoicing XML
// Implementation Standard; the KSA extensions as the SDK 238-R3.2.7 samples carry them). Built ONLY from the frozen
// issued snapshot (seller / buyer JSON, lines, totals): never from live master data (E-4).
//
//   ProfileID reporting:1.0 · ID = the document number · UUID = SalesInvoice.uuid · IssueDate / IssueTime (AST)
//   · InvoiceTypeCode 388 / 381 / 383 with @name 0100000 (standard) / 0200000 (simplified)
//   · DocumentCurrencyCode / TaxCurrencyCode SAR · BillingReference (notes: the original's number)
//   · AdditionalDocumentReference ICV (cbc:UUID = the counter), PIH (the previous hash), QR (filled at stamping)
//   · cac:Signature · seller (CRN, national address, VAT, legal name) · buyer · Delivery (KSA-5 supply date,
//   KSA-24 end) · PaymentMeans (notes: InstructionNote = the reason, KSA-10) · TaxTotal twice (the document's VAT;
//   then the subtotals per category and rate, VAT = round(taxable × rate) once — E-10) · LegalMonetaryTotal
//   · InvoiceLine (quantity, net amount, line VAT KSA-11 and amount with VAT KSA-12, the item and its tax
//   category, the unit price and the line discount as a price-level allowance).
// The two markers of ./sign stand where the signature extension and the QR value go.
import { EXT_MARKER, QR_MARKER } from "./sign";

export const INITIAL_PIH = "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";
export const TYPE_CODE: Record<string, string> = { INVOICE: "388", CREDIT_NOTE: "381", DEBIT_NOTE: "383" };
export const SUBTYPE: Record<string, string> = { STANDARD: "0100000", SIMPLIFIED: "0200000" };
const UNIT_CODE: Record<string, string> = { UNIT: "PCE", KG: "KGM" };
/** KSA-10 text by reason code (the free reason follows it). */
const REASON_TEXT: Record<string, string> = {
  RETURN: "Goods returned", PRICE_ADJUSTMENT: "Price adjustment", DISCOUNT: "Discount after issue",
  CANCELLATION: "Cancellation or termination", AMENDMENT: "Amendment of the supply", OTHER: "Other",
};

export type UblParty = {
  name: string; vatNumber: string | null; crNumber?: string | null; otherId?: string | null;
  buildingNo?: string | null; street?: string | null; district?: string | null; city?: string | null; postalCode?: string | null; additionalNo?: string | null; countryCode?: string | null;
};
export type UblLine = {
  description: string; quantity: string; unit: string; unitPrice: string; discountAmount: string;
  taxCategory: string; taxRatePercent: string; exemptionReasonCode?: string | null; exemptionReason?: string | null;
  lineNet: string; lineTax: string; lineTotal: string;
};
export type UblBreakdown = { category: string; rate: string; taxable: string; tax: string; exemptionReasonCode?: string | null; exemptionReason?: string | null };
export type UblDocument = {
  number: string; uuid: string; kind: "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE"; family: "STANDARD" | "SIMPLIFIED";
  issueDate: string; issueTime: string; supplyDate?: string | null; supplyEndDate?: string | null;
  originalNumber?: string | null; reasonCode?: string | null; reason?: string | null;
  seller: UblParty; buyer: UblParty;
  lines: UblLine[]; breakdown: UblBreakdown[];
  totals: { lineExtension: string; taxable: string; tax: string; grand: string };
  icv: bigint | number | string; pih: string;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const amt = (v: string) => Number(v).toFixed(2);
const pct = (v: string) => Number(v).toFixed(2);
const qty = (v: string) => Number(v).toFixed(3);
const el = (tag: string, value: string | null | undefined, ind: string, attrs = "") => (value === null || value === undefined || value === "" ? "" : `${ind}<${tag}${attrs}>${esc(value)}</${tag}>\n`);

function address(p: UblParty, ind: string): string {
  return `${ind}<cac:PostalAddress>\n` +
    el("cbc:StreetName", p.street, ind + "    ") +
    el("cbc:BuildingNumber", p.buildingNo, ind + "    ") +
    el("cbc:PlotIdentification", p.additionalNo, ind + "    ") +
    el("cbc:CitySubdivisionName", p.district, ind + "    ") +
    el("cbc:CityName", p.city, ind + "    ") +
    el("cbc:PostalZone", p.postalCode, ind + "    ") +
    `${ind}    <cac:Country>\n${ind}        <cbc:IdentificationCode>${esc(p.countryCode || "SA")}</cbc:IdentificationCode>\n${ind}    </cac:Country>\n` +
    `${ind}</cac:PostalAddress>\n`;
}

function party(p: UblParty, role: "seller" | "buyer"): string {
  const i = "            ";
  const id = p.crNumber ? `${i}<cac:PartyIdentification>\n${i}    <cbc:ID schemeID="CRN">${esc(p.crNumber)}</cbc:ID>\n${i}</cac:PartyIdentification>\n`
    : p.otherId ? `${i}<cac:PartyIdentification>\n${i}    <cbc:ID schemeID="OTH">${esc(p.otherId)}</cbc:ID>\n${i}</cac:PartyIdentification>\n` : "";
  const hasAddress = role === "seller" || !!(p.street || p.city || p.buildingNo || p.postalCode || p.district);
  const tax = role === "seller" || p.vatNumber
    ? `${i}<cac:PartyTaxScheme>\n` + el("cbc:CompanyID", p.vatNumber, i + "    ") + `${i}    <cac:TaxScheme>\n${i}        <cbc:ID>VAT</cbc:ID>\n${i}    </cac:TaxScheme>\n${i}</cac:PartyTaxScheme>\n`
    : "";
  return `        <cac:Party>\n${id}${hasAddress ? address(p, i) : ""}${tax}${i}<cac:PartyLegalEntity>\n${i}    <cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName>\n${i}</cac:PartyLegalEntity>\n        </cac:Party>\n`;
}

function taxCategory(tag: "cac:TaxCategory" | "cac:ClassifiedTaxCategory", c: { category: string; rate: string; exemptionReasonCode?: string | null; exemptionReason?: string | null }, ind: string, scheme: boolean): string {
  const s5305 = scheme ? ` schemeID="UN/ECE 5305" schemeAgencyID="6"` : "";
  const s5153 = scheme ? ` schemeID="UN/ECE 5153" schemeAgencyID="6"` : "";
  const exempt = c.category !== "S" && tag === "cac:TaxCategory"
    ? el("cbc:TaxExemptionReasonCode", c.exemptionReasonCode, ind + "    ") + el("cbc:TaxExemptionReason", c.exemptionReason, ind + "    ")
    : "";
  return `${ind}<${tag}>\n${ind}    <cbc:ID${s5305}>${esc(c.category)}</cbc:ID>\n${ind}    <cbc:Percent>${pct(c.rate)}</cbc:Percent>\n${exempt}${ind}    <cac:TaxScheme>\n${ind}        <cbc:ID${s5153}>VAT</cbc:ID>\n${ind}    </cac:TaxScheme>\n${ind}</${tag}>\n`;
}

/** The UBL text, with the signature-extension and QR markers in place (./sign fills them). */
export function buildUbl(d: UblDocument): string {
  const C = ` currencyID="SAR"`;
  const note = d.kind !== "INVOICE";
  const instruction = note ? [REASON_TEXT[d.reasonCode ?? "OTHER"] ?? "Other", d.reason?.trim()].filter(Boolean).join(": ").slice(0, 1000) : null;
  const lines = d.lines.map((l, idx) => {
    const disc = Number(l.discountAmount) > 0;
    return `    <cac:InvoiceLine>
        <cbc:ID>${idx + 1}</cbc:ID>
        <cbc:InvoicedQuantity unitCode="${UNIT_CODE[l.unit] ?? "PCE"}">${qty(l.quantity)}</cbc:InvoicedQuantity>
        <cbc:LineExtensionAmount${C}>${amt(l.lineNet)}</cbc:LineExtensionAmount>
${disc ? `        <cac:AllowanceCharge>
            <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
            <cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode>
            <cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason>
            <cbc:Amount${C}>${amt(l.discountAmount)}</cbc:Amount>
        </cac:AllowanceCharge>
` : ""}        <cac:TaxTotal>
            <cbc:TaxAmount${C}>${amt(l.lineTax)}</cbc:TaxAmount>
            <cbc:RoundingAmount${C}>${amt(l.lineTotal)}</cbc:RoundingAmount>
        </cac:TaxTotal>
        <cac:Item>
            <cbc:Name>${esc(l.description)}</cbc:Name>
${taxCategory("cac:ClassifiedTaxCategory", { category: l.taxCategory, rate: l.taxRatePercent }, "            ", false)}        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount${C}>${amt(l.unitPrice)}</cbc:PriceAmount>
        </cac:Price>
    </cac:InvoiceLine>
`;
  }).join("");
  const subtotals = d.breakdown.map((b) => `        <cac:TaxSubtotal>
            <cbc:TaxableAmount${C}>${amt(b.taxable)}</cbc:TaxableAmount>
            <cbc:TaxAmount${C}>${amt(b.tax)}</cbc:TaxAmount>
${taxCategory("cac:TaxCategory", b, "            ", true)}        </cac:TaxSubtotal>
`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">${EXT_MARKER}
    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>${esc(d.number)}</cbc:ID>
    <cbc:UUID>${esc(d.uuid)}</cbc:UUID>
    <cbc:IssueDate>${d.issueDate}</cbc:IssueDate>
    <cbc:IssueTime>${d.issueTime}</cbc:IssueTime>
    <cbc:InvoiceTypeCode name="${SUBTYPE[d.family]}">${TYPE_CODE[d.kind]}</cbc:InvoiceTypeCode>
    <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
    <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
${note && d.originalNumber ? `    <cac:BillingReference>
        <cac:InvoiceDocumentReference>
            <cbc:ID>${esc(d.originalNumber)}</cbc:ID>
        </cac:InvoiceDocumentReference>
    </cac:BillingReference>
` : ""}    <cac:AdditionalDocumentReference>
        <cbc:ID>ICV</cbc:ID>
        <cbc:UUID>${String(d.icv)}</cbc:UUID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>PIH</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${d.pih}</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>QR</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${QR_MARKER}</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:Signature>
        <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
        <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
    </cac:Signature>
    <cac:AccountingSupplierParty>
${party(d.seller, "seller")}    </cac:AccountingSupplierParty>
    <cac:AccountingCustomerParty>
${party(d.buyer, "buyer")}    </cac:AccountingCustomerParty>
${d.supplyDate ? `    <cac:Delivery>
        <cbc:ActualDeliveryDate>${d.supplyDate}</cbc:ActualDeliveryDate>
${d.supplyEndDate ? `        <cbc:LatestDeliveryDate>${d.supplyEndDate}</cbc:LatestDeliveryDate>\n` : ""}    </cac:Delivery>
` : ""}    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>1</cbc:PaymentMeansCode>
${instruction ? `        <cbc:InstructionNote>${esc(instruction)}</cbc:InstructionNote>\n` : ""}    </cac:PaymentMeans>
    <cac:TaxTotal>
        <cbc:TaxAmount${C}>${amt(d.totals.tax)}</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:TaxTotal>
        <cbc:TaxAmount${C}>${amt(d.totals.tax)}</cbc:TaxAmount>
${subtotals}    </cac:TaxTotal>
    <cac:LegalMonetaryTotal>
        <cbc:LineExtensionAmount${C}>${amt(d.totals.lineExtension)}</cbc:LineExtensionAmount>
        <cbc:TaxExclusiveAmount${C}>${amt(d.totals.taxable)}</cbc:TaxExclusiveAmount>
        <cbc:TaxInclusiveAmount${C}>${amt(d.totals.grand)}</cbc:TaxInclusiveAmount>
        <cbc:AllowanceTotalAmount${C}>0.00</cbc:AllowanceTotalAmount>
        <cbc:PrepaidAmount${C}>0.00</cbc:PrepaidAmount>
        <cbc:PayableAmount${C}>${amt(d.totals.grand)}</cbc:PayableAmount>
    </cac:LegalMonetaryTotal>
${lines}</Invoice>
`;
}
