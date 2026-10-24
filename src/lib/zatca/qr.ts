// ZATCA Phase 2 (A4) — the QR payload: base64 of TLV records, tags 1–9 (XML Implementation Standard, QR section;
// the SDK's QRCodeGeneratorServiceImpl):
//   1 seller name (UTF-8) · 2 VAT number · 3 timestamp "YYYY-MM-DDTHH:mm:ss" (IssueDate + IssueTime) · 4 total with VAT
//   · 5 VAT total · 6 invoice hash (base64 text) · 7 ECDSA signature (base64 text) · 8 public key (SPKI DER bytes)
//   · 9 the CA's signature of the stamp certificate (DER bytes) — simplified documents only.
// Lengths use BER (one byte below 128, 0x81 nn up to 255), as the SDK's BerTlvBuilder writes and its validator parses.

function len(n: number): number[] {
  if (n < 0x80) return [n];
  if (n <= 0xff) return [0x81, n];
  throw new RangeError("QR TLV value longer than 255 bytes");
}

function rec(tag: number, value: Uint8Array): number[] {
  return [tag, ...len(value.length), ...value];
}
const text = (s: string) => new TextEncoder().encode(s);

export type Phase2QrInput = {
  sellerName: string; vatNumber: string; timestamp: string; total: string; vat: string;
  invoiceHash: string; signature: string; publicKey: Uint8Array; certificateSignature?: Uint8Array | null; simplified: boolean;
};

export function phase2QrPayload(q: Phase2QrInput): string {
  const bytes = [
    ...rec(1, text(q.sellerName)), ...rec(2, text(q.vatNumber)), ...rec(3, text(q.timestamp)), ...rec(4, text(q.total)), ...rec(5, text(q.vat)),
    ...rec(6, text(q.invoiceHash)), ...rec(7, text(q.signature)), ...rec(8, q.publicKey),
  ];
  if (q.simplified) {
    if (!q.certificateSignature?.length) throw new Error("QR tag 9 (certificate signature) is required on a simplified document");
    bytes.push(...rec(9, q.certificateSignature));
  }
  return Buffer.from(bytes).toString("base64");
}

/** Decode a TLV QR (either length form). Text tags as UTF-8; tags 8 and 9 as base64 of their bytes. */
export function decodeQr(b64: string): Record<number, string> {
  const b = Buffer.from(b64, "base64");
  const out: Record<number, string> = {};
  for (let i = 0; i < b.length;) {
    const tag = b[i];
    let l = b[i + 1], h = 2;
    if (l === 0x81) { l = b[i + 2]; h = 3; }
    const v = b.subarray(i + h, i + h + l);
    out[tag] = tag === 8 || tag === 9 ? v.toString("base64") : v.toString("utf8");
    i += h + l;
  }
  return out;
}
