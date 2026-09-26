// Exactly-once cash: one economic payment (or receipt) reduces (or raises) the cash available
// for allocation once, however many records represent it. Pure — no database.
//
// Representations of one payment, and which one counts:
//   reservation (approved)      → inside the category's commitment: max(balance, reserved, 0)
//   recorded payment (PAYMENT)  → lowers the category balance and releases the reservation, so
//                                 the category's commitment falls by the amount…
//   pending outgoing bank line  → …while eligible cash falls by the same amount (a confirmed
//                                 commitment), so what is available is unchanged
//   settled (confirmed) line    → moves from "pending" to book cash: eligible unchanged
//   duplicate statement row     → never inserted (fingerprint), or confirms the recorded line
//   settled copy of a pending   → confirms that pending line (import status SETTLES)
//   possible duplicate pair     → counted once until a reviewer merges or separates them
//   line not yet linked to its  → an outgoing line for exactly an approved request's amount,
//   approved request              unlinked, is treated as that request's payment (counted
//                                 once) until "Record payment made" links it
//
// A pending outgoing line is a CONFIRMED COMMITMENT when a person recorded it (manual entry),
// a category payment is booked against it, or a reviewer marked it reviewed. An imported
// pending line that nobody has confirmed is AWAITING REVIEW: shown, alerted, not deducted.
// Internal transfers between company accounts are not outflows.
import type { Minor } from "./money";

export type CashLine = {
  id: string;
  cashAccountId: string;
  /** Signed halalas. */
  amount: Minor;
  status: "CONFIRMED" | "PENDING" | "VOID";
  source: "MANUAL" | "CSV_IMPORT" | "CONNECTOR";
  reviewStatus: "NEEDS_REVIEW" | "REVIEWED";
  transferPeerId: string | null;
  possibleDuplicateOfId: string | null;
  /** Net PAYMENT entries booked against this line (after reversals), halalas. */
  paymentsBooked: Minor;
};

export type PendingOutClass = "COMMITTED" | "AWAITING_REVIEW" | "INTERNAL";

export function classifyPendingOut(l: Pick<CashLine, "source" | "reviewStatus" | "transferPeerId" | "paymentsBooked">): PendingOutClass {
  if (l.transferPeerId) return "INTERNAL";
  if (l.source === "MANUAL" || l.paymentsBooked > 0 || l.reviewStatus === "REVIEWED") return "COMMITTED";
  return "AWAITING_REVIEW";
}

/** A line's own effect on eligible cash (before any duplicate pairing). Pending inflows never count. */
export function lineEffect(l: CashLine): Minor {
  if (l.status === "CONFIRMED") return l.amount;
  if (l.status === "PENDING" && l.amount < 0 && classifyPendingOut(l) === "COMMITTED") return l.amount;
  return 0;
}

/**
 * An unresolved possible-duplicate pair counts once. A confirmed (bank) line is the more
 * certain record; with two confirmed lines, or none, the more conservative effect is used.
 */
export function pairEffect(a: CashLine, b: CashLine): Minor {
  const ac = a.status === "CONFIRMED", bc = b.status === "CONFIRMED";
  if (ac && bc) return Math.min(a.amount, b.amount);
  if (ac) return a.amount;
  if (bc) return b.amount;
  return Math.min(lineEffect(a), lineEffect(b));
}

export type EligibleBreakdown = {
  /** Σ effects, each economic movement once. */
  effect: Minor;
  /** Pending outgoing commitments deducted (positive halalas). */
  pendingOutCommitted: Minor;
  /** Pending outgoing lines not deducted until reviewed (positive halalas). */
  pendingOutAwaitingReview: Minor;
  /** Pending incoming lines, never counted (positive halalas). */
  pendingIn: Minor;
  /** Unresolved possible-duplicate pairs and the amount counted only once because of them. */
  duplicatePairs: number;
  duplicateAdjustment: Minor;
};

