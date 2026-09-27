# Test results

**Tested commit: `cf3b43e8d75483e4520950c95c52c9e9339ba594`** on branch `feature/accounting-ledger-core`.
The run started from a clean working tree (`git status --porcelain` was empty).
Baseline: `origin/main` @ `fc64c05`, still the latest remote main.

Commits after `cf3b43e` change only `docs/accounting/`. To check this:
`git diff --name-only cf3b43e HEAD` must list nothing outside `docs/`.

Run: 2026-09-27 20:12–20:19 UTC.
- **Environment:** container Linux, Node 22.22.2, PostgreSQL 16.13 on a local disposable server
  (127.0.0.1:54329); Chromium via Playwright.
- **Production differs:** it runs PostgreSQL 17 on Neon.
- **Data:** all synthetic.
- **Stored evidence (URLs masked, no secrets):**
  - `evidence/test-runs/cf3b43e-summary.txt`
  - `evidence/test-runs/cf3b43e-certification.log`
  - `evidence/test-runs/cf3b43e-*.tap`

| Kind | Command | Result @ `cf3b43e` | What it proves / does not |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | clean | |
| Lint | `npx eslint src/lib/accounting src/app/api/accounting src/app/dashboard/accounting src/app/dashboard/finance/_components tests/accounting scripts/accounting` | clean | |
| Production build | `npm run build` | exit 0 | |
| Accounting unit | `env -i PATH=… HOME=… npm run test:accounting:unit` | **16/16** | money/rounding, Riyadh dates, template integrity, policy coverage, preview identity guard including the mock Neon API, URL classifier, bill line maths = server maths (5,000 cases), cash-flow template classes |
| Accounting DB integration | `env -i … npm run test:accounting:db` (owner role, `erp_finance_integration`) | **41/41** | ledger core (25), Stage 2 bills and bank-to-ledger (13), cash-flow statement (3, hand-worked figures) |
| Accounting scripts | `env -i … npm run test:accounting:scripts` | **4/4** | credential-rotation verifier: PASS only on authentication rejection from a reachable endpoint; refuses secrets passed as arguments |
| HTTP, production configuration | server as `accounting_app` **without** `ACCOUNTING_PROVISIONAL_POSTING`, fresh fixture, `runtime-no-switch.test.mjs` | **1/1** | an unapproved plan version stays BLOCKED and produces no journal |
| HTTP authorisation | server as `accounting_app`, `authz.test.mjs` | **5/5** | 401/403/409/400 cases; four-eyes |
| HTTP runtime workflow | `runtime-workflow.test.mjs` | **7/7** | journal and reversal workflow, periods, commission accrual exactly once, reports, audit; direct-SQL bypasses refused for the runtime role |
| HTTP Stage 2 | `stage2-workflow.test.mjs` | **4/4** | bill permissions; create → submit → four-eyes approve → post → bank payment → settled; aging tied to 2110; statement tied; paid bill cannot be reversed; the runtime role cannot bypass bill rules in SQL; bank mapping; reconciliation fully itemised; manual journal on a mapped bank account refused |
| Finance regression | `test:finance:unit`, `test:finance:db` | **52/52, 40/40** | Finance behaviour is unchanged. This includes the shared kit and the Stage 2 changes to `Supplier`, `FinCategory` and `BankTransaction` |
| Sales regression | `run-sales.mjs commission-engine quotes-domain`; `sales-commissions-db.mjs` on a fresh local `sales_preview` (migrated at this commit, run as a DML-only `sales_preview_app`) | **161 pure (48 + 113); DB 23/23** | commission and quote behaviour are unchanged. `sales-security` and `sales-workflow` (running-app suites) were not run |
| Backend regression certification | `node scripts/e2e/regression/local-certification.mjs cf3b43e…` (clean git worktree, fresh `erp_e2e`, reset boundary set for that local target only) | **26 suites, 2,300 assertions, 0 failed** | the 11 former baseline failures pass because their conditions are set up correctly, not because any check was loosened (`REGRESSION_SIDE_BY_SIDE.md`) |
| Accessibility | `a11y.mjs` (axe-core, WCAG 2.1 A/AA; 23 views; AR/EN; 1440/390) | **0 serious/critical** | automated rules only, on the accounting screens and the shell around them. Not a claim of complete application accessibility; no manual screen-reader test |
| Browser capture | `capture.mjs` (29 screens) | 0 page errors, 0 horizontal page overflow | rendering evidence; Figma comparison in `FIGMA_PARITY.md` |

## Test changes in `cf3b43e` (why they are not weakening)

A full run at `22a685c` failed three HTTP tests.

- **`authz` and `runtime-workflow`.** These Stage 1 tests posted manual journals against cash
  accounts dated after the fixture's bank-posting start date (15 Sep). Stage 2 deliberately
  refuses that, so the 409 was correct behaviour.
  - The Stage 1 tests now post to non-cash accounts (2130, 1140).
  - The refusal itself is asserted in `stage2-workflow` test 4 and in `stage2.test.ts`.
- **`runtime-no-switch`.** It ran after a server *with* the isolated-test switch had already
  posted the fixture's unapproved-plan events. It then found a TRANSLATED event where it
  expected BLOCKED.
  - The test now selects only unprocessed events and fails with a clear message if there are none.
  - The runner now reseeds and runs this suite first.
  - The production-configuration assertion is unchanged.

## Certification assertion count (2,301 earlier, 2,300 now)

`completion-gate` adds one assertion only when a deliberately raced "complete order" request
loses and receives 409. The race outcome is recorded in the log:
- at `284e207`: `complete=409`, so 70 assertions;
- at `22a685c` and `cf3b43e`: `complete=200`, so 69 assertions.

Every other suite has the same count.

## Earlier SHAs (explanation requested)

- `56011a6` was the code tested in the first delivery; `07d71c5` and `c5336b8` after it were
  documentation-only.
- All earlier results are superseded by this table.

## Not run here

| Kind | Status | Why |
|---|---|---|
| Runtime on the Neon preview database | **blocked** | no TCP 5432 from this environment; `console.neon.tech` not allow-listed (`NETWORK_ACCESS.md`) |
| Vercel Preview | **blocked** | Vercel team scope 403 |
| ZATCA sandbox | not run | not implemented yet |
| `sales-security`, `sales-workflow` | not run | need the Sales running-app preview |

Not claimed: "zero bugs"; regulatory compliance; production readiness.
