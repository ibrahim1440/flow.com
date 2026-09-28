// Supplier bill line arithmetic for the editor: exact decimals in integers, half-up to the
// halala — the same result as the server (payables-service computeLine).
const DEC4 = /^\d{1,14}(\.\d{1,4})?$/;
const B = (n: number | string) => BigInt(n);

function scaled(s: string, dp: number): bigint | null {
  const t = s.replace(/,/g, "").trim();
  if (!DEC4.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return B(w + (f + "0".repeat(dp)).slice(0, dp));
}
function divHalfUp(n: bigint, d: bigint) { return (n * B(2) + d) / (B(2) * d); }

/** net, VAT and gross in halalas, or null when quantity/price/rate is not a valid decimal. */
export function lineMinor(q: string, p: string, rate: string): { net: number; vat: number; gross: number } | null {
  const qs = scaled(q, 4), ps = scaled(p, 4), rs = scaled(rate || "0", 2);
  if (qs === null || ps === null || rs === null) return null;
  const net = divHalfUp(qs * ps, B(1_000_000)); // quantity×price is at scale 1e8; halalas are 1e2
  const vat = divHalfUp(net * rs, B(10_000)); // rate is a percentage at scale 1e2
  return { net: Number(net), vat: Number(vat), gross: Number(net + vat) };
}

/** Sales line (sales-rules computeSalesLine): amount, discount %, net, VAT on the net — in halalas. */
export function salesLineMinor(q: string, p: string, discount: string, rate: string): { net: number; vat: number; gross: number } | null {
  const qs = scaled(q, 4), ps = scaled(p, 4), ds = scaled(discount || "0", 2), rs = scaled(rate || "0", 2);
  if (qs === null || ps === null || ds === null || rs === null || ds > B(10_000)) return null;
  const before = divHalfUp(qs * ps, B(1_000_000));
  const net = before - divHalfUp(before * ds, B(10_000));
  const vat = divHalfUp(net * rs, B(10_000));
  return { net: Number(net), vat: Number(vat), gross: Number(net + vat) };
}
