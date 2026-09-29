// E-invoice document (stage 6): UBL 2.1 XML, the document hash, the QR code (TLV, base64) and a
// LOCAL test signature. Pure: no database, no network.
//
// What this follows, and how far it is verified (STAGE_6_DESIGN.md §2): the element structure is
// our reading of ZATCA's "Electronic Invoice XML Implementation Standard" v1.2 (2023-05-19) and the
// "Security Features Implementation Standards" v1.2, whose titles, versions and URLs were confirmed
// on zatca.gov.sa by search; their contents could not be read from this environment (egress
// blocked). So:
//   - the hash is SHA-256 (base64) of our deterministic serialisation with the signature parts and
//     the QR reference left out — byte equivalence with the standard's C14N 1.1 canonical form is
//     UNVERIFIED;
//   - the signature is ECDSA (secp256k1, SHA-256) with a LOCAL TEST KEY, carried in a simplified
//     UBL extension — it is NOT a XAdES signature and NOT made with a ZATCA-issued CSID;
//   - QR tags 1–8 are produced; tag 9 (the signature of the ZATCA certificate) cannot exist without
//     a certificate and is omitted.
// Only the official SDK / Fatoora validation can confirm conformance. Nothing here claims it.
import { createHash, createPublicKey, sign as ecSign, verify as ecVerify, type KeyObject } from "node:crypto";

export type Address = { street: string; buildingNo: string; district: string; city: string; postalCode: string; countryCode: string };
export type Party = { name: string; vatNumber?: string | null; crNumber?: string | null; address?: Partial<Address> | null };
export type TaxCat = "S" | "Z" | "E" | "O";
export type EDocLine = { no: number; name: string; quantity: string; unitPrice: string; discountPercent: string; net: string; vatRate: string; vat: string; category: TaxCat; exemptionCode?: string | null; exemptionReason?: string | null };
export type EDoc = {
  id: string; uuid: string; icv: number; previousHash: string;
  issueDate: string; issueTime: string; supplyDate?: string | null;
  typeCode: "388" | "381" | "383"; subtype: "0100000" | "0200000"; currency: string;
  billingReference?: string | null; reason?: string | null;
  seller: Party & { vatNumber: string; crNumber: string; address: Address }; buyer: Party;
  lines: EDocLine[];
  totals: { lineExtension: string; taxExclusive: string; tax: string; taxInclusive: string; prepaid: string; payable: string };
};

/** The initial previous-invoice hash for the first document of an EGS: base64 of the hex SHA-256 of "0" (as we read the standard; unverified). */
export const INITIAL_PIH = Buffer.from(createHash("sha256").update("0").digest("hex")).toString("base64");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const amt = (v: string) => Number(v).toFixed(2);
const el = (tag: string, body: string, attrs = "") => `<${tag}${attrs}>${body}</${tag}>`;
const cbc = (tag: string, v: string | number, attrs = "") => el(`cbc:${tag}`, esc(String(v)), attrs);
const money = (tag: string, v: string, cur: string) => cbc(tag, amt(v), ` currencyID="${cur}"`);

function party(p: Party, supplier: boolean) {
  const a = p.address ?? {};
  const ids = supplier && p.crNumber ? el("cac:PartyIdentification", cbc("ID", p.crNumber, ' schemeID="CRN"')) : "";
  const addr = el("cac:PostalAddress", [a.street && cbc("StreetName", a.street), a.buildingNo && cbc("BuildingNumber", a.buildingNo), a.district && cbc("CitySubdivisionName", a.district),
    a.city && cbc("CityName", a.city), a.postalCode && cbc("PostalZone", a.postalCode), el("cac:Country", cbc("IdentificationCode", a.countryCode ?? "SA"))].filter(Boolean).join(""));
  const tax = p.vatNumber ? el("cac:PartyTaxScheme", cbc("CompanyID", p.vatNumber) + el("cac:TaxScheme", cbc("ID", "VAT"))) : "";
  return el("cac:Party", ids + addr + tax + el("cac:PartyLegalEntity", cbc("RegistrationName", p.name)));
}

