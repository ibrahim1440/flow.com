// ZATCA Phase 2 (A4) — the EGS unit's keys, its CSR, the CSID certificate, the ECDSA signature and the at-rest
// encryption of every secret (Security Features Implementation Standard; the official SDK 238-R3.2.7 as the
// reference implementation: CsrGenerationService, DigitalSignatureServiceImpl, SigningServiceImpl).
//
//   · Keys: an EC key pair on secp256k1, generated on the server (node:crypto). The private key is kept only
//     ENCRYPTED (AES-256-GCM, key ZATCA_KEY_ENCRYPTION_KEY — the AUTH_MFA_KEY pattern of src/lib/auth/totp.ts);
//     it is never returned by an API, logged or written in plain anywhere.
//   · CSR (PKCS#10, SHA256withECDSA): subject C, OU, O, CN (in that order, as the SDK builds it); extension request
//     with the certificate-template name (Microsoft OID 1.3.6.1.4.1.311.20.2, UTF8String: TSTZATCA-Code-Signing in the
//     developer portal, PREZATCA-Code-Signing in simulation, ZATCA-Code-Signing in production) and a subjectAltName
//     directoryName: SN (2.5.4.4) "1-<solution>|2-<model>|3-<serial>", UID (0.9.2342.19200300.100.1.1) the VAT
//     number, title (2.5.4.12) the invoice-type flags TSCZ, registeredAddress (2.5.4.26), businessCategory (2.5.4.15).
//     Sent to ZATCA as base64 of the PEM text.
//   · Certificate (the CSID's binarySecurityToken = base64 of the base64 DER body): its serial (decimal), issuer
//     (RDNs in DER order joined with ","), public key (SPKI DER, QR tag 8) and its own signature (QR tag 9).
//   · Signature: SHA256withECDSA over the 32 raw bytes of the invoice hash (so the curve signs SHA-256(hash)),
//     DER, base64 — exactly as the SDK signs and verifies.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, X509Certificate, type KeyObject } from "node:crypto";
import { decodeMfaKey, decryptSecret, encryptSecret } from "@/lib/auth/totp";
import { bitString, children, ctx, int, octet, oid, printable, read, seq, set, utf8 } from "./asn1";

// ── at-rest encryption ───────────────────────────────────────────────────────────────────────────────

/** The 32-byte key from ZATCA_KEY_ENCRYPTION_KEY (64 hex characters or base64 of 32 bytes), or null. */
export function zatcaKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  return decodeMfaKey(env.ZATCA_KEY_ENCRYPTION_KEY);
}

/** The environment gate's rule (never echoes the value): unset is allowed (onboarding then refuses), malformed is not. */
export function evaluateZatcaKey(env: Record<string, string | undefined>): { ok: true } | { ok: false; reason: string } {
  const raw = env.ZATCA_KEY_ENCRYPTION_KEY;
  if (raw === undefined || raw === "") return { ok: true };
  return decodeMfaKey(raw) ? { ok: true } : { ok: false, reason: "ZATCA_KEY_ENCRYPTION_KEY is set but does not decode to exactly 32 bytes (64 hex characters, or base64 of 32 bytes such as `openssl rand -base64 32`)." };
}

export class ZatcaKeyMissing extends Error {
  constructor() { super("ZATCA_KEY_ENCRYPTION_KEY is not configured on this server."); this.name = "ZatcaKeyMissing"; }
}

function keyOrThrow(): Buffer {
  const k = zatcaKey();
  if (!k) throw new ZatcaKeyMissing();
  return k;
}

/** Encrypt a secret for storage (v1.iv.tag.ciphertext, AES-256-GCM). */
export const sealSecret = (plain: string, key: Buffer = keyOrThrow()) => encryptSecret(plain, key);
/** Decrypt a stored secret. Throws on a wrong key or a tampered value (GCM tag). */
export const openSecret = (blob: string, key: Buffer = keyOrThrow()) => decryptSecret(blob, key);

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────────

export type EgsKeyPair = { privateKeyPem: string; publicKeyDer: Buffer; publicKeyPem: string };

