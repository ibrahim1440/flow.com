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

**Not yet mapped (no source documents exist yet):** sales invoices, receipts, customer advances,
credit notes, purchase orders/receipts/bills/payments, inventory movements and valuation,
production and costing, bank transactions from Finance, fixed assets, payroll, year-end closing.
