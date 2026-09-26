// Matching an approved sales collection (feature/sales-crm-commissions: SalesCollection) to
// the bank receipt that actually brought the money in. Pure: no database, no I/O.
//
// Not wired yet — SalesCollection does not exist on this branch, and the match service
// refuses targetType SALES_COLLECTION until it does (server/transactions.ts). This module is
// the agreed decision rule for that integration, tested now so the merge only adds wiring.
// See docs/finance/SALES_INTEGRATION.md.
//
// What a match means, and what it must never do:
//   - The BANK LINE is the cash. A collection is a salesperson's claim that a customer paid,
//     verified by Finance; it never creates a BankTransaction, an allocation or a budget
//     actual. Linking the two adds only a BankTransactionMatch row.
//   - One collection ↔ one bank line. A collection already linked is not offered again, and a
//     bank line already linked to a collection is not matched to a second one.
//   - Only APPROVED collections are matched automatically. PENDING_VERIFICATION is reported as
//     "awaiting verification"; REJECTED and REVERSED are never offered.
//   - Only BANK_TRANSFER and CHEQUE are 1:1 with a bank line. CASH is banked in batched
//     deposits and POS_CARD in net-of-fee settlements, so those are linked by a person.
import { toMinor, type Minor } from "./money";
import { addDays, riyadhDateString } from "./dates";

export type CollectionStatus = "PENDING_VERIFICATION" | "APPROVED" | "REJECTED" | "REVERSED";
export type CollectionMethod = "BANK_TRANSFER" | "CASH" | "CHEQUE" | "POS_CARD" | "OTHER";

export type CollectionCandidate = {
  id: string;
  status: CollectionStatus;
  paymentMethod: CollectionMethod;
  /** SalesCollection.amountGross — Decimal(18,2) SAR as a string ("8050.00"). Cash received includes VAT. */
  amountGross: string;
  currency: string;
  referenceNumber: string | null;
  /** SalesCollection.collectedAt — a UTC instant (ISO string). */
  collectedAt: string;
  /** Id of the bank line this collection is already linked to (active match), if any. */
  linkedTxnId: string | null;
};

export type BankReceipt = {
  id: string;
  /** Signed halalas. */
  amount: Minor;
  /** YYYY-MM-DD (Asia/Riyadh). */
  txnDate: string;
  status: "CONFIRMED" | "PENDING" | "VOID";
  bankReference: string | null;
  /** True when this bank line already carries an active SALES_COLLECTION match. */
  hasCollectionMatch: boolean;
};

/** Bank posting lag around the collection date: 3 days before (dated slips) to 7 after (cheques clearing). */
export const COLLECTION_WINDOW = { before: 3, after: 7 } as const;

export type MatchDecision =
  | { kind: "MATCH"; collectionId: string; basis: "REFERENCE" | "AMOUNT_AND_DATE" }
  | { kind: "AMBIGUOUS"; collectionIds: string[] }
  | { kind: "AWAITING_VERIFICATION"; collectionIds: string[] }
  | { kind: "NONE"; reason: string };

const normRef = (r: string | null | undefined) => (r ?? "").replace(/\s+/g, "").toUpperCase();

/** SAR decimal string → halalas, refusing anything that is not an exact 2-dp amount. */
export function collectionMinor(amountGross: string): Minor | null {
  if (!/^\d+(\.\d{1,2})?$/.test(amountGross.trim())) return null;
  return toMinor(amountGross.trim());
}

/** The Riyadh calendar date of a UTC instant. */
export function collectionDate(collectedAt: string): string {
  return riyadhDateString(new Date(collectedAt));
}

export function decideCollectionMatch(receipt: BankReceipt, candidates: CollectionCandidate[]): MatchDecision {
  if (receipt.amount <= 0) return { kind: "NONE", reason: "Only money received can settle a sales collection." };
  if (receipt.status !== "CONFIRMED") return { kind: "NONE", reason: "The bank line is not confirmed; a pending or void line is not cash." };
  if (receipt.hasCollectionMatch) return { kind: "NONE", reason: "This bank line is already linked to a sales collection." };

  const eligible = candidates.filter((c) => {
    if (c.currency !== "SAR") return false;
    if (c.linkedTxnId) return false;
    if (c.paymentMethod !== "BANK_TRANSFER" && c.paymentMethod !== "CHEQUE") return false;
    if (collectionMinor(c.amountGross) !== receipt.amount) return false;
    const d = collectionDate(c.collectedAt);
    return receipt.txnDate >= addDays(d, -COLLECTION_WINDOW.before) && receipt.txnDate <= addDays(d, COLLECTION_WINDOW.after);
  });
  const approved = eligible.filter((c) => c.status === "APPROVED");
  const pending = eligible.filter((c) => c.status === "PENDING_VERIFICATION");

  const ref = normRef(receipt.bankReference);
  if (ref) {
    const byRef = approved.filter((c) => normRef(c.referenceNumber) === ref);
    if (byRef.length === 1) return { kind: "MATCH", collectionId: byRef[0].id, basis: "REFERENCE" };
    if (byRef.length > 1) return { kind: "AMBIGUOUS", collectionIds: byRef.map((c) => c.id) };
  }
  // A differing reference on both sides is evidence against, not missing evidence.
  const unrefuted = approved.filter((c) => !(ref && c.referenceNumber && normRef(c.referenceNumber) !== ref));
  if (unrefuted.length === 1) return { kind: "MATCH", collectionId: unrefuted[0].id, basis: "AMOUNT_AND_DATE" };
  if (unrefuted.length > 1) return { kind: "AMBIGUOUS", collectionIds: unrefuted.map((c) => c.id) };
  if (pending.length > 0) return { kind: "AWAITING_VERIFICATION", collectionIds: pending.map((c) => c.id) };
  return { kind: "NONE", reason: "No approved bank-transfer or cheque collection has this amount within the date window." };
}
