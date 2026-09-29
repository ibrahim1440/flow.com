// QR tags 6–9 and the local stamp, checked against values built INDEPENDENTLY of the code under
// test: TLV bytes written out by hand, the SHA-256 test vector from FIPS 180-2 ("abc"), the
// secp256k1 domain parameters from SEC 2 v2 §2.4.1, a SubjectPublicKeyInfo assembled byte by byte
// from those constants, and an ECDSA verifier written here in BigInt arithmetic (no node:crypto).
//
// The layouts they pin are the two readings in ubl.ts `qrTlv` (the default follows the sample
// invoices in a third-party copy of ZATCA's SDK, provenance unverified); the standard's text could
// not be opened here and ZATCA's SDK could not be run, so they do NOT show conformance
// (ZATCA_REQUIREMENTS.md §3). Synthetic keys and documents only; the private keys
// below (d = 1, d = 0x5EED…) are public test values and must never be used for anything else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { buildXml, documentHash, qrTlv, readQr, qrStampValues, signLocally, INITIAL_PIH, QR_ENCODING, type EDoc } from "../../../src/lib/accounting/einvoice/ubl";
import { validateDoc, standardsGaps } from "../../../src/lib/accounting/einvoice/rules";

// ── secp256k1 (SEC 2 v2, §2.4.1), independent BigInt arithmetic ───────────────────────────────
const B = BigInt; // (no BigInt literals: the project targets < ES2020)
const P = B("2") ** B("256") - B("2") ** B("32") - B("977");
const N = B("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const GX = B("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
const GY = B("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8");
type Pt = { x: bigint; y: bigint } | null;
const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
const pow = (b: bigint, e: bigint, m: bigint) => { let r = B("1"); b = mod(b, m); while (e > B("0")) { if (e & B("1")) r = (r * b) % m; b = (b * b) % m; e >>= B("1"); } return r; };
const inv = (a: bigint, m: bigint) => pow(a, m - B("2"), m);
function add(p: Pt, q: Pt): Pt {
  if (!p) return q; if (!q) return p;
  if (p.x === q.x && mod(p.y + q.y, P) === B("0")) return null;
  const l = p.x === q.x ? mod(B("3") * p.x * p.x * inv(B("2") * p.y, P), P) : mod((q.y - p.y) * inv(q.x - p.x, P), P);
  const x = mod(l * l - p.x - q.x, P);
  return { x, y: mod(l * (p.x - x) - p.y, P) };
}
function mul(k: bigint, p: Pt): Pt { let r: Pt = null; let a = p; while (k > B("0")) { if (k & B("1")) r = add(r, a); a = add(a, a); k >>= B("1"); } return r; }
const G: Pt = { x: GX, y: GY };
const hex32 = (n: bigint) => n.toString(16).padStart(64, "0");
const b64url = (h: string) => Buffer.from(h, "hex").toString("base64url");

/** DER ECDSA-Sig-Value (RFC 3279 §2.2.3) parsed by hand: SEQUENCE { INTEGER r, INTEGER s }, minimal encodings. */
function parseDerSig(b: Buffer) {
  assert.equal(b[0], 0x30, "SEQUENCE");
  assert.equal(b[1], b.length - 2, "SEQUENCE length covers the rest (short form)");
  let i = 2; const ints: bigint[] = [];
  for (let k = 0; k < 2; k++) {
    assert.equal(b[i], 0x02, "INTEGER");
    const len = b[i + 1]; const v = b.subarray(i + 2, i + 2 + len);
    assert.ok(len >= 1 && len <= 33, "INTEGER length");
    assert.equal(v[0] & 0x80, 0, "positive");
    if (len > 1) assert.ok(!(v[0] === 0 && (v[1] & 0x80) === 0), "minimal encoding");
    ints.push(BigInt("0x" + v.toString("hex"))); i += 2 + len;
  }
  assert.equal(i, b.length);
  return { r: ints[0], s: ints[1] };
}
/** ECDSA verification (SEC 1 v2 §4.1.4) with e = SHA-256(message). */
function ecdsaVerify(message: Buffer, sig: { r: bigint; s: bigint }, Q: Pt) {
  const { r, s } = sig;
  if (r < B("1") || r >= N || s < B("1") || s >= N) return false;
  const e = BigInt("0x" + createHash("sha256").update(message).digest("hex"));
  const w = inv(s, N);
  const X = add(mul(mod(e * w, N), G), mul(mod(r * w, N), Q));
  return !!X && mod(X.x, N) === r;
}
/** SubjectPublicKeyInfo for an uncompressed secp256k1 point, assembled byte by byte (RFC 5480 §2). */
const spki = (Q: { x: bigint; y: bigint }) => Buffer.from(
  "3056" + "3010" + "0607" + "2a8648ce3d0201" /* id-ecPublicKey 1.2.840.10045.2.1 */ + "0605" + "2b8104000a" /* secp256k1 1.3.132.0.10 */ +
  "034200" + "04" + hex32(Q.x) + hex32(Q.y), "hex");
const keyFromScalar = (d: bigint) => { const Q = mul(d, G)!; return { Q, key: createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "secp256k1", d: b64url(hex32(d)), x: b64url(hex32(Q.x)), y: b64url(hex32(Q.y)) } }) }; };

