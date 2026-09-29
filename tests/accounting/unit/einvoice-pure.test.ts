// E-invoice building blocks (stage 6), pure. SYNTHETIC seller and buyer data. These tests check
// our own implementation is self-consistent and applies the local rules; they do NOT show that a
// document conforms to ZATCA's standards (only the official SDK / Fatoora can).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { buildXml, documentHash, hashOfStoredXml, qrTlv, readQr, signLocally, verifyLocally, INITIAL_PIH, type EDoc } from "../../../src/lib/accounting/einvoice/ubl";
import { validateDoc } from "../../../src/lib/accounting/einvoice/rules";
import { submissionTarget } from "../../../src/lib/accounting/einvoice/target";

const doc = (o: Partial<EDoc> = {}): EDoc => ({
  id: "INV-1", uuid: "3cf5ee18-ee25-44ea-a444-2c37ba7f28be", icv: 1, previousHash: INITIAL_PIH, issueDate: "2026-09-29", issueTime: "10:15:00", supplyDate: "2026-09-29",
  typeCode: "388", subtype: "0100000", currency: "SAR",
  seller: { name: "شركة حقبة التجريبية", vatNumber: "399999999900003", crNumber: "1010000000", address: { street: "شارع تجريبي", buildingNo: "1234", district: "حي تجريبي", city: "الرياض", postalCode: "12345", countryCode: "SA" } },
  buyer: { name: "فندق الروضة (تجريبي)", vatNumber: "300445566700003", address: { street: "طريق تجريبي", buildingNo: "4321", district: "حي", city: "جدة", postalCode: "23456", countryCode: "SA" } },
  lines: [
    { no: 1, name: "بن محمص 1 كغ", quantity: "10", unitPrice: "100.0000", discountPercent: "0.00", net: "1000.00", vatRate: "15.00", vat: "150.00", category: "S" },
    { no: 2, name: "خدمة تدريب", quantity: "1", unitPrice: "200.0000", discountPercent: "10.00", net: "180.00", vatRate: "15.00", vat: "27.00", category: "S" },
  ],
  totals: { lineExtension: "1180.00", taxExclusive: "1180.00", tax: "177.00", taxInclusive: "1357.00", prepaid: "0.00", payable: "1357.00" },
  ...o,
});
const failed = (d: EDoc) => validateDoc(d).filter((r) => !r.ok).map((r) => r.id);

test("initial previous-invoice hash is base64 of the hex SHA-256 of \"0\"", () => {
  assert.equal(INITIAL_PIH, "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==");
});

test("QR TLV: tag, length, UTF-8 value, base64 — the widely published phase-1 example encodes to the same string", () => {
  const qr = qrTlv({ sellerName: "Bobs Records", vatNumber: "310122393500003", timestamp: "2022-04-25T15:30:00Z", total: "1000.00", vat: "150.00" });
  assert.equal(qr, "AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==");
  const back = readQr(qr);
  assert.equal(back[1].toString(), "Bobs Records");
  assert.equal(back[5].toString(), "150.00");
  assert.throws(() => qrTlv({ sellerName: "x".repeat(256), vatNumber: "1", timestamp: "t", total: "1", vat: "1" }), /longer than 255/);
});

test("hash: the stored XML with signature and QR hashes to the document hash; a changed byte does not", () => {
  const d = doc({ subtype: "0200000" });
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const h = documentHash(d);
  const s = signLocally(h, privateKey);
  const qr = qrTlv({ sellerName: d.seller.name, vatNumber: d.seller.vatNumber, timestamp: "2026-09-29T10:15:00", total: "1357.00", vat: "177.00", hash: h, signature: s.signature, publicKey: s.publicKeyDer });
  const xml = buildXml(d, { signature: { value: s.signature, publicKey: s.publicKey }, qr });
  assert.equal(hashOfStoredXml(xml), h);
  assert.notEqual(hashOfStoredXml(xml.replace("1357.00", "1357.01")), h);
  assert.ok(verifyLocally(h, s.signature, s.publicKey));
  assert.ok(!verifyLocally(h.replace(/^./, "A"), s.signature, s.publicKey));
  assert.deepEqual(validateDoc(d, { xml, invoiceHash: h, qr, signature: s.signature, publicKey: s.publicKey }).filter((r) => !r.ok), []);
  assert.deepEqual(validateDoc(d, { xml: xml.replace("1357.00", "1357.01"), invoiceHash: h, qr, signature: s.signature, publicKey: s.publicKey }).filter((r) => !r.ok).map((r) => r.id), ["LOCAL-HASH"]);
  assert.match(xml, /<cbc:InvoiceTypeCode name="0200000">388<\/cbc:InvoiceTypeCode>/);
  assert.match(xml, /<cbc:ID>ICV<\/cbc:ID><cbc:UUID>1<\/cbc:UUID>/);
  assert.match(xml, /LOCAL TEST SIGNATURE/);
});