export function generateEgsKeyPair(): EgsKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyDer: publicKey.export({ type: "spki", format: "der" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** A private key from PKCS#8 PEM, SEC1 PEM, or the SDK's bare base64 SEC1 body. */
export function loadPrivateKey(text: string): KeyObject {
  const t = text.trim();
  if (t.startsWith("-----BEGIN")) return createPrivateKey(t);
  return createPrivateKey({ key: Buffer.from(t.replace(/\s+/g, ""), "base64"), format: "der", type: "sec1" });
}

// ── CSR ──────────────────────────────────────────────────────────────────────────────────────────────

export type ZatcaEnvironment = "SANDBOX" | "SIMULATION" | "PRODUCTION";
export const TEMPLATE_NAME: Record<ZatcaEnvironment, string> = {
  SANDBOX: "TSTZATCA-Code-Signing", SIMULATION: "PREZATCA-Code-Signing", PRODUCTION: "ZATCA-Code-Signing",
};

export type CsrSubject = {
  commonName: string;          // CN — a unique name of the EGS unit
  serialNumber: string;        // SN — 1-<solution>|2-<model/version>|3-<device serial>
  organizationIdentifier: string; // UID — the 15-digit VAT number (3…3)
  organizationUnit: string;    // OU — the branch name (the 10-digit TIN for a VAT group member)
  organizationName: string;    // O — the taxpayer's name
  countryName: string;         // C — "SA"
  invoiceType: string;         // title — TSCZ flags, "1100" = standard + simplified
  location: string;            // registeredAddress — the branch address
  industry: string;            // businessCategory
};

/** The SDK's input checks (CsrGenerationService.validateCsrConfigInputFile), as bilingual problems. */
export function csrProblems(s: CsrSubject): { field: keyof CsrSubject; ar: string; en: string }[] {
  const p: { field: keyof CsrSubject; ar: string; en: string }[] = [];
  const empty = (v: string) => !v || !v.trim();
  if (empty(s.commonName)) p.push({ field: "commonName", ar: "الاسم الشائع للوحدة مطلوب.", en: "Common name is required." });
  if (!/^1-(.+)\|2-(.+)\|3-(.+)$/.test(s.serialNumber)) p.push({ field: "serialNumber", ar: "الرقم التسلسلي بالصيغة 1-…|2-…|3-….", en: "Serial number must be 1-…|2-…|3-…." });
  if (!/^3\d{13}3$/.test(s.organizationIdentifier)) p.push({ field: "organizationIdentifier", ar: "الرقم الضريبي 15 رقمًا يبدأ وينتهي بـ 3.", en: "VAT number: 15 digits, starting and ending with 3." });
  if (empty(s.organizationUnit)) p.push({ field: "organizationUnit", ar: "اسم الفرع مطلوب.", en: "Branch (organization unit) is required." });
  else if (s.organizationIdentifier[10] === "1" && !/^\d{10}$/.test(s.organizationUnit)) p.push({ field: "organizationUnit", ar: "عضو مجموعة ضريبية: اسم الوحدة هو رقم TIN من 10 أرقام.", en: "VAT group member: the organization unit is the 10-digit group TIN." });
  if (empty(s.organizationName)) p.push({ field: "organizationName", ar: "اسم المنشأة مطلوب.", en: "Organization name is required." });
  if (!/^[A-Z]{2,3}$/.test(s.countryName)) p.push({ field: "countryName", ar: "رمز الدولة غير صالح.", en: "Invalid country code." });
  if (!/^[01]{4}$/.test(s.invoiceType) || s.invoiceType === "0000") p.push({ field: "invoiceType", ar: "أنواع الفواتير أربع خانات 0/1 (مثل 1100).", en: "Invoice types: four 0/1 flags (e.g. 1100)." });
  if (empty(s.location)) p.push({ field: "location", ar: "عنوان الموقع مطلوب.", en: "Location is required." });
  if (empty(s.industry)) p.push({ field: "industry", ar: "النشاط مطلوب.", en: "Industry is required." });
  return p;
}

const rdn = (attrOid: string, value: Buffer) => set(seq(oid(attrOid), value));

/** PKCS#10 CSR in PEM, signed with the EGS key (SHA256withECDSA). */
export function buildCsr(s: CsrSubject, environment: ZatcaEnvironment, privateKeyPem: string): string {
  const problems = csrProblems(s);
  if (problems.length) throw new Error(`CSR input invalid: ${problems.map((x) => x.field).join(", ")}`);
  const priv = loadPrivateKey(privateKeyPem);
  const spki = createPublicKey(priv).export({ type: "spki", format: "der" });
  const subject = seq(
    rdn("2.5.4.6", printable(s.countryName)),
    rdn("2.5.4.11", utf8(s.organizationUnit)),
    rdn("2.5.4.10", utf8(s.organizationName)),
    rdn("2.5.4.3", utf8(s.commonName)),
  );
  const dirName = seq(
    rdn("2.5.4.4", utf8(s.serialNumber)),
    rdn("0.9.2342.19200300.100.1.1", utf8(s.organizationIdentifier)),
    rdn("2.5.4.12", utf8(s.invoiceType)),
    rdn("2.5.4.26", utf8(s.location)),
    rdn("2.5.4.15", utf8(s.industry)),
  );
  const template = seq(oid("1.3.6.1.4.1.311.20.2"), octet(utf8(TEMPLATE_NAME[environment])));
  const san = seq(oid("2.5.29.17"), octet(seq(ctx(4, dirName))));
  const extReq = seq(oid("1.2.840.113549.1.9.14"), set(seq(template, san)));
  const info = seq(int(0), subject, spki, ctx(0, extReq));
  const sig = sign("sha256", info, priv);
  const der = seq(info, seq(oid("1.2.840.10045.4.3.2")), bitString(sig));
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE REQUEST-----\n${b64}\n-----END CERTIFICATE REQUEST-----\n`;
}

/** What the compliance / renewal APIs take: base64 of the PEM text. */
export const csrForApi = (csrPem: string) => Buffer.from(csrPem, "utf8").toString("base64");

// ── certificate ──────────────────────────────────────────────────────────────────────────────────────

export type CertInfo = {
  /** The base64 DER body, as it goes into ds:X509Certificate (and whose text is hashed for CertDigest). */
  base64: string;
  serialDecimal: string;
  issuerName: string;
  subject: string;
  notBefore: Date;
  notAfter: Date;
  publicKeyDer: Buffer;
  /** The certificate's own signature (the issuing CA's), raw DER bytes — QR tag 9. */
  signature: Buffer;
  sha256: string;
};

/** From a CSID binarySecurityToken (base64 of the base64 certificate body) or a bare base64 / PEM certificate. */
export function certFromToken(token: string): CertInfo {
  const t = token.trim();
  let body: string;
  if (t.startsWith("-----BEGIN")) body = t.replace(/-----[^-]+-----|\s/g, "");
  else {
    const once = Buffer.from(t, "base64").toString("latin1");
    body = /^MI[A-Za-z0-9+/=\s]+$/.test(once) ? once.replace(/\s/g, "") : t.replace(/\s/g, "");
  }
  const der = Buffer.from(body, "base64");
  const c = new X509Certificate(der);
  const cert = read(der);
  const [, , sigBits] = children(cert);
  return {
    base64: body,
    serialDecimal: BigInt(`0x${c.serialNumber}`).toString(10),
    issuerName: c.issuer.split("\n").join(","),
    subject: c.subject.split("\n").join(","),
    notBefore: new Date(c.validFrom), notAfter: new Date(c.validTo),
    publicKeyDer: c.publicKey.export({ type: "spki", format: "der" }),
    signature: sigBits.body.subarray(1),
    sha256: createHash("sha256").update(der).digest("hex"),
  };
}

/** The XAdES CertDigest value as ZATCA computes it: base64( hex( SHA-256( the base64 certificate text ) ) ). */
export const certDigest = (certBase64: string) => Buffer.from(createHash("sha256").update(certBase64, "utf8").digest("hex"), "utf8").toString("base64");

// ── signature ────────────────────────────────────────────────────────────────────────────────────────

/** ECDSA (secp256k1, SHA256withECDSA) over the invoice-hash bytes; DER, base64. */
export function signHash(hashBytes: Buffer, privateKey: KeyObject): string {
  return sign("sha256", hashBytes, privateKey).toString("base64");
}

export function verifyHashSignature(hashBytes: Buffer, signatureB64: string, publicKey: KeyObject | Buffer): boolean {
  const key = Buffer.isBuffer(publicKey) ? createPublicKey({ key: publicKey, format: "der", type: "spki" }) : publicKey;
  return verify("sha256", hashBytes, key, Buffer.from(signatureB64, "base64"));
}
