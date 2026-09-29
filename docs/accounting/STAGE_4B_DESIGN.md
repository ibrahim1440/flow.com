# Stage 4b — operational integration and correctness gaps

Repository: [ibrahim1440/flow.com](https://github.com/ibrahim1440/flow.com), branch
`feature/accounting-ledger-core` (**not pushed**; GitHub links to files on this branch resolve only
after it is pushed). Everything here is implemented and tested **locally on synthetic data**. Loss
bands, cost-pool rates, the sales-cost timing and the operations-policy approval used in tests and
in the fixture are **synthetic test assumptions**, not company policy. Nothing here is accepted.

This stage answers the review of stage 4. Each item below says what was built, which quantity is
authoritative, and where the evidence is. What is still open is in §10 and in
[`STAGE_4B_EVIDENCE.md`](STAGE_4B_EVIDENCE.md).

## 1. Operational integration (review item 1)

Every operational write that changes stock records an `InvOpsEvent` **in the same transaction**
(`recordStockEvent`, `src/lib/accounting/ops-integration.ts`). The event carries the quantities the
operational system itself treats as authoritative; the accounts never re-derive or re-enter them.

| Workflow (screen → route) | Authoritative quantity | Document |
|---|---|---|
| Purchases → `POST /api/purchases` | `PurchaseRecord.quantity` (kg) × `costPerUnit` | RECEIPT at the sales-default location, Dr inventory / Cr GRNI |
| Roasting → `POST /api/roasting-batches` | batch `greenBeanQuantity` in, `roastedBeanQuantity` out | PRODUCTION (process ROASTING, approved band, approved conversion pools) |
| Roasting → `DELETE /api/roasting-batches/[id]` | the batch's kg; `restock` flag | restock: ADJUSTMENT (roasted out, green back at the cost it left at); no restock: ISSUE (write-off); not yet in the accounts: the roast is dismissed |
| QC → `POST /api/qc/[batchId]/finalize`, `POST /api/qc-records/bulk-finalize` (outcome Rejected, a terminal state) | roasted kg still on the batch | ISSUE (QC waste, 5500) — once per batch |
| Blending → `POST /api/roasting-batches/blend` | kg taken from each source batch; blend kg out | PRODUCTION (BLENDING) |
| Packing → `POST /api/roasting-batches/[id]/pack` (`commitPackaging`) | roasted grams drawn (packed + recorded loss), materials drawn (BOM), whole units per standard lot; a partial package as the share of a unit its grams hold; a top-up as the difference (a package that reaches weight becomes exactly one unit) | PRODUCTION (PACKING), outputs carry `lotId` |
| Dispatch → `POST /api/deliveries` | whole SKU units (`consumeFinishedUnits`) | TRANSFER to "delivered, not invoiced" (DLV, account 1176), carrying `orderItemId` and `lotId` |
| Stock count → `POST /api/inventory/adjust`, `PATCH /api/materials/[id]` | signed difference entered by the counter, with its reason | ADJUSTMENT (new document type): out at cost / in at average cost, against inventory variance |
| New green coffee / material with a quantity | the entered quantity | **held**: it has no cost and its counter-entry is an opening-balance decision (§10) |
| Invoice for the order line | invoice quantity (units, converted by the item's units) | SALE_ISSUE from that order line's dispatched layers at DLV |
| Physical customer return | the return's received quantity | CUSTOMER_RETURN (§3) |

**Unknown writers are exceptions, not gaps.** A deferred constraint trigger on `InventoryMovement`
adds an `UNINTEGRATED` event (BLOCKED, with the movement's details) whenever a transaction writes a
stock movement without recording an event. Tested by writing a movement directly
(`ops-integration.test.ts`, robustness test).

**Idempotent.** One document per event (unique `sourceType = OPS`, `sourceId = event id`); events are
unique on `(kind, sourceId, seq)`; the operational routes keep their own idempotency keys. A retry, a
second worker or a crash between steps never produces a second document.

**Approvals preserved.** With the `inventory.operations` policy approved, a document within tolerance
(items linked, cost known, production loss within the single approved band of its process) is
approved under that policy (`approvedBy = system:policy:inventory.operations:vN`) and posted.
Otherwise the document is prepared in the name of the person who recorded the operation and waits
for an accountant (HELD), who approves it under the normal four-eyes rule; posting it completes the
event. Loss above the band is always held for an accountant. Operational approvals (QC, order
approval, surplus override) are unchanged: the integration runs after the operational transaction
commits and never changes the operational record.

**Pending and failed effects are visible**: on the operational screens (purchases, roasting,
packing, dispatch show an accounting-status chip from `GET /api/inventory/accounting-status`, status
and reason only, no amounts) and in the accounting exception queue
(`/dashboard/accounting/inventory/exceptions`: retry, dismiss with a reason, or link the posted
document an accountant made for it).

**Reconciliation detects exceptions.** `GET /api/accounting/inventory/reports/ops-reconciliation`
compares, per linked item, the operational quantity (green kg, material on hand, roasted kg left on
batches, SKU units in lots) with the accounting quantity at the sales location. A difference is
MATCHED, EXPLAINED (open events touch the item) or an EXCEPTION. Nobody re-enters anything.

**Failure handling.** A posting failure (stock not in the accounts yet, period closed, D-1 open,
insufficient roasted coffee because the roast is blocked) backs off 1, 2, 4 … 60 minutes and
retries; a missing mapping is BLOCKED until someone links the item and retries; a worker that dies
leaves a lease that expires and is taken over. "Run automatic postings" processes operational events,
then cost of sales, then ledger events.

Proof through the operational routes: `tests/accounting/http/ops-integration.test.mjs` logs in as an
operations user with no accounting access and drives purchase → roast → QC → pack → dispatch →
invoice (built from the order) → credit notes → count → cancelled batch → blend → QC rejection →
packaging-material count, then checks each document, journal and the invoice's cost of sales against
the dispatched cost. Proof through the screens themselves: `tests/accounting/visual/ops-forms.mjs`
fills the purchase form and the roast-to-stock form in the browser and checks the accounting chip
and the posted documents.

## 2. Cost of sales is durable (review item 2)

A database trigger creates an `InvCosting` record in the transaction that posts an invoice (and
re-opens it when the invoice is reversed), so a crash between posting and costing leaves work that
is found. The processor (`sales-costing.ts`) is state-based and idempotent; records are leased
(2 min) and back off on failure. Statuses: PENDING, AWAITING_POLICY, AWAITING_DISPATCH, COSTED,
NOT_REQUIRED, BLOCKED, FAILED, CANCELLED, UNCOSTED — all shown on the invoice and in the queue.

- **Lines are classified explicitly**: GOODS (an inventory item, directly or through the SKU) or
  NON_STOCK (services, fees). A line that is neither is BLOCKED with its reason; nothing is skipped.
- **Fulfilment location** is on the invoice (default: the sales-default location). An order line is
  costed from the goods dispatched for it (DLV); if nothing has been dispatched it waits
  (AWAITING_DISPATCH), and cancelling it before fulfilment moves nothing (CANCELLED).
- **Unit conversion** through the item's units (e.g. a carton of 12 l).
- **Timing** follows `AccountingSettings.salesCostTiming`. Undecided → AWAITING_POLICY (provisional
  only in an isolated test database). `WITH_REVENUE` is the only option implemented; the invoice date
  is used **only** under that setting, which is a decision for the accountant (DECISION_PACK §4), not
  an assumption.
- **Delayed costing recovery.** When later movements already exist, or the invoice's period is
  closed, back-dating would change costs already issued. The system document is then booked on the
  first day it can be (after the last movement it would disturb, in the first open period), keeping
  `originalDate` and `lateReason`; the margin report marks the invoice's period BOOKED_LATER instead
  of showing a zero cost. Tested: insufficient stock received later, a missing mapping fixed later, a
  closed period (`stage4b-workflows.test.ts` B).

## 3. Invoice correction is separate from physical returns (review item 3)

`returnForReversedInvoice` is removed. Reversing an invoice **never** brings goods back: its cost
moves from COGS to "delivered, not invoiced" (SALE_REVERSAL, Dr 1176 / Cr 5100).

| Case | Workflow | Stock |
|---|---|---|
| Correction or reissue without goods moving | reverse the invoice; issue a new one with `replacesInvoiceId` | none: the reissue takes the cost back from DLV |
| Confirmed physical return (full or partial) | `CustomerReturn`: recorded → received by the warehouse (`inv_return_receive`, day + evidence) → approved by a third person → posted | back at the cost it left at; damaged units written off |
| Cancellation before fulfilment | reverse the invoice of an undispatched order line | none (costing CANCELLED) |
| Refund or price credit, no goods | credit note `creditType = PRICE_ADJUSTMENT` | none |
| Credit for returned goods | credit note `creditType = RETURN_OF_GOODS`, naming a POSTED return of that invoice (once) | none (the return moved them) |

Duplicate restoration is prevented by the cap on what is still out with the customer (sold − returned
− being returned), a unique document per return, and a unique credit note per return.

## 4. Gross margin (review item 4)

`margin-report.ts`: rows are the posted revenue of every receivables document by journal date
(invoices, credit notes of both types, reversals). COGS comes from the inventory documents of each
invoice (issue, reversal, returns, write-offs) and cost traced to sold goods. Each row carries the
costing status; `complete` is false while any cost is missing, pending or booked later, and those
rows are listed. The report reconciles to the revenue accounts, sales returns (4900) and COGS (5100):
every difference is explained by named postings (manual journals, other inventory documents, waiting
journals) and the unexplained remainder is shown.

## 5. Manufacturing cost (review item 5)

**Conversion cost pools** (`conversion-costs.ts`): per process and kind (direct labour / production
overhead), a basis (kg in, kg out, units out, batch, labour hours, machine hours), a budget and a
normal capacity; rate = budget ÷ normal capacity (IAS 2 normal capacity: low output absorbs less, the
unabsorbed part stays in expense). Proposed by one person, approved by another, never edited once
approved. Absorption credits contra accounts 6190 / 6790 — the actual costs stay where they are
booked, so nothing is counted twice. Absorbed cost is part of the production input and so of the
abnormal-loss valuation. The absorption report shows absorbed vs actual per pool and flags
over-absorption.

**Later price differences and landed costs are traced, not expensed** (`trace()` in
`inventory-service.ts`): the share still on hand revalues the layer; the share consumed follows the
goods through production (outputs, and the abnormal-loss share to 5300), transfers, sales (COGS, with
the sale named), issues (their reason's account) and returns to the supplier (GRNI or variance).
Multi-level (green → roasted → packed → sold) is covered by the chain test.

## 6. Supplier credit notes and supplier-return settlement

Credit notes (`SupplierBill.kind = CREDIT_NOTE`, naming the original bill): Dr AP / Cr lines / Cr
input VAT; open item SUPPLIER_CREDIT. Stock lines are settled by one SUPPLIER_CREDIT inventory
document each: STOCK_RETURN clears the return's GRNI debit (difference to variance); a
STOCK_PRICE_ADJUSTMENT is traced like a price difference. Credits are applied to open bills of the
same supplier (`ApCreditAllocation`, with events for the AP sub-ledger) and can be released. The GRNI
explanation is: ledger = receipts − bills + landed costs without bill − returns awaiting credit +
credits awaiting settlement.

## 7. ACC-47 (mobile approvals)

See FIGMA_PARITY.md: the cards now carry loss, cost and journal rows (expected rows are labelled as
expected; no amount is shown before it is known).

## 8. Hand-worked multi-period examples

| Test | What is worked by hand |
|---|---|
| `inventory.test.ts` chain | January–March plus today: receipts, landed cost and price difference traced into roasted coffee and abnormal loss, packing, sale, physical return, transfer, café use, bakery, count, supplier return, calibration, and a reversal today that leaves the goods out |
| `stage4b-workflows.test.ts` A–D | returns and corrections over February, March and today; costing robustness; conversion cost; supplier credit notes |
| `ops-integration.test.ts` | purchase → roast → pack (standard, partial, top-up) → dispatch → invoice, count; robustness |

## 9. Tests written before fixes

`stage4-gaps.test.ts` (6 tests) and `stage4b-workflows.test.ts` were committed or saved failing
before the implementation (`docs/accounting/evidence/test-runs/stage4-gaps-before-fix.txt`,
`stage4b-workflows-before-fix.txt`). The layer-check defect found while re-deriving the chain test
is recorded in `stage4b-layer-check-before-fix.txt`. The operational-integration tests were written
together with the implementation, not before it.

## 10. Still open

- **Decisions** (DECISION_PACK): D-1 (costing method, price differences), sales-cost timing,
  approval of the operations policy, loss bands, conversion pools and rates, the opening-balance
  procedure for operational opening quantities.
- **Kilogram lots** from the old packing path were never in the accounts: their dispatch is an
  exception to resolve by hand.
- **One accounting location** for operational stock (the sales-default location); the operational
  system has no locations.
- Editing a roast's date after it posted does not re-date the posted document.
- Partial packages are carried as fractions of a unit (4 decimals); top-ups telescope so a completed
  package is exactly one unit.
- Figma frames for the new screens were drawn after the code (FIGMA_PARITY page 21).
