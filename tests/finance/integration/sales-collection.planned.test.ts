// Sales collection ↔ bank receipt — SPECIFICATION (skipped on this branch).
//
// SalesCollection lives on feature/sales-crm-commissions, which is not merged and has no
// approved integration commit (no pull request exists for it). These five tests are
// IMPLEMENTED and PASS (5/5, with the whole finance suite 33/33) on the disposable local
// branch trial/finance-sales-integration-20260926 @ bbf8008
// (= feature/sales-crm-commissions aa9ef8c + this branch 4bb76bb), using
// docs/finance/integration/sales-collection-integration.patch. When an approved integration
// commit exists, apply that patch there and delete the skips — do not delete the tests.
//
// Fixture: a deal with an ACCEPTED quotation of 7,000.00 + 1,050.00 VAT = 8,050.00; a sales
// rep submits a BANK_TRANSFER collection of 8,050.00 (ref IN-2291) through
// submitCollection; a different employee approves it through approveCollection.
import { test } from "node:test";

const needs = { skip: "requires SalesCollection (feature/sales-crm-commissions); implemented on trial/finance-sales-integration-20260926 — see docs/finance/SALES_INTEGRATION.md §4" };

// Approving creates the CollectionEvent (commission input) and nothing in Finance:
// bank lines, eligible cash, allocation entries/runs and budget receipts actual unchanged.
test("approving a collection moves no finance cash, allocation or actual", needs, () => {});

// Statement +8,050.00 / IN-2291 imported once → decideCollectionMatch = MATCH by reference;
// link; the same link again returns the same match (retry); VAT on the link = 1,050.00 from
// the collection; review + three concurrent runAllocation → exactly one AllocationRun,
// allocated ≤ 8,050.00, a later retry changes nothing; eligible cash 8,050.00 once;
// RC-WHOLESALE actual 8,050.00 once; one SALES_COLLECTION match.
test("statement receipt is the only cash; allocation and actual counted once, even when retried or raced", needs, () => {});

// Linking the same collection to a second line → 409; a second collection to a line that
// already settles one → 409; a direct INSERT of a duplicate active link violates the partial
// unique index; two concurrent identical links resolve to one match.
test("one collection ↔ one bank line: a second link either way is refused (service and database)", needs, () => {});

// reverseCollection after linking + allocating: bank lines, eligible cash, allocations and
// runs unchanged; the overview raises COLLECTION_REVERSED; the reversed collection cannot be
// linked to another line.
test("a reversed collection flags the link and changes no cash until a refund line exists", needs, () => {});

// Importing the same statement again inserts and attaches nothing; the link is unchanged.
test("re-import after linking inserts nothing and keeps the link", needs, () => {});
