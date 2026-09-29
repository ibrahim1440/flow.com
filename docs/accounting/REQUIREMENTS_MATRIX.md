# Requirements coverage matrix (against the brief)

Repository [https://github.com/ibrahim1440/flow.com](https://github.com/ibrahim1440/flow.com), branch
`feature/accounting-ledger-core` (**unpushed**). The commit the named tests ran on, and their counts,
are in [`TEST_RESULTS.md`](TEST_RESULTS.md). Stage 4b detail is in
[`STAGE_4B_EVIDENCE.md`](STAGE_4B_EVIDENCE.md).

## Four levels, kept apart

| Level | Meaning | State for everything below |
|---|---|---|
| 1. Local verification | a named test or browser run exercised it and passed, on synthetic data, on the local PostgreSQL 16 server, run by the implementer | as marked per row |
| 2. Independent review | someone other than the implementer reviewed the code and evidence | **not done** for any row; the owner's review of stages 2–3 is open and those stages are **not accepted** |
| 3. Accountant acceptance | the accountant ran acceptance (e.g. `UAT_AR.md`) and took the decisions in `DECISION_PACK.md` | **not done** for any row; every policy used in tests is a labelled synthetic assumption |
| 4. Production readiness | migrations rehearsed on a production copy, Preview deployed and smoke-tested, credentials remediated, release approved | **not ready**: see "Migration rehearsal" below and `RELEASE_PROPOSAL.md` |

Row status (level 1 only): **V** implemented and verified locally (named test) · **I** implemented,
not verified by a test · **P** partial · **M** missing · **D** the mechanism exists and the
accounting choice awaits a decision (approval-gated: refused or held until decided) · **C** blocked
only by cloud access.

## Matrix

| Area (brief §) | Requirement | Status | Evidence / note |
|---|---|---|---|
| 8.7 General accounting | Balanced double-entry, DB-enforced | V | `ledger.test.ts` (unbalanced forced post refused by the DB) |
| 8.7 | Manual / opening / adjustment / reversal entries | V | journal workflow tests; OPENING type used by the fixture |
| 8.7 | Automatic entries | V | commissions (`commissions.test.ts`); bank lines and bills (`stage2.test.ts`); invoices, receipts, credit notes (`receivables.test.ts`); inventory documents and operational events (`inventory.test.ts`, `ops-integration.test.ts`) |
| 8.7 | Closing entries (year-end), retained earnings, opening balances | V / D (statement) | `year-end.test.ts`: blockers, prepare → approval by someone else after recomputation, CLOSING entry into the locked period 12, statements before and after, next-year opening balances (P&L zero), retry and concurrent approvals, reopen and re-close, period 12 not closable while a close is pending; journals BLOCKED until `closing.year_end` is approved. Browser: blockers shown (`fa-forms.mjs`); the fixture has no prior year to close |
| 8.7 | Approval workflow, separation of duties | V | service + DB triggers; HTTP authorisation tests (`authz.test.mjs`) |
| 8.7 | Open / locked / closed periods; reopen control | V | period tests; CLOSED is final |
| 8.7 | Protection of posted history | V | DB guard tests (edit/delete/lines) and a mutation check |
| 8.7 | Reversals with approval | V | reversal test |
| 8.7 | Control accounts closed to manual posting | V | refusal tests |
| 8.7 | Prepayments, accruals, advances, custody | P | customer advances with D-2 (stage 3); the others are template accounts posted by manual journal |
| 8.7 | Fixed assets and depreciation | V / D (policies, classes) | register, capitalisation from bill lines / counter accounts / opening balances, approval-gated class policy versions, monthly runs (straight line cumulative target, declining balance, catch-up), disposal with gain/loss, reversals, register ↔ ledger reconciliation: `fa-depreciation.test.ts`, `fixed-assets.test.ts` (7: retry, concurrency, locked and later periods), `fixed-assets.test.mjs` (HTTP), `fa-forms.mjs` (browser). Lives, rates and conventions are synthetic until approved |
| 8.7 | Payroll liabilities | P | accounts only; no payroll processing (not claimed) |
| 8.7 | Attachments | M | audit trail yes (`FinAuditLog`); file attachments on bills/invoices no. Customer returns record warehouse evidence as text |
| 8.1 Master data | Hierarchical chart of accounts | V | account service (cycle/type checks) and template tests |
| 8.1 | Branches / cost centres on lines | V | reuses Finance masters |
| 8.1 | Customer/supplier tax data, terms, credit limits | V (credit limit warns only) | supplier (stage 2); customer VAT number with KSA format check, CR number, payment terms, credit limit (stage 3, `updateCustomerTaxData`) |
| 8.1 | Product categories, UoM conversions, price lists | P | inventory items with kinds and unit conversions to a base unit (`InvItem`/`InvUnit`; a 12-litre carton in `stage4b-workflows.test.ts` A); an unlinked item can be linked to its operational record in setup (`ops-integration.test.ts` test 4, browser `ops-pack-dispatch.mjs`); **price lists missing** |
| 8.2 Purchasing/AP | Supplier bills, approval, posting, payments, statements, aging | V | `stage2.test.ts`, `stage2-workflow.test.mjs`: four-eyes, immutability after posting, duplicate supplier invoice refused, VAT per line, reversal refused once paid; aging and statements from the posted ledger (`subledger-history.test.ts`) |
| 8.2 | Goods receipt, GRNI clearing, landed cost, price differences | V (mechanism) / D (D-1 price-difference treatment) | goods receipt documents, bill match, landed cost by value or quantity, GRNI explained line by line = 2120 (`inventory.test.ts`); later price differences and landed costs follow the goods into roasted coffee, finished goods, sold goods and loss (chain test, `stage4-gaps.test.ts`) |
| 8.2 | Supplier credit notes and supplier returns | V | price-reduction and return-settlement credit notes applied to bills (`stage4b-workflows.test.ts` D; over HTTP in `ops-integration.test.mjs`) |
| 8.2 | Purchase orders | M | the operational system records purchases directly; no PO document |
| 8.3 Inventory | Valuation, cost layers, GL reconciliation | V / D (D-1 method) | Decimal cost subledger (moves + FIFO / weighted-average layers) beside the operational Float records; valuation as of any date tied to 1171–1176; no negative stock, no back-dating, one posting under concurrency, DB-enforced immutability (`inventory.test.ts`, `inventory-costing.test.ts` incl. a 3,000-sequence conservation check, `inventory-workflow.test.mjs`). The costing method is a setting refused until chosen; tests use a labelled synthetic choice |
| 8.3 | Operational stock changes reach the accounts without re-entry | V | purchases, roasting, roast cancellation, QC rejection, blending, packing (standard, partial, top-up, declared loss), dispatch, counts and material adjustments record an event in the same transaction and become one inventory document each; unknown writers are detected by a DB trigger (`ops-integration.test.ts`, `ops-integration.test.mjs`). **Browser:** purchase and roast-to-stock forms (`ops-forms.mjs`); packing and dispatch forms with refusals, a held pack approved and posted by the accountant, and a blocked pack recovered by linking the item and retrying from the queue (`ops-pack-dispatch.mjs`) |
| 8.3 | Operational locations | P | one accounting location for operational stock (the operational system has no locations); dispatch moves stock to "delivered, not invoiced" (1176) |
| 8.4 Manufacturing | Production costing, loss policy, lineage | V (mechanism) / D (bands) | production documents consume inputs and cost outputs by yield weight; normal loss within an **approved** band absorbed, abnormal loss to 5300 (held for approval above the band); packaging charged to outputs from the SKU's operational BOM (`BomComponent`) |
| 8.4 | Labour and overhead absorption | V (mechanism) / D (rates) | cost pools with approved bases and normal capacity; absorption credited to contra accounts 6190/6790, under-absorption stays in expense (`stage4b-workflows.test.ts` C). Rates in tests are synthetic (`-SYN` codes, DECISION_PACK §4b) |
| 8.4 | Standard cost, BOM master in accounting | M | costing is actual; the BOM is the operational SKU BOM |
| 8.5 Sales/AR | Invoices, receipts, credit notes, advances, aging, statements | V / D (D-2) | `receivables.test.ts`, `receivables-workflow.test.mjs`, `STAGE_3_DESIGN.md`; four-eyes and immutability; receipts from bank lines once; advances VAT is the approval-gated D-2 setting (undecided by default); aging and statements from the posted ledger by entry date |
| 8.5 | Cost of sales | V (mechanism) / D (timing) | durable costing record per invoice line with retries and an exception queue; unmapped goods lines block costing with a reason; fulfilment location and unit conversion honoured (`stage4-gaps.test.ts`, `stage4b-workflows.test.ts`). Revenue/COGS **timing** (`salesCostTiming`) is undecided by default and costing waits (AWAITING_POLICY) |
| 8.5 | Invoice reversal vs physical return | V | reversing an invoice **does not restore stock**: the cost moves to "delivered, not invoiced" (1176). Goods come back only through a received and approved customer return with evidence (approver ≠ recorder/receiver); partial returns; no duplicated restoration (`stage4b-workflows.test.ts` A) |
| 8.5 | Saudi e-invoicing (ZATCA) | V (local only) / C (SDK, sandbox) | generation, chain, local rules, debit notes, submission gating and retries: `einvoice-pure.test.ts`, `einvoice.test.ts`, `tax.test.mjs`, `tax-forms.mjs`. **Nothing sent to ZATCA; not validated by the SDK; not compliant** (`STAGE_6_DESIGN.md`) |
| 8.6 Commissions | Accrual/payout/reversal/adjust → GL, exactly once, reconciled | V | commission tests and reconciliation report |
| 8.6 | Plan approval gate for production posting | V | four-eyes trigger and gate tests |
| 8.8 Cash/bank | Bank transactions → GL; reconciliation to GL; corrections | V | `stage2.test.ts`; posted lines frozen (service + DB triggers); four-eyes void/replace correction (`bank-corrections.test.ts`, `bank-corrections.test.mjs`) |
| 8.8 | Budgets vs actual (accrual basis) | M | Finance budgets are cash-basis (pre-existing) |
| 8.9 Reports | Trial balance, GL, journal, income statement, balance sheet | V | statements test, HTTP report test |
| 8.9 | Commission accruals/payments reconciliation | V | |
| 8.9 | Cash-flow statement | V / D (classes) | transaction-aware (`cashflow-transactions.test.ts`, `cashflow-history.test.ts`, `cashflow.test.ts`, `cashflow-engine.test.ts`, `cashflow-rules.test.ts`); classes await the accountant (DECISION_PACK §7) |
| 8.9 | Aging, statements, inventory, profitability reports | V | AP/AR aging and statements reproducible for any past date and tied to the GL (`subledger-history.test.ts`); inventory valuation, stock card, GRNI; gross margin including credit notes, reconciled to revenue, 4900 and 5100 with differences explained and incomplete rows flagged (`stage4-gaps.test.ts`) |
| 8.9 | Tax (VAT return) report | V (local) / D (box mapping) | `einvoice.test.ts` VAT case (credit notes, reversals, reconciliation with unexplained remainder), `tax-forms.mjs`; exports, imports, reverse charge, corrections and carried-forward credit not modelled |
| 9 Saudi localisation | E-invoicing, VAT returns, zakat | P | e-invoicing local only and VAT return (above); zakat missing. `ZATCA_REQUIREMENTS.md`; nothing here is ZATCA-compliant |
| 10 Engineering | Decimal money, idempotency, concurrency, audit | V | unit and DB tests |
| 7 Figma | Designs for ledger, AP, banking, cash flow, AR, inventory, operations, assets, tax | V | `FIGMA_PARITY.md` pages 17–23. Pages 17–20 and 22–23 were designed before the code; **page 21 (ACC-48..52, ACC-31b, ACC-32b, OPS-01) was drawn after the code** |
| 7.2 | Figma for assets, ZATCA | V | pages 22 (ACC-60..65) and 23 (ACC-70..72), **designed before the code**, compared with the built screens (`FIGMA_PARITY.md`) |
| 13 Regression | Existing workflows remain functional | V (local) | backend certification (26 suites, 0 failed, clean worktree); Sales pure, DB and running-app suites (`sales-security`, `sales-workflow`) locally against a disposable `sales_preview` with a DML-only role (`TEST_RESULTS.md`) |
| 14 Migration | Rehearsed on a production copy | **P** | only `20260928090000_accounting_ledger_core` of twelve; see below |
| 9.1 | Official ZATCA documents read | C | zatca.gov.sa is blocked by this environment's egress policy; titles, versions and URLs confirmed by search only (`STAGE_6_DESIGN.md` §1) |
| 15 Preview | Vercel Preview on an isolated DB | C | GitHub push 403 (App not installed on flow.com); Vercel 403 (team scope); this sandbox cannot reach Neon over TCP |

## Migration rehearsal: exactly what ran where

| Migration | Local disposable PostgreSQL 16 | Production copy (Neon, PostgreSQL 17) |
|---|---|---|
| `20260928090000_accounting_ledger_core` | applied, tested | **rehearsed** 2026-09-27 on branch `rehearsal-accounting-ledger-core-20260927`, through the Neon connector in one transaction (not `prisma migrate deploy`); `MIGRATION_AND_CUTOVER.md`. The new build was **not** run against that copy |
| `20260928120000_accounting_payables_bank` | applied, tested | not rehearsed |
| `20260928130000_accounting_cash_flow_class` | applied, tested | not rehearsed |
| `20260929090000_accounting_bank_corrections` | applied, tested | not rehearsed |
| `20260929120000_accounting_receivables` | applied, tested | not rehearsed |
| `20260930090000_accounting_open_items` | applied, tested | not rehearsed |
| `20260930120000_accounting_inventory` | applied, tested | not rehearsed |
| `20260930130000_accounting_inventory_sales_location` | applied, tested | not rehearsed |
| `20261001090000_accounting_stage4b` (adds a trigger on the operational `InventoryMovement` table) | applied, tested | not rehearsed |
| `20261002090000_accounting_fixed_assets_year_end` (replaces the journal-entry guard function) | applied, tested | not rehearsed |
| `20261003090000_accounting_einvoicing_local` (nullable columns on `SalesInvoice`, `Customer`) | applied, tested | not rehearsed |
| `20261003091000_accounting_tax_exemption_codes` (nullable columns on `TaxCategory`) | applied, tested | not rehearsed |

The five finance migrations before the ledger core are on `main` and in production already (the
rehearsal found 29 applied, the latest `20260927100000_protect_movement_provenance`); they are not
part of this branch.

## Cross-cutting evidence

| Requirement | Status | Evidence |
|---|---|---|
| Runtime DB role (not owner) runs the app | V | HTTP and browser suites run against `next start` as `accounting_app` (DML only) |
| Preview isolation guard before migrate/reset/seed | V (local) / C (Neon) | server-reported project, branch and endpoint ids plus the marker (`preview-target.mjs`, unit tests); not run on Neon |
| Accessibility (WCAG 2.1 AA, automated) | V for the accounting views (automated rules only) | `a11y.mjs`: 0 serious/critical; no manual screen-reader test; the operational screens are not in the audit |
| Credential incident | D (owner action) | `CREDENTIAL_INCIDENT.md`: procedure awaiting approval; no rotation performed or claimed |
| Accountant decisions | D | `DECISION_PACK.md` |

## Delivery stages

1. Ledger core + commissions: implemented and verified locally; not accepted.
2. Bank-to-ledger + payables + cash-flow statement: implemented and verified locally; **not accepted**.
3. Sales invoices / receivables / advances (D-2): implemented and verified locally; **not accepted**.
4. Inventory valuation, manufacturing costing, operational integration (stages 4 and 4b; D-1,
   bands, rates and cost timing approval-gated): implemented and verified locally; not accepted.
5. Fixed assets, depreciation, year-end close: implemented and verified locally; not accepted.
6. E-invoicing (local validation only) and VAT return: implemented and verified locally; **not sent
   to ZATCA, not validated by its SDK, not compliant**; not accepted.

No stage has had independent review, accountant acceptance or a Preview deployment, and only the
ledger-core migration has been rehearsed on a production copy. Stages 5–6 detail:
`STAGE_5_6_EVIDENCE.md`.
