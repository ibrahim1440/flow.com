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
//   - the signature is ECDSA on secp256k1 (the curve ZATCA's own SDK notes name) with SHA-256, made
//     with a LOCAL TEST KEY and carried in a simplified UBL extension — it is NOT a XAdES signature
//     and NOT made with a ZATCA-issued CSID;
//   - QR tags 1–8 are produced (encodings in `qrTlv` below); tag 9 (ZATCA's technical CA signature
//     over the stamp's public key) cannot exist without a ZATCA certificate and is never produced.
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

/**
 * QR: TLV (tag byte, length byte, value bytes), base64. Tags 1–5 are UTF-8 text. Tags 6–9 for
 * signed documents, in one of two layouts (ZATCA_REQUIREMENTS.md §3):
 *   OFFICIAL_DOCS (default) — the encodings the official documents specify, as cited in the owner's
 *     reading of them (Security Features Implementation Standards v1.2 §4.1; Developer Portal
 *     Manual; not re-opened from this environment, which cannot reach zatca.gov.sa):
 *       6 = the 32-byte SHA-256 value; 7 = the ECDSA signature in IEEE P1363 form (r‖s, 64 bytes for
 *       a 256-bit curve); 8 = the 64-byte public key (the point's X‖Y);
 *   SDK_SAMPLE_TEXT — the layout of the sample invoices in a THIRD-PARTY copy of ZATCA's SDK
 *     (secondary evidence only; provenance unverified, not executed): 6 = base64 text of the hash,
 *     7 = base64 text of the DER signature, 8 = DER SubjectPublicKeyInfo.
 * 9 = ZATCA's technical CA signature of the stamp's public key — only with a ZATCA certificate;
 * never produced here. Only ZATCA's SDK can confirm either layout.
 */
export type QrEncoding = "OFFICIAL_DOCS" | "SDK_SAMPLE_TEXT";
export const QR_ENCODING: QrEncoding = "OFFICIAL_DOCS";

/** DER ECDSA-Sig-Value → IEEE P1363 r‖s, each left-padded to `size` bytes. */
export function derToP1363(der: Buffer, size = 32) {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error("Not a DER ECDSA signature.");
  const out: Buffer[] = [];
  let i = 2;
  for (let k = 0; k < 2; k++) {
    if (der[i] !== 0x02) throw new Error("Not a DER ECDSA signature.");
    let v = der.subarray(i + 2, i + 2 + der[i + 1]);
    i += 2 + der[i + 1];
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error("Signature integer longer than the curve size.");
    out.push(Buffer.concat([Buffer.alloc(size - v.length), v]));
  }
  return Buffer.concat(out);
}