/** Lines of one pool's unrestricted accounts (VOID lines may be passed; they count zero). */
export function eligibleEffect(lines: CashLine[]): EligibleBreakdown {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out: EligibleBreakdown = { effect: 0, pendingOutCommitted: 0, pendingOutAwaitingReview: 0, pendingIn: 0, duplicatePairs: 0, duplicateAdjustment: 0 };
  for (const l of lines) {
    if (l.status === "VOID") continue;
    out.effect += lineEffect(l);
    if (l.status === "PENDING" && l.amount > 0) out.pendingIn += l.amount;
    if (l.status === "PENDING" && l.amount < 0) {
      const k = classifyPendingOut(l);
      if (k === "COMMITTED") out.pendingOutCommitted += -l.amount;
      if (k === "AWAITING_REVIEW") out.pendingOutAwaitingReview += -l.amount;
    }
  }
  const seen = new Set<string>();
  for (const d of lines) {
    if (d.status === "VOID" || !d.possibleDuplicateOfId) continue;
    const p = byId.get(d.possibleDuplicateOfId);
    if (!p || p.status === "VOID" || p.cashAccountId !== d.cashAccountId) continue;
    if (Math.sign(d.amount) !== Math.sign(p.amount)) continue;
    const key = [d.id, p.id].sort().join("|");
    if (seen.has(key) || seen.has(d.id) || seen.has(p.id)) continue;
    seen.add(key); seen.add(d.id); seen.add(p.id);
    const separate = lineEffect(d) + lineEffect(p);
    const once = pairEffect(d, p);
    if (separate !== once) {
      out.effect += once - separate;
      out.duplicateAdjustment += Math.abs(once - separate);
      // A pending commitment superseded by its confirmed twin is no longer "pending".
      for (const x of [d, p]) if (x.status === "PENDING" && x.amount < 0 && classifyPendingOut(x) === "COMMITTED" && (d.status === "CONFIRMED" || p.status === "CONFIRMED")) out.pendingOutCommitted -= -x.amount;
    }
    out.duplicatePairs++;
  }
  return out;
}

export type OpenReservation = { id: string; categoryId: string; amount: Minor; createdDate: string };
export type OutgoingCandidate = { id: string; amount: Minor; txnDate: string; paymentsBooked: Minor; transferPeerId: string | null; status: CashLine["status"] };
export type ReservationPaymentMatch = { reservationId: string; categoryId: string; lineId: string; amount: Minor };

/** How far before the payment request a bank line may be dated and still be its payment. */
export const RESERVATION_MATCH_DAYS_BEFORE = 3;

/**
 * An approved payment request and an outgoing bank line with no category payment booked are
 * two records of ONE payment when the line is for exactly the reserved amount, in the same
 * branch, dated no earlier than 3 days before the request. Until someone records the payment
 * against the request ("Record payment made"), such a pair is counted once — as if linked —
 * and reported for review. One-to-one, oldest request first, earliest line first; `ambiguous`
 * counts requests that had more than one candidate line (still counted once, never twice).
 */
export function matchReservationPayments(reservations: OpenReservation[], lines: OutgoingCandidate[], addDays: (d: string, n: number) => string): { matches: ReservationPaymentMatch[]; ambiguous: number } {
  const free = lines
    .filter((l) => l.status !== "VOID" && l.amount < 0 && l.paymentsBooked === 0 && !l.transferPeerId)
    .sort((a, b) => (a.txnDate === b.txnDate ? a.id.localeCompare(b.id) : a.txnDate.localeCompare(b.txnDate)));
  const used = new Set<string>();
  const matches: ReservationPaymentMatch[] = [];
  let ambiguous = 0;
  for (const r of [...reservations].sort((a, b) => (a.createdDate === b.createdDate ? a.id.localeCompare(b.id) : a.createdDate.localeCompare(b.createdDate)))) {
    const from = addDays(r.createdDate, -RESERVATION_MATCH_DAYS_BEFORE);
    const cands = free.filter((l) => !used.has(l.id) && -l.amount === r.amount && l.txnDate >= from);
    if (cands.length === 0) continue;
    if (cands.length > 1) ambiguous++;
    used.add(cands[0].id);
    matches.push({ reservationId: r.id, categoryId: r.categoryId, lineId: cands[0].id, amount: r.amount });
  }
  return { matches, ambiguous };
}

/**
 * What a category holds back from new allocation: its balance, or its approved commitments
 * when they exceed the balance. An overspent category (negative balance) holds nothing and
 * does not free cash for others.
 */
export function categoryCommitment(balance: Minor, approvedReserved: Minor): Minor {
  return Math.max(balance, approvedReserved, 0);
}
