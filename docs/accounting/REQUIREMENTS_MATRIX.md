# Requirements coverage matrix (against the brief)

Legend: **V** implemented & verified (tests named) · **P** partial · **M** missing · **B** blocked · **R** requires investigation/decision.

| Area (brief §) | Requirement | Status | Evidence / note |
|---|---|---|---|
| 8.7 General accounting | Balanced double-entry, DB-enforced | V | `ledger.test.ts` (unbalanced forced post refused by DB) |
| 8.7 | Manual / opening / adjustment / reversal entries | V | journal workflow tests; OPENING type used by fixture |
| 8.7 | Automatic entries | V (commissions only) | `commissions.test.ts` |
| 8.7 | Closing entries (year-end) | M | income statement treats unclosed P&L as current earnings |
| 8.7 | Approval workflow, separation of duties | V | service + trigger; HTTP authz tests |
| 8.7 | Open / locked / closed periods; reopen control | V | period tests; CLOSED is final |
| 8.7 | Protection of posted history | V | DB guard tests (edit/delete/lines) + mutation check |
| 8.7 | Reversals with approval | V | reversal test |
| 8.7 | Control accounts closed to manual posting | V | refusal tests |
| 8.7 | Prepayments, accruals, advances, custody | P | accounts in template; manual journals only |
| 8.7 | Fixed assets & depreciation | M | |
| 8.7 | Payroll liabilities | P | accounts only; no payroll processing (not claimed) |
| 8.7 | Attachments | M | audit trail yes (FinAuditLog); attachments no |
| 8.1 Master data | Hierarchical chart of accounts | V | account service (cycle/type checks) + template tests |
| 8.1 | Branches / cost centres on lines | V | reuse Finance masters |
| 8.1 | Customer/supplier tax data, terms, credit limits | P | Supplier VAT number (KSA format check), CR number, address, payment terms (`updateSupplierTaxData`, stage 2). Customer side waits for stage 3 |
| 8.1 | Product categories, UoM conversions, price lists | M | |
| 8.2 Purchasing/AP | Supplier bills, approval, posting, payments, statements, aging | V (bills, payments, aging, statements) / M (landed cost, GRNI clearing, PO/receipt documents) | `stage2.test.ts` (13), `stage2-workflow.test.mjs` (4, runtime role). Bill lifecycle with four-eyes, immutability after posting, duplicate supplier invoice refused, VAT per line, obligation created on posting, reversal refused once paid, aging tied to 2110. A stock line goes to GRNI 2120, which is **provisional** pending D-1; landed cost and GRNI clearing need stage 4 |
| 8.3 Inventory | Valuation, cost layers, GL reconciliation | M | quantity ledger only (pre-existing, Float) |
| 8.4 Manufacturing | BOM costing, loss policy, lineage | M / R | needs D-1 decision |
| 8.5 Sales/AR | Invoices, receipts, returns, advances, aging | M | D-2 recorded |
| 8.6 Commissions | Accrual/payout/reversal/adjust → GL, exactly once, reconciled | V | commission tests + reconciliation report |
| 8.6 | Plan approval gate for production posting | V | four-eyes trigger + gate tests |
| 8.8 Cash/bank | Bank transactions → GL; reconciliation to GL | V | `stage2.test.ts`: confirmed and reviewed lines post once; voids are mirrored; transfers post once; unmapped lines are BLOCKED with a reason; customer receipts wait for stage 3 (D-2); manual journals on mapped bank accounts are refused after the start date. The reconciliation report itemises every difference. Limitation: a bank line edited after posting is not re-posted (`DEFECTS_AND_LIMITATIONS.md`) |
| 8.8 | Budgets vs actual (accrual basis) | M | Finance budgets are cash-basis (pre-existing) |
| 8.9 Reports | Trial balance, GL, journal, income statement, balance sheet | V | statements test, HTTP report test |
| 8.9 | Commission accruals/payments reconciliation | V | |
| 8.9 | Cash-flow statement | V (classification provisional) | `cashflow.test.ts` (3, hand-worked) and `cashflow-rules.test.ts`. Indirect method; checks that operating + investing + financing equals the change in cash. The template classification awaits the accountant (decision pack §7) |
| 8.9 | Aging, statements, tax, inventory, profitability reports | P | AP aging and supplier statement (V); AR aging, tax, inventory and profitability reports missing |
| 9 Saudi localisation | E-invoicing, VAT returns, zakat | M | `ZATCA_REQUIREMENTS.md` |
| 10 Engineering | Decimal money, idempotency, concurrency, audit | V | unit + DB tests |
| 7 Figma | Designs for ledger workflows, implemented, compared | V (ledger screens) | `FIGMA_PARITY.md` |
| 7.2 | Figma for AP, AR, inventory, manufacturing, banking, assets, ZATCA | V (AP, banking, cash flow: page 18, ACC-20..27) / M (AR, inventory, manufacturing, assets, ZATCA) | `FIGMA_PARITY.md` |
| 13 Regression | Existing workflows remain functional | V | 26 regression suites; 11 failures all pre-existing at `fc64c05` |
| 14 Migration | Rehearsed on a production copy | V | `MIGRATION_AND_CUTOVER.md` |
| 15 Preview | Vercel Preview on isolated DB | **B** | GitHub push 403 (App not installed); Vercel 403 (team scope); sandbox cannot reach Neon (network policy) |

## Cross-cutting evidence added 2026-09-27 (second pass)

| Requirement | Status | Evidence |
|---|---|---|
| Runtime DB role (not owner) runs the app | V | `tests/accounting/http/runtime-workflow.test.mjs` 7/7 and `runtime-no-switch` 1/1 as `accounting_app` (DML only) |
| Preview isolation guard before migrate/reset/seed | V (local) / B (Neon) | server-reported project, branch and endpoint ids plus the marker (`preview-target.mjs`, unit tests). Not yet run on Neon: no TCP 5432 |
| Accessibility (WCAG 2.1 AA, automated) | V for ACC-01..27 (automated rules only) | `a11y.mjs`: 0 serious/critical over 23 views; the shell sidebar finding was fixed in separate commit `4015d3a` |
| Regression, side by side with main | V | `REGRESSION_SIDE_BY_SIDE.md`: 11 identical failures, each explained and passing once its condition is corrected |
| Credential incident | R (owner action) | `CREDENTIAL_INCIDENT.md`: procedure awaiting approval |
| Accountant decisions | R | `DECISION_PACK.md` |

## Delivery stages

1. Ledger core + commissions: **done** (this branch).
2. Bank-to-ledger + payables + cash-flow statement: **implemented and tested locally** (Figma ACC-20..27, code, DB, HTTP runtime-role, a11y). Not yet run on Neon or Vercel (access blocked). Production activation is gated by the decision pack.
3. Sales invoices / receivables / advances (D-2): not started.
4. Inventory valuation + generic manufacturing costing (D-1).
5. Fixed assets and depreciation; year-end close.
6. Saudi localisation: ZATCA adapter (sandbox only), VAT return report.
