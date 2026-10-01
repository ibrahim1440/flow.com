# Accountant acceptance — scenarios and decisions required

**Status: prepared, NOT performed.** No accountant has run these scenarios or taken the decisions
below. The figures under "Expected result" are what the system produces on synthetic data. Each
one is already checked by an automated test, named in the last column. The accountant's job is to
confirm that each expected result is *right accounting*, not that the software matches itself.

**Where to run:** an isolated preview with synthetic data (not available yet — `RELEASE_PROPOSAL.md`).
Until then, use a local environment. The ledger, approvals and reports checklist in Arabic is
`UAT_AR.md`.

## 1. Scenarios

| # | Scenario | Steps (synthetic data) | Expected result | Automated check |
|---|---|---|---|---|
| A1 | Year-end close | Use the isolated prior-year scenario: revenue 345,000 (one branch 45,000), returns 5,000, cost of sales 150,000, salaries 84,000, rent 26,000. Prepare the close as one person; approve as another | One CLOSING entry dated 31 Dec in the locked December period. Dr 4100 300,000 and Dr 4100 [branch] 45,000; Cr 4900 5,000, Cr 5100 150,000, Cr 6100 84,000, Cr 6200 26,000, Cr 3200 80,000. Next year opens with every revenue and expense account at zero and retained earnings 80,000 Cr | `year-end-forms.mjs`, `year-end.test.ts` |
| A2 | Line discount on an e-invoice | Invoice 3 × 33.3333 SAR at 10% discount, 15% VAT | Line net 90.00; allowance 10.00 on a base of 100.00; VAT 13.50; total 103.50 | `einvoice-qr-independent.test.ts` |
| A3 | Standard invoice without a supply date | Post a B2B invoice with the supply date left empty | The e-invoice is generated, with a *warning* asking for the supply date | `einvoice.test.ts` |
| A4 | Credit note and debit note | Credit note with a reason against a posted invoice; debit note against the same invoice | Types 381 and 383, each referencing the original and showing its reason; VAT return shows the credit note as negative | `einvoice.test.ts`, `tax-forms.mjs` |
| A5 | Straight-line depreciation | Asset 12,000, 12 months, no residual value | 1,000 a month; the last month brings the total to exactly 12,000 | `year-end.test.ts`, `fa-depreciation.test.ts` |
| A6 | Disposal at a loss | Sell an asset below its net book value | Cost and accumulated depreciation removed; proceeds to the chosen account (bank accounts are refused); the loss is posted to 6960 | `fixed-assets.test.ts`, `fa-forms.mjs` |
| A7 | Late stock document | Stock event dated in a month that is now locked, when the first open day already has a movement | Booked on the first open day, keeping its original date and a reason | `ops-integration.test.ts` (defect 39) |
| A8 | Inventory count surplus | Count shows more than the books | Surplus enters at the current average cost, e.g. (3,000 − 600) / 80 = 30.00 per unit | `ops-integration.test.ts` |
| A9 | Four-eyes and immutability | Try to approve your own document; try to edit a posted entry | Both are refused, by the screen and by the database | `authz.test.mjs`, ledger DB tests |
| A10 | Backup and restore | Restore a backup into a new database | Same row counts, ledger totals and triggers; posted entries are still protected | `local-backup-restore-check.sh` |

## 2. Decisions only the accountant or owner can take

All of these are held behind approval in the software: refused or waiting until decided.

| Decision | Where in the system | Reference |
|---|---|---|
| Inventory costing method (D-1) | inventory settings | `DECISION_PACK.md` |
| VAT on customer advances (D-2) | receivables settings | `DECISION_PACK.md` |
| Revenue and cost-of-sales timing | settings `salesCostTiming` | `DECISION_PACK.md` |
| Normal-loss bands, labour and overhead rates | inventory setup | `DECISION_PACK.md` §4b |
| Depreciation classes, lives, residual values, conventions | fixed-asset classes (approved versions) | `STAGE_5_DESIGN.md` |
| Year-end closing policy `closing.year_end` | policies | `POLICIES.md` |
| Cash-flow classes per account | chart of accounts | `DECISION_PACK.md` §7 |
| Ledger cutover date and opening balances | settings | `MIGRATION_AND_CUTOVER.md` |
| Which customers get standard (B2B) versus simplified invoices; tax-exemption codes and texts per tax category; company seller data | tax categories and e-invoice profile | `ZATCA_REQUIREMENTS.md` |
| Retention period for e-invoices and attempts | — | `ZATCA_REQUIREMENTS.md` 1.9 |

## 3. Recording acceptance

For each scenario, the accountant records accepted / not accepted, with comments, in this file or a
signed copy. Stages 2 and 3 were explicitly **not accepted** by the owner, and that still stands
until they say otherwise.
