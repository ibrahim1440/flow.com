// Sales invoicing A2 — the Phase-1 ZATCA QR payload: TLV (tag, length, UTF-8 value), base64. Tags 1–5 only:
//   1 seller name · 2 seller VAT number · 3 issue timestamp (ISO 8601) · 4 invoice total with VAT · 5 VAT total.
// Built from the ISSUED snapshot (never from screen fields, E-4). A4 replaces it with the Phase-2 QR (tags 1–9,
// stored in SalesInvoice.zatcaQr after signing / clearance); this payload is computed on render and never stored.
// Pure and client-safe (no Buffer: TextEncoder + btoa).

export type Phase1QrInput = { sellerName: string; vatNumber: string; timestamp: string; total: string; vat: string };

function tlv(tag: number, value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  if (bytes.length > 255) throw new RangeError(`QR tag ${tag} is longer than 255 bytes.`);
  return [tag, bytes.length, ...bytes];
}

export function phase1QrPayload(i: Phase1QrInput): string {
  const bytes = [...tlv(1, i.sellerName), ...tlv(2, i.vatNumber), ...tlv(3, i.timestamp), ...tlv(4, i.total), ...tlv(5, i.vat)];
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode a TLV payload (tests, and the support view). */
export function decodeTlv(b64: string): Record<number, string> {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const out: Record<number, string> = {};
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i], len = bytes[i + 1];
    out[tag] = new TextDecoder().decode(bytes.slice(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return out;
}

/** "2026-11-03T14:20:05+03:00" — the issue instant in AST, as tag 3 carries it. */
export function astTimestamp(issueDate: string, issueTime: string): string {
  return `${issueDate}T${issueTime}+03:00`;
}
