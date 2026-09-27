# Test results

Code under test: branch `feature/accounting-ledger-core` @ **`56011a6`** (implementation SHA; later
commits are docs only). Baseline: `origin/main` @ **`fc64c05`**, confirmed as the latest remote main by
`git ls-remote` on 2026-09-27.
Environment: container Linux, Node 22.22.2, PostgreSQL 16 on a local disposable server at
127.0.0.1:54329 (production is PostgreSQL 17 on Neon), Chromium (Playwright). All data synthetic.

| Kind | Command | Result | What it proves / does not |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit` | clean | |
| Lint (changed areas) | `npx eslint src/lib/accounting src/app/api/accounting src/app/dashboard/accounting src/app/dashboard/finance/_components` | clean | |
| Production build | `npm run build` | exit 0 | |
| Unit | `npm run test:accounting:unit` | **11/11** | money and rounding, Riyadh dates, guard messages, template integrity, policy coverage, preview identity guard, URL classifier |
| DB integration (owner role) | `npm run test:accounting:db` (erp_finance_integration, clean environment) | **25/25** | real triggers: workflow, guards, reversal, periods, concurrency, statements, commission outbox, gate, provisional, replay, order, cutover |
| Mutation check | guard trigger disabled → rerun | 4 failures as expected; re-enabled → 25/25 | the guard tests detect a missing guard |
| **Runtime role — application** | `/tmp/.../serve-runtime.sh` (server's `DATABASE_URL` = `accounting_app`, DML only, grants from `scripts/accounting/runtime-grants.sql`), then `npm run test:accounting:runtime` | **7/7** | the server's sessions are `accounting_app` only; journal create → submit → four-eyes approve → post → GL; reversal (requester cannot approve; second approver posts; original REVERSED; cannot reverse twice); locked and closed periods refuse entries; unlock needs a reason and the permission; commission accrual → exactly one journal carrying the policy version; reprocessing adds nothing; subledger reconciled; provisional plan labelled; reports balanced; audit present |
| Runtime role — direct SQL | same suite | included above | as `accounting_app`, these are refused: UPDATE/DELETE of a posted line (trigger), TRUNCATE, DISABLE TRIGGER, `session_replication_role`, DDL |
| Runtime role — production switch off | server without `ACCOUNTING_PROVISIONAL_POSTING`, `tests/accounting/http/runtime-no-switch.test.mjs` | **1/1** | an unapproved plan version stays BLOCKED with no journal: the production configuration |
| HTTP authorisation (runtime role) | `node --test tests/accounting/http/authz.test.mjs` | **5/5** | 401 without a session; 403 without the module and on view-only writes; preparer cannot approve; double approval 409; malformed input 400 |
| Accessibility | `node tests/accounting/visual/a11y.mjs` (axe-core, WCAG 2.1 A/AA, 14 views, AR/EN, 1440/390) | first run 59 serious in content → **0 serious/critical in accounting content** | automated rules only. One shell-level contrast finding remains (sidebar role label, shared by all modules) |
| Finance regression | `npm run test:finance:unit` / `test:finance:db` | 52/52, 40/40 | Finance is unaffected, including by the shared kit colour changes |
| Backend regression, side by side | `node scripts/e2e/regression/run-all.mjs`, both trees, same DB name/port/secrets/Node | baseline 2,289 pass / 11 fail; feature 2,290 / 11 | identical 11 failures in 3 suites. Each suite passes on **both** trees once its condition is corrected. Classification and impact: `REGRESSION_SIDE_BY_SIDE.md` |
| Browser capture | `node tests/accounting/visual/capture.mjs docs/accounting/evidence/app` | 17 screens, no page errors, no horizontal overflow, `dir` rtl/ltr correct | rendering evidence |
| Visual vs Figma | side-by-side review | see `FIGMA_PARITY.md` | manual review; no pixel-diff tool |
| Migration rehearsal | production copy on Neon (`br-billowing-fire`) | applied; checksums match; see `MIGRATION_AND_CUTOVER.md` | schema and DB guards on the real data shape. **This is not application-runtime verification**, which ran locally (rows above) because the sandbox has no route to Neon's port 5432 |
| Runtime on the Neon preview database | — | **blocked** (network: no TCP 5432 / Neon HTTPS host not allow-listed) | to run once network permission exists: `preview-setup.sh` then the same runtime suites against the Preview URL |
| Sales suites | `run-sales.mjs commission-engine quotes-domain`; `sales-commissions-db.mjs` on a local disposable `sales_preview` (migrated by each tree, run as a DML-only `sales_preview_app`) | pure 161/161; DB **23/23 on baseline and 23/23 on feature** | the accounting triggers on `CommissionPlanVersion`/`CommissionLedgerEntry` do not change sales commission behaviour. `sales-security`/`sales-workflow` (running-app suites against the Sales preview) not run |
| Official sandbox (ZATCA) | — | **not run** | not implemented yet |
| Vercel Preview | — | **blocked** | Vercel team scope 403 |

Not claimed: "zero bugs"; production readiness of anything outside the ledger core.
