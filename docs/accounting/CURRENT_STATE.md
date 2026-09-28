# Current-state assessment (discovery, 2026-09-27)

## Repositories
- **[`ibrahim1440/flow.com`](https://github.com/ibrahim1440/flow.com)** — the live BeanFlow source. `main` = `fc64c05` ("Merge pull request #2 …
  release/finance-sales-20260927"), confirmed as the branch head through the GitHub API before this
  branch was cut. 29 Prisma migrations; Next.js 16.2.4, React 19, Prisma 7.8, PostgreSQL.
- `ibrahim1440/hiqbah_share2` — a sanitized public export; its `erp/` lags `flow.com` by 9 migrations
  and contains **none** of the accounting branch (it is not a place to look for or link to this work)
  (no Sales collections, commissions or Finance). Not used as the base (owner decision, 2026-09-27).

## Environments (identified, never written except where stated)
| Item | Finding | How verified |
|---|---|---|
| Production database | Neon project `hiqbah` (`dark-lab-61530722`), branch **`hiqbah-demo-training-20260529`** (`br-weathered-bread-aqais7hp`), endpoint **`ep-dawn-dust-aqn1u1uf`**. The branch *named* `production` is not the live one. | Neon compute listing; matches `scripts/finance/check-env.mjs` ("LIVE PRODUCTION — serves www.beanflow.net") and `docs/finance/RELEASE-20260927.md` |
| Runtime role | `erp_app`: DML only, default privileges on future `neondb_owner` tables | release notes + `has_table_privilege` on the rehearsal copy |
| Migration rehearsal | branch `rehearsal-accounting-ledger-core-20260927` (`br-billowing-fire-aq5eyiku`, endpoint `ep-noisy-night-aq3qczk4`) — a copy of production at 15:02 UTC | created for this work; see `MIGRATION_AND_CUTOVER.md` |
| Preview database | project `hiqbah-erp-test` (`dry-smoke-16360248`), branch `preview-accounting-ledger-core` (`br-withered-art-aw2zp5kr`), endpoint `ep-plain-field-awqkif28`, database **`accounting_preview`** (empty, marked disposable) | created for this work; synthetic data only |
| Vercel | project `flow-com` (`prj_bBAuuOg4…`) in team scope `ibrahimmutambak-4927s-projects` | **403** for this session's Vercel connection — env vars and deployments could not be read |
| Local tests | PostgreSQL 16 on 127.0.0.1:54329, databases `erp_finance_dev`, `erp_finance_integration`, `erp_e2e`, `erp_test`, each marked disposable | same contract as `scripts/finance/local-db-guard.mjs` |

## What existed before this branch
| Area | State at `fc64c05` |
|---|---|
| Accounting S0 | Models, a manual-journal API with balance and period checks, **no UI, no tests, no four-eyes, immutability only in application code**; `emitAccountingEvent` called by nothing |
| Finance (cash & budget) | Implemented and tested (cash basis, bank import, allocation, budgets, four-eyes triggers) |
| Sales collections & commissions | Implemented and tested; commission rules marked **PROVISIONAL** |
| Purchasing | One flat `PurchaseRecord` (Float money); no PO / receipt / supplier bill / AP |
| Inventory | Quantity-only ledger (Float); **no unit costs, no valuation** |
| Sales invoices / AR | **None**; `Order.vatInvoiceStatus` is free text; Customer/Supplier have no VAT number |
| ZATCA | Only a `zatcaTaxCategoryCode` column |
| Multi-tenancy | None (singleton settings); not claimed |

Baseline tests at `fc64c05` (local): typecheck clean; finance unit 52/52; finance DB 40/40; backend
regression 26 suites with 11 failures in 3 suites — all 11 reproduce identically at `fc64c05`
(see `DEFECTS_AND_LIMITATIONS.md`).