/** DER SubjectPublicKeyInfo (EC) → the raw point X‖Y (64 bytes for a 256-bit curve). */
export function spkiToRawPoint(spki: Buffer) {
  const jwk = createPublicKey({ key: spki, format: "der", type: "spki" }).export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("Not an EC public key.");
  return Buffer.concat([Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
}

/** `signature` is the DER signature and `publicKey` the DER SPKI; each layout encodes them as described above. */
export function qrTlv(fields: { sellerName: string; vatNumber: string; timestamp: string; total: string; vat: string; hash?: string; signature?: Buffer; publicKey?: Buffer; certificateSignature?: Buffer }, encoding: QrEncoding = QR_ENCODING) {
  const hash = fields.hash ? Buffer.from(fields.hash, "base64") : null;
  if (hash && hash.length !== 32) throw new Error("QR tag 6 must carry a 32-byte SHA-256 value.");
  const official = encoding === "OFFICIAL_DOCS";
  const parts: [number, Buffer][] = [
    [1, Buffer.from(fields.sellerName, "utf8")], [2, Buffer.from(fields.vatNumber, "utf8")], [3, Buffer.from(fields.timestamp, "utf8")],
    [4, Buffer.from(fields.total, "utf8")], [5, Buffer.from(fields.vat, "utf8")],
    ...(hash ? [[6, official ? hash : Buffer.from(hash.toString("base64"), "utf8")] as [number, Buffer]] : []),
    ...(fields.signature ? [[7, official ? derToP1363(fields.signature) : Buffer.from(fields.signature.toString("base64"), "utf8")] as [number, Buffer]] : []),
    ...(fields.publicKey ? [[8, official ? spkiToRawPoint(fields.publicKey) : fields.publicKey] as [number, Buffer]] : []),
    ...(fields.certificateSignature ? [[9, fields.certificateSignature] as [number, Buffer]] : []),
  ];
  const out: Buffer[] = [];
  for (const [tag, v] of parts) {
    if (v.length > 255) throw new Error(`QR tag ${tag} is longer than 255 bytes.`);
    out.push(Buffer.from([tag, v.length]), v);
  }
  return Buffer.concat(out).toString("base64");
}

/** Verify a QR's own stamp: tag 7 over the tag 6 hash bytes with the tag 8 key (secp256k1), under a layout. */
export function verifyQrStamp(q: Record<number, Buffer>, encoding: QrEncoding = QR_ENCODING) {
  if (!q[6] || !q[7] || !q[8]) return false;
  try {
    if (encoding === "OFFICIAL_DOCS") {
      if (q[6].length !== 32 || q[7].length !== 64 || q[8].length !== 64) return false;
      const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: SIGNING_CURVE, x: q[8].subarray(0, 32).toString("base64url"), y: q[8].subarray(32).toString("base64url") } });
      return ecVerify("sha256", q[6], { key, dsaEncoding: "ieee-p1363" }, q[7]);
    }
    return verifyLocally(q[6].toString("utf8"), q[7].toString("utf8"), q[8].toString("base64"));
  } catch { return false; }
}

/** Parse a base64 TLV QR. Strict: a truncated or duplicated tag, or a non-base64 string, throws. */
export function readQr(b64: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64.trim())) throw new Error("QR is not base64.");
  const buf = Buffer.from(b64, "base64");
  const out: Record<number, Buffer> = {};
  for (let i = 0; i < buf.length;) {
    if (i + 2 > buf.length) throw new Error(`QR is truncated at byte ${i} (no length byte).`);
    const tag = buf[i], len = buf[i + 1];
    if (i + 2 + len > buf.length) throw new Error(`QR tag ${tag} is truncated: ${len} bytes declared, ${buf.length - i - 2} present.`);
    if (out[tag]) throw new Error(`QR tag ${tag} appears twice.`);
    out[tag] = buf.subarray(i + 2, i + 2 + len); i += 2 + len;
  }
  return out;
}

/** readQr that returns null instead of throwing (for validation rules over stored data). */
export function tryReadQr(b64: string | null | undefined) {
  if (!b64) return null;
  try { return readQr(b64); } catch { return null; }
}

export const SIGNING_CURVE = "secp256k1";

/** ECDSA (secp256k1, SHA-256, DER) over the 32 raw bytes of the document hash, with a LOCAL TEST key. */
export function signLocally(hash: string, privateKey: KeyObject) {
  const curve = privateKey.asymmetricKeyDetails?.namedCurve;
  if (privateKey.asymmetricKeyType !== "ec" || curve !== SIGNING_CURVE) throw new Error(`The signing key must be an EC key on ${SIGNING_CURVE} (got ${privateKey.asymmetricKeyType}/${curve ?? "?"}).`);
  const signatureDer = ecSign("sha256", Buffer.from(hash, "base64"), { key: privateKey, dsaEncoding: "der" });
  const publicKeyDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return { signature: signatureDer.toString("base64"), signatureDer, publicKey: publicKeyDer.toString("base64"), publicKeyDer };
}

export function verifyLocally(hash: string, signature: string, publicKeyB64: string) {
  const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyDetails?.namedCurve !== SIGNING_CURVE) return false;
  return ecVerify("sha256", Buffer.from(hash, "base64"), { key, dsaEncoding: "der" }, Buffer.from(signature, "base64"));
}