test("local rules: a complete standard invoice passes; each defect is caught by its rule", () => {
  assert.deepEqual(failed(doc()), []);
  assert.deepEqual(failed(doc({ buyer: { name: "B", vatNumber: null, address: null } })), ["LOCAL-BUYER-VAT", "LOCAL-BUYER-ADDR"]);
  assert.deepEqual(failed(doc({ seller: { ...doc().seller, vatNumber: "123456789012345" } })), ["LOCAL-SELLER-VAT"]);
  assert.deepEqual(failed(doc({ typeCode: "381" })), ["LOCAL-BILLING-REF", "LOCAL-REASON"]);
  assert.deepEqual(failed(doc({ typeCode: "381", billingReference: "INV-1", reason: "خصم سعر متفق عليه" })), []);
  assert.deepEqual(failed(doc({ totals: { ...doc().totals, taxInclusive: "1357.50", payable: "1357.50" } })), ["LOCAL-TOTAL-INCL"]);
  const zero = doc({ lines: [{ no: 1, name: "تصدير", quantity: "1", unitPrice: "500.0000", discountPercent: "0.00", net: "500.00", vatRate: "0.00", vat: "0.00", category: "Z" }], totals: { lineExtension: "500.00", taxExclusive: "500.00", tax: "0.00", taxInclusive: "500.00", prepaid: "0.00", payable: "500.00" } });
  assert.deepEqual(failed(zero), ["LOCAL-TAX-CATEGORY"]);
  assert.deepEqual(failed({ ...zero, lines: [{ ...zero.lines[0], exemptionCode: "VATEX-SA-TEST", exemptionReason: "SYNTHETIC reason" }] }), []);
  assert.deepEqual(failed(doc({ lines: [{ ...doc().lines[0], net: "999.00" }, doc().lines[1]] })), ["LOCAL-LINE-AMOUNTS", "LOCAL-TOTAL-LINES", "LOCAL-TOTAL-TAX"]);
  // A simplified invoice needs no buyer VAT number or address.
  assert.deepEqual(failed(doc({ subtype: "0200000", buyer: { name: "", vatNumber: null } })), []);
});

test("submission target: never production; only a local stub or ZATCA's developer-portal / simulation paths with test credentials", () => {
  assert.deepEqual(submissionTarget("LOCAL_ONLY", {}), { environment: "LOCAL_ONLY" });
  assert.match((submissionTarget("SANDBOX", {}) as { refused: string }).refused, /No sandbox URL/);
  assert.match((submissionTarget("SANDBOX", { ZATCA_SANDBOX_URL: "https://gw-fatoora.zatca.gov.sa/e-invoicing/core", ZATCA_SANDBOX_TOKEN: "t", ZATCA_SANDBOX_SECRET: "s" }) as { refused: string }).refused, /production/);
  assert.match((submissionTarget("SANDBOX", { ZATCA_SANDBOX_URL: "https://example.com/e-invoicing/simulation" }) as { refused: string }).refused, /not an allowed test target/);
  assert.match((submissionTarget("SANDBOX", { ZATCA_SANDBOX_URL: "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation" }) as { refused: string }).refused, /No test CSID/);
  assert.equal((submissionTarget("SANDBOX", { ZATCA_SANDBOX_URL: "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal", ZATCA_SANDBOX_TOKEN: "t", ZATCA_SANDBOX_SECRET: "s" }) as { environment: string }).environment, "SANDBOX");
  assert.equal((submissionTarget("SANDBOX", { ZATCA_SANDBOX_URL: "http://127.0.0.1:9911" }) as { environment: string }).environment, "SANDBOX");
  assert.deepEqual(submissionTarget("PRODUCTION", {}), { environment: "LOCAL_ONLY" }, "anything else is local only");
});
