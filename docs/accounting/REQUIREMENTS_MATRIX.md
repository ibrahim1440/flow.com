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
| 8.2 Purchasing/AP | PO, receipts, bills, payments, landed cost, GRNI, statements | M | template has 2110/2120 |
| 8.3 Inventory | Valuation, cost layers, GL reconciliation | M | quantity ledger only (pre-existing, Float) |
| 8.4 Manufacturing | BOM costing, loss policy, lineage | M / R | needs D-1 decision |
| 8.5 Sales/AR | Invoices, receipts, returns, advances, aging | M | D-2 recorded |
| 8.6 Commissions | Accrual/payout/reversal/adjust → GL, exactly once, reconciled | V | commission tests + reconciliation report |
| 8.6 | Plan approval gate for production posting | V | four-eyes trigger + gate tests |
| 8.8 Cash/bank | Bank transactions → GL; reconciliation to GL | M | Finance module is cash-basis and separate; clearing account designed for it |
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
