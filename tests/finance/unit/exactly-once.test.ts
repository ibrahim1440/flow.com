// Exactly-once cash rules (pure). Run: npm run test:finance:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPendingOut, lineEffect, pairEffect, eligibleEffect, categoryCommitment, matchReservationPayments, type CashLine } from "../../../src/lib/finance/exactly-once";
import { addDays } from "../../../src/lib/finance/dates";

const L = (o: Partial<CashLine> & { id: string; amount: number }): CashLine => ({
  cashAccountId: "A", status: "CONFIRMED", source: "MANUAL", reviewStatus: "NEEDS_REVIEW", transferPeerId: null, possibleDuplicateOfId: null, paymentsBooked: 0, ...o,
});

test("pending outgoing line: committed when a person recorded it, a payment is booked, or it was reviewed", () => {
  assert.equal(classifyPendingOut(L({ id: "1", amount: -1, status: "PENDING" })), "COMMITTED");
  assert.equal(classifyPendingOut(L({ id: "2", amount: -1, status: "PENDING", source: "CSV_IMPORT" })), "AWAITING_REVIEW");
  assert.equal(classifyPendingOut(L({ id: "3", amount: -1, status: "PENDING", source: "CSV_IMPORT", reviewStatus: "REVIEWED" })), "COMMITTED");
  assert.equal(classifyPendingOut(L({ id: "4", amount: -1, status: "PENDING", source: "CSV_IMPORT", paymentsBooked: 1 })), "COMMITTED");
  assert.equal(classifyPendingOut(L({ id: "5", amount: -1, status: "PENDING", transferPeerId: "x" })), "INTERNAL");
});

test("line effects: confirmed counts; committed pending outflow counts; pending inflow and unreviewed import do not", () => {
  assert.equal(lineEffect(L({ id: "a", amount: 500 })), 500);
  assert.equal(lineEffect(L({ id: "b", amount: -500, status: "PENDING" })), -500);
  assert.equal(lineEffect(L({ id: "c", amount: 500, status: "PENDING" })), 0);
  assert.equal(lineEffect(L({ id: "d", amount: -500, status: "PENDING", source: "CSV_IMPORT" })), 0);
  assert.equal(lineEffect(L({ id: "e", amount: -500, status: "VOID" })), 0);
});

test("a possible-duplicate pair counts once, whatever the combination", () => {
  const recordedPending = L({ id: "p", amount: -700, status: "PENDING" });
  const importedConfirmed = L({ id: "d", amount: -700, source: "CSV_IMPORT", possibleDuplicateOfId: "p" });
  assert.equal(pairEffect(importedConfirmed, recordedPending), -700);
  const r = eligibleEffect([recordedPending, importedConfirmed]);
  assert.equal(r.effect, -700, "not −1,400");
  assert.equal(r.pendingOutCommitted, 0, "the pending twin is superseded by the confirmed line");
  assert.equal(r.duplicatePairs, 1);
  const twoConfirmed = eligibleEffect([L({ id: "x", amount: 300 }), L({ id: "y", amount: 300, source: "CSV_IMPORT", possibleDuplicateOfId: "x" })]);
  assert.equal(twoConfirmed.effect, 300, "a duplicated receipt never inflates cash");
  const reviewedApart = eligibleEffect([L({ id: "x", amount: 300 }), L({ id: "y", amount: 300, source: "CSV_IMPORT" })]);
  assert.equal(reviewedApart.effect, 600, "once reviewed as separate (flag cleared), both count");
});

test("category commitment = max(balance, approved reservations, 0)", () => {
  assert.equal(categoryCommitment(5000, 2000), 5000, "reservation inside the balance adds nothing");
  assert.equal(categoryCommitment(5000, 6000), 6000, "approved commitment beyond the balance holds back the excess");
  assert.equal(categoryCommitment(-1000, 0), 0, "an overspent category frees nothing");
});

test("an approved request and its unlinked payment line are matched one-to-one", () => {
  const res = [{ id: "r1", categoryId: "c", amount: 6000, createdDate: "2026-09-20" }, { id: "r2", categoryId: "c", amount: 6000, createdDate: "2026-09-21" }];
  const lines = [
    { id: "l1", amount: -6000, txnDate: "2026-09-22", paymentsBooked: 0, transferPeerId: null, status: "PENDING" as const },
    { id: "l0", amount: -6000, txnDate: "2026-09-10", paymentsBooked: 0, transferPeerId: null, status: "CONFIRMED" as const }, // too early
    { id: "l2", amount: -6000, txnDate: "2026-09-23", paymentsBooked: 6000, transferPeerId: null, status: "PENDING" as const }, // already linked
    { id: "l3", amount: -5999, txnDate: "2026-09-23", paymentsBooked: 0, transferPeerId: null, status: "PENDING" as const }, // other amount
  ];
  const { matches, ambiguous } = matchReservationPayments(res, lines, addDays);
  assert.deepEqual(matches, [{ reservationId: "r1", categoryId: "c", lineId: "l1", amount: 6000 }], "r2 has no second line; nothing is matched twice");
  assert.equal(ambiguous, 0);
  const two = matchReservationPayments([res[0]], [lines[0], { ...lines[0], id: "l4", txnDate: "2026-09-24" }], addDays);
  assert.equal(two.matches.length, 1);
  assert.equal(two.ambiguous, 1, "two candidate lines: counted once and reported as ambiguous");
});