function subtotals(d: EDoc) {
  const m = new Map<string, { cat: TaxCat; rate: string; taxable: number; tax: number; code?: string | null; reason?: string | null }>();
  for (const l of d.lines) {
    const k = `${l.category}|${Number(l.vatRate).toFixed(2)}|${l.exemptionCode ?? ""}`;
    const s = m.get(k) ?? { cat: l.category, rate: Number(l.vatRate).toFixed(2), taxable: 0, tax: 0, code: l.exemptionCode, reason: l.exemptionReason };
    s.taxable = Math.round((s.taxable + Number(l.net)) * 100) / 100; s.tax = Math.round((s.tax + Number(l.vat)) * 100) / 100; m.set(k, s);
  }
  return [...m.values()];
}
export { subtotals as taxSubtotals };

/** The XML. `parts` controls what is included: the hash is computed with neither the signature nor the QR. */
export function buildXml(d: EDoc, parts: { signature?: { value: string; publicKey: string } | null; qr?: string | null } = {}) {
  const cur = d.currency;
  const ext = parts.signature
    ? el("ext:UBLExtensions", el("ext:UBLExtension", cbc("ExtensionURI", "urn:local:test-signature") + el("ext:ExtensionContent",
      `<!-- LOCAL TEST SIGNATURE: ECDSA secp256k1 over the document hash with a local test key; not XAdES, not a ZATCA CSID -->` +
      el("local:TestSignature", el("local:SignatureValue", parts.signature.value) + el("local:PublicKey", parts.signature.publicKey), ' xmlns:local="urn:local:test-signature"'))))
    : "";
  const refs = [
    el("cac:AdditionalDocumentReference", cbc("ID", "ICV") + cbc("UUID", d.icv)),
    el("cac:AdditionalDocumentReference", cbc("ID", "PIH") + el("cac:Attachment", cbc("EmbeddedDocumentBinaryObject", d.previousHash, ' mimeCode="text/plain"'))),
    ...(parts.qr ? [el("cac:AdditionalDocumentReference", cbc("ID", "QR") + el("cac:Attachment", cbc("EmbeddedDocumentBinaryObject", parts.qr, ' mimeCode="text/plain"')))] : []),
  ].join("");
  const sig = parts.signature ? el("cac:Signature", cbc("ID", "urn:oasis:names:specification:ubl:signature:Invoice") + cbc("SignatureMethod", "urn:oasis:names:specification:ubl:dsig:enveloped:xades")) : "";
  const subs = subtotals(d);
  const taxTotal = el("cac:TaxTotal", money("TaxAmount", d.totals.tax, cur) + subs.map((s) => el("cac:TaxSubtotal",
    money("TaxableAmount", String(s.taxable), cur) + money("TaxAmount", String(s.tax), cur) + el("cac:TaxCategory",
      cbc("ID", s.cat, ' schemeID="UN/ECE 5305" schemeAgencyID="6"') + cbc("Percent", s.rate) + (s.code ? cbc("TaxExemptionReasonCode", s.code) : "") + (s.reason ? cbc("TaxExemptionReason", s.reason) : "") +
      el("cac:TaxScheme", cbc("ID", "VAT", ' schemeID="UN/ECE 5153" schemeAgencyID="6"'))))).join(""));
  const lines = d.lines.map((l) => el("cac:InvoiceLine",
    cbc("ID", l.no) + cbc("InvoicedQuantity", Number(l.quantity).toString(), ' unitCode="PCE"') + money("LineExtensionAmount", l.net, cur) +
    el("cac:TaxTotal", money("TaxAmount", l.vat, cur) + money("RoundingAmount", String(Math.round((Number(l.net) + Number(l.vat)) * 100) / 100), cur)) +
    el("cac:Item", cbc("Name", l.name) + el("cac:ClassifiedTaxCategory", cbc("ID", l.category) + cbc("Percent", Number(l.vatRate).toFixed(2)) + el("cac:TaxScheme", cbc("ID", "VAT")))) +
    el("cac:Price", money("PriceAmount", l.unitPrice, cur) + (Number(l.discountPercent) > 0 ? el("cac:AllowanceCharge", cbc("ChargeIndicator", "false") + cbc("AllowanceChargeReason", "discount") + cbc("MultiplierFactorNumeric", l.discountPercent)) : "")))).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">` +
    ext + cbc("ProfileID", "reporting:1.0") + cbc("ID", d.id) + cbc("UUID", d.uuid) + cbc("IssueDate", d.issueDate) + cbc("IssueTime", d.issueTime) +
    cbc("InvoiceTypeCode", d.typeCode, ` name="${d.subtype}"`) + cbc("DocumentCurrencyCode", cur) + cbc("TaxCurrencyCode", "SAR") +
    (d.billingReference ? el("cac:BillingReference", el("cac:InvoiceDocumentReference", cbc("ID", d.billingReference))) : "") +
    refs + sig +
    el("cac:AccountingSupplierParty", party(d.seller, true)) + el("cac:AccountingCustomerParty", party(d.buyer, false)) +
    (d.supplyDate ? el("cac:Delivery", cbc("ActualDeliveryDate", d.supplyDate)) : "") +
    (d.reason ? el("cac:PaymentMeans", cbc("PaymentMeansCode", "10") + cbc("InstructionNote", d.reason)) : "") +
    taxTotal + el("cac:TaxTotal", money("TaxAmount", d.totals.tax, "SAR")) +
    el("cac:LegalMonetaryTotal", money("LineExtensionAmount", d.totals.lineExtension, cur) + money("TaxExclusiveAmount", d.totals.taxExclusive, cur) +
      money("TaxInclusiveAmount", d.totals.taxInclusive, cur) + money("PrepaidAmount", d.totals.prepaid, cur) + money("PayableAmount", d.totals.payable, cur)) +
    lines + `</Invoice>`;
}

