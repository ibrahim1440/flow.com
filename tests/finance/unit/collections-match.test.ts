// Decision rule for linking one approved sales collection to one bank receipt.
// Run: npm run test:finance:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCollectionMatch, collectionMinor, collectionDate, type CollectionCandidate, type BankReceipt } from "../../../src/lib/finance/collections-match";

const receipt = (o: Partial<BankReceipt> = {}): BankReceipt => ({ id: "t1", amount: 805_000, txnDate: "2026-09-24", status: "CONFIRMED", bankReference: "IN-2291", hasCollectionMatch: false, ...o });
const coll = (o: Partial<CollectionCandidate> = {}): CollectionCandidate => ({
  id: "c1", status: "APPROVED", paymentMethod: "BANK_TRANSFER", amountGross: "8050.00", currency: "SAR",
  referenceNumber: "IN-2291", collectedAt: "2026-09-23T10:00:00.000Z", linkedTxnId: null, ...o,
});

test("amounts and dates convert exactly: Decimal SAR → halalas, UTC instant → Riyadh date", () => {
  assert.equal(collectionMinor("8050.00"), 805_000);
  assert.equal(collectionMinor("0.1"), 10);
  assert.equal(collectionMinor("12.345"), null, "more than 2 dp is refused, never rounded");
  assert.equal(collectionDate("2026-09-23T21:30:00.000Z"), "2026-09-24", "00:30 Riyadh is the next day");
});

test("one approved collection with the same reference → MATCH by reference", () => {
  assert.deepEqual(decideCollectionMatch(receipt(), [coll()]), { kind: "MATCH", collectionId: "c1", basis: "REFERENCE" });
  assert.equal(decideCollectionMatch(receipt({ bankReference: " in-2291 " }), [coll()]).kind, "MATCH", "reference is normalised");
});

test("no reference on the bank line → MATCH on exact amount within the window", () => {
  assert.deepEqual(decideCollectionMatch(receipt({ bankReference: null }), [coll({ referenceNumber: null })]), { kind: "MATCH", collectionId: "c1", basis: "AMOUNT_AND_DATE" });
  assert.equal(decideCollectionMatch(receipt({ bankReference: null, txnDate: "2026-10-01" }), [coll()]).kind, "NONE", "8 days after is outside the window");
  assert.equal(decideCollectionMatch(receipt({ bankReference: null, txnDate: "2026-09-20" }), [coll()]).kind, "MATCH", "3 days before is inside");
});

test("a different reference on both sides refutes an amount/date coincidence", () => {
  assert.equal(decideCollectionMatch(receipt({ bankReference: "IN-9999" }), [coll()]).kind, "NONE");
});

test("two approved candidates → AMBIGUOUS; a person chooses", () => {
  const d = decideCollectionMatch(receipt({ bankReference: null }), [coll({ referenceNumber: null }), coll({ id: "c2", referenceNumber: null })]);
  assert.deepEqual(d, { kind: "AMBIGUOUS", collectionIds: ["c1", "c2"] });
});

test("status gate: pending is awaiting verification; rejected and reversed are never offered", () => {
  assert.deepEqual(decideCollectionMatch(receipt(), [coll({ status: "PENDING_VERIFICATION" })]), { kind: "AWAITING_VERIFICATION", collectionIds: ["c1"] });
  assert.equal(decideCollectionMatch(receipt(), [coll({ status: "REJECTED" })]).kind, "NONE");
  assert.equal(decideCollectionMatch(receipt(), [coll({ status: "REVERSED" })]).kind, "NONE");
});

test("one-to-one: a linked collection or a linked bank line is never matched again", () => {
  assert.equal(decideCollectionMatch(receipt(), [coll({ linkedTxnId: "t0" })]).kind, "NONE", "collection already settled by another line");
  assert.equal(decideCollectionMatch(receipt({ hasCollectionMatch: true }), [coll()]).kind, "NONE", "line already settles a collection");
});

test("only confirmed money in; only 1:1 payment methods; SAR only; exact amount", () => {
  assert.equal(decideCollectionMatch(receipt({ status: "PENDING" }), [coll()]).kind, "NONE");
  assert.equal(decideCollectionMatch(receipt({ status: "VOID" }), [coll()]).kind, "NONE");
  assert.equal(decideCollectionMatch(receipt({ amount: -805_000 }), [coll()]).kind, "NONE");
  for (const m of ["CASH", "POS_CARD", "OTHER"] as const) assert.equal(decideCollectionMatch(receipt(), [coll({ paymentMethod: m })]).kind, "NONE", m);
  assert.equal(decideCollectionMatch(receipt(), [coll({ paymentMethod: "CHEQUE" })]).kind, "MATCH");
  assert.equal(decideCollectionMatch(receipt(), [coll({ currency: "USD" })]).kind, "NONE");
  assert.equal(decideCollectionMatch(receipt({ amount: 804_999 }), [coll()]).kind, "NONE", "one halala short is not the same money");
});