// FIPS 180-2 Appendix B.1: SHA-256("abc").
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ABC_B64 = Buffer.from(ABC, "hex").toString("base64");

test("independent curve check: d·G computed here in BigInt equals the public key Node derives, and the SPKI matches the hand-built bytes", () => {
  assert.equal(mod(GY * GY - GX * GX * GX - B("7"), P), B("0"), "G lies on y² = x³ + 7");
  assert.equal(mul(N, G), null, "n·G = O");
  for (const d of [B("1"), B("0x5eed") * B("0x1000000000000000000000000000001")]) {
    const { Q, key } = keyFromScalar(d);
    assert.equal(signLocally(ABC_B64, key).publicKeyDer.toString("hex"), spki(Q).toString("hex"));
  }
  assert.equal(spki(G!).length, 88, "SPKI for an uncompressed secp256k1 key is 88 bytes");
});

test("QR bytes, both layouts: tags 1–8 equal TLV sequences written out by hand (Arabic name counted in UTF-8 bytes)", () => {
  const { Q, key } = keyFromScalar(B("1"));
  const s = signLocally(ABC_B64, key);
  const fields = { sellerName: "شركة", vatNumber: "399999999900003", timestamp: "2026-09-29T10:15:00", total: "115.00", vat: "15.00", hash: ABC_B64, signature: s.signatureDer, publicKey: s.publicKeyDer };
  const sigHex = s.signatureDer.toString("hex");
  const head =
    "01" + "08" + "d8b4d8b1d983d8a9" +                                  // "شركة": 4 letters, 8 UTF-8 bytes
    "02" + "0f" + Buffer.from("399999999900003").toString("hex") +
    "03" + "13" + Buffer.from("2026-09-29T10:15:00").toString("hex") +
    "04" + "06" + "3131352e3030" +                                      // "115.00"
    "05" + "05" + "31352e3030";                                         // "15.00"
  const tail = "08" + "58" + spki(Q).toString("hex");                  // 88 bytes, raw DER in both layouts
  const b64sig = Buffer.from(s.signatureDer.toString("base64"), "utf8");
  // SDK_SAMPLE_TEXT: 6 = base64 text of the hash (44 bytes), 7 = base64 text of the DER signature (96 bytes).
  assert.equal(b64sig.length, 96);
  const textQr = qrTlv(fields, "SDK_SAMPLE_TEXT");
  assert.equal(Buffer.from(textQr, "base64").toString("hex"),
    head + "06" + "2c" + Buffer.from(ABC_B64, "utf8").toString("hex") + "07" + "60" + b64sig.toString("hex") + tail);
  // RAW_BYTES: 6 = the 32 hash bytes, 7 = the DER signature bytes.
  const rawQr = qrTlv(fields, "RAW_BYTES");
  assert.equal(Buffer.from(rawQr, "base64").toString("hex"),
    head + "06" + "20" + ABC + "07" + (sigHex.length / 2).toString(16).padStart(2, "0") + sigHex + tail);
  for (const [qr, enc] of [[textQr, "SDK_SAMPLE_TEXT"], [rawQr, "RAW_BYTES"]] as const) {
    const q = readQr(qr);
    assert.equal(qrStampValues(q, enc).hash!.toString("hex"), ABC);
    assert.equal(qrStampValues(q, enc).signature!.toString("hex"), sigHex);
    assert.equal(q[8].length, 88);
    assert.equal(q[9], undefined, "tag 9 is never produced without a ZATCA certificate");
  }
  assert.equal(qrTlv(fields), textQr, "the default layout is SDK_SAMPLE_TEXT");
  assert.equal(QR_ENCODING, "SDK_SAMPLE_TEXT");
  // Observed in every sample of the third-party SDK copy (ZATCA_REQUIREMENTS.md §3): tag lengths 6=44, 7=96, 8=88.
  assert.deepEqual([6, 7, 8].map((t) => readQr(textQr)[t].length), [44, 96, 88]);
});

