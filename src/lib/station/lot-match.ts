// Workstations W4 — owner decision W1 (Phase 9, 9 Oct 2026): verifying a finished-goods lot at the
// preparation station by manual entry (J-15: no barcode yet). Pure: no database, shared by the
// server (/api/station/lots/match, /api/station/picks) and the unit tests.
//
//   · The LAST FOUR characters are accepted only as a convenience, and only when they match ONE lot
//     number among the lots reserved for this exact order line (and SKU).
//   · More than one reserved lot number ends with them → AMBIGUOUS: the full number is required.
//   · The FULL number always works when it is one of the line's reserved lot numbers.
//   · Anything else → NONE: nothing is accepted, nothing is recorded ("wrong lot").
//
// Lots are compared by their NUMBER: two lots of the same roast and the same SKU (two packing runs)
// carry the same number on the box and are the same thing to the person counting.

export const LOT_SUFFIX_LENGTH = 4;

/** Arabic-Indic digits to Latin, upper case, no spaces or dashes: what was printed, as typed. */
export function normalizeLotEntry(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .toUpperCase()
    .replace(/[\s\-_/]/g, "")
    .slice(0, 40);
}

export type LotCandidate = { batchNumber: string };
export type LotMatch =
  | { kind: "unique"; batchNumber: string; by: "suffix" | "full" }
  | { kind: "ambiguous"; candidates: string[]; fullLength: number | null }
  | { kind: "none" }
  | { kind: "too_short" };

/** Match a typed entry against the lot numbers reserved for one order line (see the header). */
export function matchLot(entryRaw: unknown, candidates: readonly LotCandidate[]): LotMatch {
  const entry = normalizeLotEntry(entryRaw);
  if (entry.length < LOT_SUFFIX_LENGTH) return { kind: "too_short" };
  const numbers = [...new Set(candidates.map((c) => c.batchNumber))];
  const full = numbers.filter((n) => normalizeLotEntry(n) === entry);
  if (full.length === 1) return { kind: "unique", batchNumber: full[0], by: "full" };
  if (entry.length !== LOT_SUFFIX_LENGTH) return { kind: "none" };
  const bySuffix = numbers.filter((n) => normalizeLotEntry(n).endsWith(entry));
  if (bySuffix.length === 1) return { kind: "unique", batchNumber: bySuffix[0], by: "suffix" };
  if (bySuffix.length > 1) {
    const lengths = [...new Set(bySuffix.map((n) => normalizeLotEntry(n).length))];
    return { kind: "ambiguous", candidates: bySuffix.sort(), fullLength: lengths.length === 1 ? lengths[0] : null };
  }
  return { kind: "none" };
}

/**
 * Units of one lot number to record from the lots that carry it (oldest first), never more than
 * each still holds for the line. Returns the per-lot split, or null when `units` is more than the
 * number holds.
 */
export function splitPick(lots: readonly { lotId: string; pickable: number }[], units: number): { lotId: string; units: number }[] | null {
  if (!Number.isInteger(units) || units <= 0) return null;
  let left = units;
  const out: { lotId: string; units: number }[] = [];
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, l.pickable));
    if (take > 0) { out.push({ lotId: l.lotId, units: take }); left -= take; }
  }
  return left === 0 ? out : null;
}

/**
 * Settling picks when dispatch delivers (POST /api/deliveries): the delivered units close the
 * line's open picks — those from a lot the delivery drew first, then the oldest — and a pick only
 * partly covered is split. Pure: returns what to mark DELIVERED and what stays open.
 */
export function settlePicks<T extends { id: string; units: number; lotId: string; status: string; createdAt: Date | string }>(
  open: readonly T[], delivered: number, deliveredLots: readonly string[] = [],
): { settle: { id: string; units: number; rest: number }[] } {
  const order = [...open].sort((a, b) =>
    Number(deliveredLots.includes(b.lotId)) - Number(deliveredLots.includes(a.lotId))
    || Number(b.status === "HANDED_OFF") - Number(a.status === "HANDED_OFF")
    || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  let left = Math.max(0, Math.trunc(delivered));
  const settle: { id: string; units: number; rest: number }[] = [];
  for (const p of order) {
    if (left <= 0) break;
    const take = Math.min(left, p.units);
    settle.push({ id: p.id, units: take, rest: p.units - take });
    left -= take;
  }
  return { settle };
}
