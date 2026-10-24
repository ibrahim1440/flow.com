// ZATCA Phase 2 (A4) — a minimal DER encoder / reader: enough for the CSR (PKCS#10) ZATCA asks for and to read
// the signature out of an X.509 certificate (QR tag 9). Pure; no dependency.

export type Der = Buffer;

function lenBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Buffer.from([0x80 | out.length, ...out]);
}

export const tlv = (tag: number, body: Buffer): Der => Buffer.concat([Buffer.from([tag]), lenBytes(body.length), body]);
export const seq = (...items: Der[]): Der => tlv(0x30, Buffer.concat(items));
export const set = (...items: Der[]): Der => tlv(0x31, Buffer.concat(items));
export const int = (n: number): Der => tlv(0x02, Buffer.from([n]));
export const utf8 = (s: string): Der => tlv(0x0c, Buffer.from(s, "utf8"));
export const printable = (s: string): Der => tlv(0x13, Buffer.from(s, "ascii"));
export const octet = (b: Buffer): Der => tlv(0x04, b);
export const bitString = (b: Buffer): Der => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
/** Context-specific constructed [n]. */
export const ctx = (n: number, body: Buffer): Der => tlv(0xa0 | n, body);

export function oid(dotted: string): Der {
  const parts = dotted.split(".").map((p) => BigInt(p));
  const bytes: number[] = [Number(parts[0] * BigInt(40) + parts[1])];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [];
    let v = p;
    do { chunk.unshift(Number(v & BigInt(0x7f))); v >>= BigInt(7); } while (v > BigInt(0));
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

export type Node = { tag: number; header: number; length: number; start: number; body: Buffer; raw: Buffer };

/** Read one TLV at `offset`. */
export function read(buf: Buffer, offset = 0): Node {
  const tag = buf[offset];
  let len = buf[offset + 1];
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER: unsupported length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i];
    header = 2 + n;
  }
  if (offset + header + len > buf.length) throw new Error("DER: truncated");
  return { tag, header, length: len, start: offset, body: buf.subarray(offset + header, offset + header + len), raw: buf.subarray(offset, offset + header + len) };
}

/** The children of a constructed node. */
export function children(n: Node): Node[] {
  const out: Node[] = [];
  for (let off = 0; off < n.body.length;) {
    const c = read(n.body, off);
    out.push(c);
    off += c.header + c.length;
  }
  return out;
}