test("signature: DER (not base64 text, not raw r‖s), over the 32 hash bytes, verified by the independent BigInt verifier", () => {
  const { Q, key } = keyFromScalar(B("0x5eed") * B("0x1000000000000000000000000000001"));
  const digest = Buffer.from(ABC, "hex");
  for (let k = 0; k < 5; k++) {
    const s = signLocally(ABC_B64, key);
    const sig = parseDerSig(s.signatureDer);
    assert.ok(ecdsaVerify(digest, sig, Q), "verifies over the raw 32-byte hash");
    assert.ok(!ecdsaVerify(Buffer.from(ABC_B64, "utf8"), sig, Q), "does not verify over the base64 text");
    assert.ok(!ecdsaVerify(digest, sig, mul(B("2"), Q)), "does not verify under another key");
    assert.equal(Buffer.from(s.signature, "base64").toString("hex"), s.signatureDer.toString("hex"), "the stored signature is the same DER bytes");
  }
});

test("curve: only secp256k1 keys sign; P-256 and Ed25519 keys are refused", () => {
  assert.throws(() => signLocally(ABC_B64, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey), /secp256k1/);
  assert.throws(() => signLocally(ABC_B64, generateKeyPairSync("ed25519").privateKey), /secp256k1/);
  assert.throws(() => qrTlv({ sellerName: "x", vatNumber: "1", timestamp: "t", total: "1", vat: "1", hash: Buffer.from("short").toString("base64") }), /32-byte/);
});

const doc = (): EDoc => ({
  id: "INV-9", uuid: "6f1c3c1e-2b1a-4c55-9d1e-0a2b3c4d5e6f", icv: 1, previousHash: INITIAL_PIH, issueDate: "2026-09-29", issueTime: "10:15:00",
  typeCode: "388", subtype: "0200000", currency: "SAR",
  seller: { name: "شركة", vatNumber: "399999999900003", crNumber: "1010000000", address: { street: "شارع تجريبي", buildingNo: "1234", district: "حي", city: "الرياض", postalCode: "12345", countryCode: "SA" } },
  buyer: { name: "" },
  lines: [{ no: 1, name: "بن تجريبي", quantity: "2", unitPrice: "50.0000", discountPercent: "0.00", net: "100.00", vatRate: "15.00", vat: "15.00", category: "S" }],
  totals: { lineExtension: "100.00", taxExclusive: "100.00", tax: "15.00", taxInclusive: "115.00", prepaid: "0.00", payable: "115.00" },
});

test("local rules catch the previous encoding and a mismatched stamp; standards gaps are always reported", () => {
  const d = doc();
  const { Q, key } = keyFromScalar(B("1"));
  const h = documentHash(d);
  assert.equal(Buffer.from(h, "base64").toString("hex"), createHash("sha256").update(buildXml(d, {}), "utf8").digest("hex"));
  const s = signLocally(h, key);
  const fields = { sellerName: d.seller.name, vatNumber: d.seller.vatNumber, timestamp: "2026-09-29T10:15:00", total: "115.00", vat: "15.00" };
  const qr = qrTlv({ ...fields, hash: h, signature: s.signatureDer, publicKey: s.publicKeyDer });
  const stored = (q: string) => ({ xml: buildXml(d, { signature: { value: s.signature, publicKey: s.publicKey }, qr: q }), invoiceHash: h, qr: q, signature: s.signature, publicKey: s.publicKey });
  const bad = (q: string) => validateDoc(d, stored(q)).filter((r) => !r.ok).map((r) => r.id);
  assert.deepEqual(bad(qr), []);
  // The other layout is caught by the rules under the configured one.
  const otherLayout = qrTlv({ ...fields, hash: h, signature: s.signatureDer, publicKey: s.publicKeyDer }, "RAW_BYTES");
  assert.deepEqual(bad(otherLayout), ["LOCAL-QR-HASH", "LOCAL-QR-STAMP"]);
  const other = signLocally(h, keyFromScalar(B("2")).key);
  assert.deepEqual(bad(qrTlv({ ...fields, hash: h, signature: other.signatureDer, publicKey: spki(Q) })), ["LOCAL-QR-STAMP"]);
  assert.deepEqual(standardsGaps("0200000", qr).map((g) => g.id), ["NOT-SDK-VALIDATED", "NO-ZATCA-CERTIFICATE", "QR-LAYOUT-UNCONFIRMED", "QR-TAG-9-ABSENT"]);
  assert.deepEqual(standardsGaps("0100000", null).map((g) => g.id), ["NOT-SDK-VALIDATED"]);
});
