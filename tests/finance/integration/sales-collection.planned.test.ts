// PLANNED — runs after feature/sales-crm-commissions is merged (SalesCollection exists).
// Until then every case is skipped, so the suite documents the contract without faking it.
//
// Scenario: one approved sales collection, one bank receipt, no duplicates anywhere.
//   1. Salesperson submits a BANK_TRANSFER collection of 8,050.00 (ref IN-2291); a different
//      user with commissions.collection_verify approves it. → CollectionEvent + commission
//      accrual exist; the finance pool, allocations and budget actuals are UNCHANGED.
//   2. The bank statement (CSV) with +8,050.00 / IN-2291 is imported. → exactly one
//      BankTransaction; eligible cash +8,050.00 once.
//   3. Reviewer links it: POST /api/finance/transactions/:id/matches
//      { targetType: "SALES_COLLECTION", targetId }. decideCollectionMatch returns MATCH.
//      → one active BankTransactionMatch; AllocationRun count for the line ≤ 1; the RC budget
//      actual counts 8,050.00 once (from the bank line's classification, never from the
//      collection).
//   4. Linking the same collection to a second line → 409 (one-to-one), and linking a second
//      collection to the same line → 409.
//   5. The collection is REVERSED in Sales. → the finance match is flagged for review; cash,
//      allocations and actuals are untouched (the money is still in the bank) until a person
//      records a refund line.
//   6. Re-importing the statement → 0 inserted (fingerprint), match unchanged.
import { test } from "node:test";

const pending = { skip: "requires SalesCollection from feature/sales-crm-commissions (see docs/finance/SALES_INTEGRATION.md)" };

test("approving a collection moves no finance cash, allocation or actual", pending, () => {});
test("statement receipt is the only cash; allocation and actual counted once", pending, () => {});
test("link one collection ↔ one bank line; second link either way is refused", pending, () => {});
test("a reversed collection flags the match and changes no cash until a refund line exists", pending, () => {});
test("re-import after linking inserts nothing and keeps the match", pending, () => {});
