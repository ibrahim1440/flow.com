# Event → journal map

| Source (table / action) | Event type | Policy | Journal (AUTO, posted by the engine) | Party on control line |
|---|---|---|---|---|
| `CommissionLedgerEntry` ACCRUAL (> 0) | `commission.accrual` | `commissions.recognition` + plan version approved | Dr COMMISSION_EXPENSE / Cr COMMISSION_PAYABLE | EMPLOYEE |
| `CommissionLedgerEntry` REVERSAL (< 0) | `commission.reversal` | same | Dr COMMISSION_PAYABLE / Cr COMMISSION_EXPENSE | EMPLOYEE |
| `CommissionLedgerEntry` ADJUSTMENT (±) | `commission.adjustment` | policy only | by sign, as the two rows above | EMPLOYEE |
| `CommissionLedgerEntry` PAYOUT (> 0) | `commission.payout` | policy only | Dr COMMISSION_PAYABLE / Cr COMMISSION_PAYMENT_CLEARING | EMPLOYEE |
| Manual journal | — | — (four-eyes) | as entered; control accounts refused | — |

Guarantees (tested in `tests/accounting/integration/commissions.test.ts`): one event per movement in
the same transaction; one journal per event (unique `originEventId`); replays and three concurrent
processors post each event once; per-employee ordering; before-cutover events SKIPPED; unmapped
role / locked period / unapproved policy or plan → BLOCKED with the reason, retried later;
commissions payable reconciles to the commission ledger per employee, including a return after
payout (negative balance = employee owes).

## Stage 2 and 3 events (2026-09-28)

| Source | Event | Gate | Journal | Party |
|---|---|---|---|---|
| `SupplierBill` POSTED | `ap.bill.posted` | `payables.recognition` | Dr each line's account (net) · Dr INPUT_VAT / Cr AP_CONTROL (gross) | SUPPLIER |
| `SupplierBill` REVERSED | `ap.bill.reversed` | — | mirror of the posted journal, dated on the reversal | SUPPLIER |
| `BankTransaction` confirmed and reviewed | `bank.transaction.confirmed` | `bank.posting` (+ start date) | Dr/Cr the cash account's GL account against the budget splits' accounts; payables splits only to the extent matched to posted bills; transfers post once from the paying leg | SUPPLIER on AP lines |
| same, classified customer receipt/refund | `bank.transaction.confirmed` | `bank.posting`; advances also `receivables.advances` + D-2 | Dr bank / Cr AR_CONTROL (allocated) · Cr CUSTOMER_ADVANCES (net) · Cr OUTPUT_VAT (advance VAT per D-2); waits until assigned to a customer | CUSTOMER |
| `BankTransaction` VOID (unposted, or through an approved correction) | `bank.transaction.voided` | — | mirror of the posted journal, dated on the void | as original |
| `SalesInvoice` INVOICE POSTED | `ar.invoice.posted` | `receivables.recognition` | Dr AR_CONTROL (gross) / Cr revenue per line (net) · Cr OUTPUT_VAT | CUSTOMER |
| `SalesInvoice` CREDIT_NOTE POSTED | `ar.credit_note.posted` | `receivables.recognition` | Dr SALES_RETURNS (net) · Dr OUTPUT_VAT / Cr AR_CONTROL (gross) | CUSTOMER |
| `AdvanceApplication` POSTED | `ar.advance.applied` | `receivables.advances` + D-2 | Dr CUSTOMER_ADVANCES (net part) · Dr OUTPUT_VAT (VAT carried) / Cr AR_CONTROL | CUSTOMER |
| any of the three above, REVERSED | `ar.*.reversed` | — | mirror, dated on the reversal | CUSTOMER |

| `ArAllocation` credit note → invoice (reallocation) | `ar.credit.allocated` | `receivables.recognition` | Dr AR_CONTROL (open item = credit note) / Cr AR_CONTROL (open item = invoice) — net zero | CUSTOMER |
| same, released | `ar.credit.released` | — | mirror, dated on the release | CUSTOMER |

Every AR_CONTROL and AP_CONTROL line carries the open item it opens or settles (`openItemType`,
`openItemId`; set at posting, immutable, copied by mirrors). Receipts post one AR line per allocated
invoice, AP payments one AP line per bill, and a credit note splits into the invoice it settles and
its own remainder. Aging, statements and cash-flow attribution read these posted lines by entry
date (`open-items.ts`), never a document's current status.

Idempotency keys: `payables:<id>:<event>`, `bank:<id>:confirmed|voided`, `receivables:<id>:<event>`, `inventory:<id>:inv.document.posted`.

## Stage 4 events (2026-09-28)

| Source | Event | Gate | Journal |
|---|---|---|---|
| `InvDocument` POSTED (any type) | `inv.document.posted` | `inventory.costing` + D-1 settings + approved loss band | built only from the document's sealed cost moves; see `STAGE_4_DESIGN.md` §3 (receipt Dr inventory / Cr GRNI; production Dr output · Dr 5300 / Cr inputs; issue Dr 5100/5400/5500/5600/5700 / Cr inventory; bill match and landed cost to inventory for stock on hand, to COGS for stock consumed / GRNI; count to 5700; transfer: no journal, event SKIPPED) |
| `SalesInvoice` INVOICE POSTED with stocked SKUs | (system `SALE_ISSUE` document) → `inv.document.posted` | as above | Dr 5100 / Cr finished goods, once per invoice |
| `SalesInvoice` REVERSED after its cost of sales | (system `CUSTOMER_RETURN` document) → `inv.document.posted` | as above | Dr finished goods / Cr 5100 at the cost the goods left at, for the quantity not already returned |
Sales collections and commissions keep their own paths: a sales collection never posts; the bank
line does, once (`receivables.test.ts`, `receivables-workflow.test.mjs`).

**Not yet mapped:** purchase orders as documents (goods receipts exist, stage 4), labour and
overhead absorption, fixed assets and depreciation runs, payroll, year-end closing, POS/gateway
settlements (manual journals), supplier credit notes.
