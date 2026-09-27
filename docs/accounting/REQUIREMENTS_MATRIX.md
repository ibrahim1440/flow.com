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
| 8.1 | Customer/supplier tax data, terms, credit limits | M | |
| 8.1 | Product categories, UoM conversions, price lists | M | |
| 8.2 Purchasing/AP | PO, receipts, bills, payments, landed cost, GRNI, statements | P (design) | Stage 2 design `STAGE_2_DESIGN.md`; Figma page 18 ACC-20..23 done (bills list, editor, detail, aging and statement); code not started. Landed cost and GRNI clearing need stage 4 (D-1) |
| 8.3 Inventory | Valuation, cost layers, GL reconciliation | M | quantity ledger only (pre-existing, Float) |
| 8.4 Manufacturing | BOM costing, loss policy, lineage | M / R | needs D-1 decision |
| 8.5 Sales/AR | Invoices, receipts, returns, advances, aging | M | D-2 recorded |
| 8.6 Commissions | Accrual/payout/reversal/adjust → GL, exactly once, reconciled | V | commission tests + reconciliation report |
| 8.6 | Plan approval gate for production posting | V | four-eyes trigger + gate tests |
| 8.8 Cash/bank | Bank transactions → GL; reconciliation to GL | P (design) | Stage 2 design §2: outbox on confirmed and reviewed bank transactions; counter side from match, split or classification; transfers posted once; customer receipts BLOCKED until stage 3 (D-2). Figma ACC-24/25 pending |
| 8.8 | Budgets vs actual (accrual basis) | M | Finance budgets are cash-basis (pre-existing) |
| 8.9 Reports | Trial balance, GL, journal, income statement, balance sheet | V | statements test, HTTP report test |
| 8.9 | Commission accruals/payments reconciliation | V | |
| 8.9 | Cash-flow statement | M | stated in UI (ACC-08) |
| 8.9 | Aging, statements, tax, inventory, profitability reports | M | |
| 9 Saudi localisation | E-invoicing, VAT returns, zakat | M | `ZATCA_REQUIREMENTS.md` |
| 10 Engineering | Decimal money, idempotency, concurrency, audit | V | unit + DB tests |
| 7 Figma | Designs for ledger workflows, implemented, compared | V (ledger screens) | `FIGMA_PARITY.md` |
| 7.2 | Figma for AP, AR, inventory, manufacturing, banking, assets, ZATCA | M | follow the modules |
| 13 Regression | Existing workflows remain functional | V | 26 regression suites; 11 failures all pre-existing at `fc64c05` |
| 14 Migration | Rehearsed on a production copy | V | `MIGRATION_AND_CUTOVER.md` |
| 15 Preview | Vercel Preview on isolated DB | **B** | GitHub push 403 (App not installed); Vercel 403 (team scope); sandbox cannot reach Neon (network policy) |

## Cross-cutting evidence added 2026-09-27 (second pass)

| Requirement | Status | Evidence |
|---|---|---|
| Runtime DB role (not owner) runs the app | V | `tests/accounting/http/runtime-workflow.test.mjs` 7/7 and `runtime-no-switch` 1/1 as `accounting_app` (DML only) |
| Preview isolation guard before migrate/reset/seed | V (local) / B (Neon) | server-reported project, branch and endpoint ids plus the marker (`preview-target.mjs`, unit tests). Not yet run on Neon: no TCP 5432 |
| Accessibility (WCAG 2.1 AA, automated) | V for ACC-01..11 | `a11y.mjs`: 0 serious/critical in accounting content; shell sidebar finding reported |
| Regression, side by side with main | V | `REGRESSION_SIDE_BY_SIDE.md`: 11 identical failures, each explained and passing once its condition is corrected |
| Credential incident | R (owner action) | `CREDENTIAL_INCIDENT.md`: procedure awaiting approval |
| Accountant decisions | R | `DECISION_PACK.md` |

## Delivery stages

1. Ledger core + commissions: **done** (this branch).
2. Bank-to-ledger + payables: **in progress**. Design done; Figma ACC-20..23 done.
3. Sales invoices / receivables / advances (D-2) and cash-flow statement.
4. Inventory valuation + generic manufacturing costing (D-1).
5. Fixed assets and depreciation; year-end close.
6. Saudi localisation: ZATCA adapter (sandbox only), VAT return report.