/** SHA-256 (base64) of the document without the signature and QR parts. */
export function documentHash(d: EDoc) {
  return createHash("sha256").update(buildXml(d, {}), "utf8").digest("base64");
}

/** Remove the signature and QR parts from a stored XML — for re-checking a stored document's hash. */
export function hashOfStoredXml(xml: string) {
  const stripped = xml
    .replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/, "")
    .replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, "")
    .replace(/<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/, "");
  return createHash("sha256").update(stripped, "utf8").digest("base64");
}

/** QR: TLV (tag byte, length byte, UTF-8 or raw bytes), base64. Tags 1–5 always; 6–8 when signed. */
export function qrTlv(fields: { sellerName: string; vatNumber: string; timestamp: string; total: string; vat: string; hash?: string; signature?: string; publicKey?: Buffer }) {
  const parts: [number, Buffer][] = [
    [1, Buffer.from(fields.sellerName, "utf8")], [2, Buffer.from(fields.vatNumber, "utf8")], [3, Buffer.from(fields.timestamp, "utf8")],
    [4, Buffer.from(fields.total, "utf8")], [5, Buffer.from(fields.vat, "utf8")],
    ...(fields.hash ? [[6, Buffer.from(fields.hash, "utf8")] as [number, Buffer]] : []),
    ...(fields.signature ? [[7, Buffer.from(fields.signature, "utf8")] as [number, Buffer]] : []),
    ...(fields.publicKey ? [[8, fields.publicKey] as [number, Buffer]] : []),
  ];
  const out: Buffer[] = [];
  for (const [tag, v] of parts) {
    if (v.length > 255) throw new Error(`QR tag ${tag} is longer than 255 bytes.`);
    out.push(Buffer.from([tag, v.length]), v);
  }
  return Buffer.concat(out).toString("base64");
}

export function readQr(b64: string) {
  const buf = Buffer.from(b64, "base64");
  const out: Record<number, Buffer> = {};
  for (let i = 0; i < buf.length;) { const tag = buf[i], len = buf[i + 1]; out[tag] = buf.subarray(i + 2, i + 2 + len); i += 2 + len; }
  return out;
}

/** ECDSA (secp256k1, SHA-256) over the document hash with a LOCAL TEST key. */
export function signLocally(hash: string, privateKey: KeyObject) {
  const signature = ecSign("sha256", Buffer.from(hash, "utf8"), privateKey).toString("base64");
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return { signature, publicKey: publicKey.toString("base64"), publicKeyDer: publicKey };
}

export function verifyLocally(hash: string, signature: string, publicKeyB64: string) {
  const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
  return ecVerify("sha256", Buffer.from(hash, "utf8"), key, Buffer.from(signature, "base64"));
}
