/**
 * The evidence file's real kind, from its first bytes — the ONE check the server (services/sales/evidence.ts) and the
 * phone (lib/files/receipt-prep.ts) both run, so a file named «.jpg» that is not a JPEG is refused before the sale,
 * not after it (D20 re-gate note, 10 Nov). Pure: no Node, no DOM.
 *
 *   PDF   `%PDF-`                      25 50 44 46 2D
 *   JPEG  SOI marker                   FF D8 FF
 *   PNG   the 8-byte signature         89 50 4E 47 0D 0A 1A 0A
 */
export type SniffedKind = "application/pdf" | "image/jpeg" | "image/png";
export function sniffEvidenceType(bytes: Uint8Array): SniffedKind | null {
  const at = (i: number) => (i < bytes.length ? bytes[i] : -1);

  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2d) {
    return "application/pdf";
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return "image/jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => at(i) === b)) {
    return "image/png";
  }
  return null;
}
