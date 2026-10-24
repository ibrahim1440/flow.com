// ZATCA Phase 2 (A4) — stamping a document: the invoice hash, the ECDSA signature, the XAdES signed properties and
// the QR, written into the UBL the generator produced (./ubl) WITHOUT re-serializing it: the generator leaves two
// markers (UBL-EXTENSIONS and QR-VALUE) and this module only replaces them, so every other byte — and therefore the
// hash — is what was generated. The result is stored byte for byte (ZatcaDocument.signedXml) and never rebuilt.
//
// The values follow the SDK (SigningServiceImpl, SignatureValidator):
//   · ds:Reference#invoiceSignedData DigestValue = the invoice hash (base64 of the SHA-256 bytes);
//   · CertDigest = base64(hex(SHA-256(certificate base64 text)));
//   · xadesSignedProperties DigestValue = base64(hex(SHA-256(the SignedProperties element as dom4j writes it on its
//     own: xmlns:xades on the element, xmlns:ds on every ds:* element, the document's whitespace kept)));
//   · SignatureValue = ECDSA over the hash bytes (./crypto signHash);
//   · X509IssuerName / X509SerialNumber of the CSID certificate (RDNs in DER order joined by ",", decimal serial).
import type { KeyObject } from "node:crypto";
import { createHash } from "node:crypto";
import { invoiceHash } from "./c14n";
import { certDigest, signHash, type CertInfo } from "./crypto";
import { phase2QrPayload } from "./qr";

export const EXT_MARKER = "<!--UBL-EXTENSIONS-->";
export const QR_MARKER = "QR-VALUE";

const NS_XADES = "http://uri.etsi.org/01903/v1.3.2#";
const NS_DS = "http://www.w3.org/2000/09/xmldsig#";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The SignedProperties element exactly as it is written into the document (indentation included). */
export function signedPropertiesXml(p: { signingTime: string; certDigest: string; issuerName: string; serialNumber: string }, indent = "                                "): string {
  const i = (n: number) => indent + "    ".repeat(n);
  return [
    `<xades:SignedProperties Id="xadesSignedProperties">`,
    `${i(1)}<xades:SignedSignatureProperties>`,
    `${i(2)}<xades:SigningTime>${esc(p.signingTime)}</xades:SigningTime>`,
    `${i(2)}<xades:SigningCertificate>`,
    `${i(3)}<xades:Cert>`,
    `${i(4)}<xades:CertDigest>`,
    `${i(5)}<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>`,
    `${i(5)}<ds:DigestValue>${p.certDigest}</ds:DigestValue>`,
    `${i(4)}</xades:CertDigest>`,
    `${i(4)}<xades:IssuerSerial>`,
    `${i(5)}<ds:X509IssuerName>${esc(p.issuerName)}</ds:X509IssuerName>`,
    `${i(5)}<ds:X509SerialNumber>${p.serialNumber}</ds:X509SerialNumber>`,
    `${i(4)}</xades:IssuerSerial>`,
    `${i(3)}</xades:Cert>`,
    `${i(2)}</xades:SigningCertificate>`,
    `${i(1)}</xades:SignedSignatureProperties>`,
    `${indent}</xades:SignedProperties>`,
  ].join("\n");
}

/** The digest of a SignedProperties element (as it stands in a document) the way ZATCA computes it. */
export function signedPropertiesDigest(element: string): string {
  const dom4j = element
    .replace("<xades:SignedProperties ", `<xades:SignedProperties xmlns:xades="${NS_XADES}" `)
    .replace(/<ds:(\w+)/g, `<ds:$1 xmlns:ds="${NS_DS}"`);
  return Buffer.from(createHash("sha256").update(dom4j, "utf8").digest("hex"), "utf8").toString("base64");
}

function extensionsXml(v: { hash: string; spDigest: string; signature: string; cert: string; signedProperties: string }): string {
  return `<ext:UBLExtensions>
    <ext:UBLExtension>
        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
        <ext:ExtensionContent>
            <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">
                <sac:SignatureInformation>
                    <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                    <ds:Signature xmlns:ds="${NS_DS}" Id="signature">
                        <ds:SignedInfo>
                            <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                            <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
                            <ds:Reference Id="invoiceSignedData" URI="">
                                <ds:Transforms>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                                </ds:Transforms>
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>${v.hash}</ds:DigestValue>
                            </ds:Reference>
                            <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>${v.spDigest}</ds:DigestValue>
                            </ds:Reference>
                        </ds:SignedInfo>
                        <ds:SignatureValue>${v.signature}</ds:SignatureValue>
                        <ds:KeyInfo>
                            <ds:X509Data>
                                <ds:X509Certificate>${v.cert}</ds:X509Certificate>
                            </ds:X509Data>
                        </ds:KeyInfo>
                        <ds:Object>
                            <xades:QualifyingProperties xmlns:xades="${NS_XADES}" Target="signature">
                                ${v.signedProperties}
                            </xades:QualifyingProperties>
                        </ds:Object>
                    </ds:Signature>
                </sac:SignatureInformation>
            </sig:UBLDocumentSignatures>
        </ext:ExtensionContent>
    </ext:UBLExtension>
</ext:UBLExtensions>`;
}

export type StampInput = {
  /** The generated UBL with EXT_MARKER and QR_MARKER in place. */
  xml: string;
  privateKey: KeyObject;
  cert: CertInfo;
  /** "YYYY-MM-DDTHH:mm:ss" — the issue instant (QR tag 3) and the XAdES signing time (local AST, as the SDK writes). */
  timestamp: string;
  qr: { sellerName: string; vatNumber: string; total: string; vat: string; simplified: boolean };
};

export type Stamped = { xml: string; hash: string; signature: string; qr: string; signedPropertiesDigest: string };

export function stamp(i: StampInput): Stamped {
  if (!i.xml.includes(EXT_MARKER) || !i.xml.includes(QR_MARKER)) throw new Error("The document has no signature / QR markers");
  // The hash excludes UBLExtensions, cac:Signature and the QR reference, so it is taken before they are filled.
  const hash = invoiceHash(i.xml.replace(EXT_MARKER, "").replace(QR_MARKER, ""));
  const signature = signHash(Buffer.from(hash, "base64"), i.privateKey);
  const sp = signedPropertiesXml({ signingTime: i.timestamp, certDigest: certDigest(i.cert.base64), issuerName: i.cert.issuerName, serialNumber: i.cert.serialDecimal });
  const spDigest = signedPropertiesDigest(sp);
  const qr = phase2QrPayload({
    sellerName: i.qr.sellerName, vatNumber: i.qr.vatNumber, timestamp: i.timestamp, total: i.qr.total, vat: i.qr.vat,
    invoiceHash: hash, signature, publicKey: i.cert.publicKeyDer, certificateSignature: i.cert.signature, simplified: i.qr.simplified,
  });
  const xml = i.xml.replace(EXT_MARKER, extensionsXml({ hash, spDigest, signature, cert: i.cert.base64, signedProperties: sp })).replace(QR_MARKER, qr);
  // Belt and braces: the stamped document hashes to the same value (nothing outside the excluded parts moved).
  if (invoiceHash(xml) !== hash) throw new Error("The stamped document no longer matches its hash");
  return { xml, hash, signature, qr, signedPropertiesDigest: spDigest };
}
