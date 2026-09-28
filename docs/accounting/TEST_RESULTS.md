# Test results

**Tested commit: `d92f5921de01f8efc59b62958d8bb84ca6da4724`** on branch `feature/accounting-ledger-core`.
The run started from a clean working tree (`git status --porcelain` was empty).
Baseline: `origin/main` @ `fc64c05`.

Commits after `d92f592` change only `docs/accounting/`. To check this:
`git diff --name-only d92f592 HEAD` must list nothing outside `docs/`.

Run: 2026-09-28 04:10–04:19 UTC.
- **Environment:** container Linux, Node 22.22.2, PostgreSQL 16.13 on a local disposable server
  (127.0.0.1:54329); Chromium via Playwright.
- **Production differs:** it runs PostgreSQL 17 on Neon. Nothing here ran against Neon or Vercel.
- **Data:** all synthetic.
- **Stored evidence (URLs masked; scanned for credential URLs and the fixture password: none):**
  - `evidence/test-runs/d92f592-summary.txt`
  - `evidence/test-runs/d92f592-certification.log`
  - `evidence/test-runs/d92f592-*.tap`
  - `evidence/test-runs/cashflow-regression-before-fix.txt` (the new cash-flow tests failing
    against the old implementation, before the fix)

| Kind | Command | Result @ `d92f592` | What it proves / does not |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | clean | |
| Lint | `npx eslint src/lib/accounting src/app/api/accounting src/app/dashboard/accounting src/app/dashboard/finance/_components tests/accounting scripts/accounting` | clean | |
| Production build | `npm run build` | exit 0 | |
| Accounting unit | `env -i PATH=… HOME=… npm run test:accounting:unit` | **23/23** | money/rounding, Riyadh dates, template integrity, policy coverage, preview identity guard, URL classifier, bill and sales line maths = server maths (5,000 cases each), cash-flow engine and template classes |
| Accounting DB integration | `env -i … npm run test:accounting:db` (owner role, `erp_finance_integration`) | **65/65** | ledger core (25), Stage 2 (13), cash flow (3 + 6 transaction regression cases), bank corrections (8), receivables (10) |
| Accounting scripts | `env -i … npm run test:accounting:scripts` | **4/4** | credential-rotation verifier |
| HTTP, production configuration | server as `accounting_app` **without** `ACCOUNTING_PROVISIONAL_POSTING`, fresh fixture, `runtime-no-switch.test.mjs` | **1/1** | an unapproved plan version stays BLOCKED and produces no journal |
| HTTP authorisation | server as `accounting_app`, `authz.test.mjs` | **5/5** | 401/403/409/400 cases; four-eyes |
| HTTP runtime workflow | `runtime-workflow.test.mjs` | **7/7** | journals, reversals, periods, commissions exactly once, reports, audit; SQL bypasses refused |
| HTTP Stage 2 | `stage2-workflow.test.mjs` | **4/4** | bill workflow, bank posting, aging/statement tie-outs, SQL bypass refused |
| HTTP bank corrections | `bank-corrections.test.mjs` | **3/3** | Finance cannot change a posted line (409 from every path); four-eyes void/replace; retry refused; runtime role cannot bypass the guards |
| HTTP receivables (new) | `receivables-workflow.test.mjs` | **3/3** | invoice duties and four-eyes; concurrent post → one journal; receipt named by an approved sales collection → one bank journal, commission journals unchanged, the collection never posts; concurrent claims on one collection → one wins with a clear 409; aging ties to 1130; SQL bypasses refused |
| Finance regression | `test:finance:unit`, `test:finance:db` | **52/52, 40/40** | Finance behaviour unchanged, including the posted-line checks added to Finance services |
| Sales regression | `run-sales.mjs commission-engine quotes-domain`; `sales-commissions-db.mjs` on a fresh local `sales_preview` (DML-only role) | **161 pure (48 + 113); DB 23/23** | commission and quote behaviour unchanged. `sales-security` and `sales-workflow` (running-app suites) were not run |
| Backend regression certification | `node scripts/e2e/regression/local-certification.mjs d92f592…` (clean worktree, fresh `erp_e2e`) | **26 suites, 2,301 assertions, 0 failed** | see the assertion-count note below |
| Accessibility | `a11y.mjs` (axe-core, WCAG 2.1 A/AA; 33 views; AR/EN; 1440/390) | **0 serious/critical** | automated rules only; no manual screen-reader test |
| Browser capture | `capture.mjs` (41 screens, on a freshly reseeded fixture) | 0 page errors, 0 horizontal page overflow | rendering evidence; Figma comparison in `FIGMA_PARITY.md` and `evidence/side/` |

## Test changes since `cf3b43e` (why they are not weakening)

- **Cash flow:** `cashflow-transactions.test.ts` was committed first (`548fa42`) and failed against the
  old implementation (output kept); the fix followed in `2fa3578`. In `cashflow.test.ts` every
  total is unchanged; the line assertions follow the new result shape (depreciation is reported as
  a non-cash add-back of expense 6600 instead of a movement on 1290), and one assertion was added
  (indirect operating total = direct).
- **`stage2.test.ts`:** a customer receipt now waits for assignment ("Assign this line to a
  customer") instead of "waits for stage 3"; the transfer-void case goes through the correction
  workflow because a direct void of a posted line is now refused.
- **`bank-corrections.test.mjs`:** selects a posted *payment* line, because the fixture now also has
  posted customer receipts (a positive line cannot be replaced by a payment; that refusal is correct).
- **Runner:** reseeds the fixture after the HTTP suites so captures and the audit start from a known state.

## Certification assertion count

`completion-gate` adds one assertion only when a deliberately raced "complete order" request loses
and receives 409. At `d92f592` the log records `complete=409`, hence 2,301 (2,300 at `cf3b43e`,
where it was 200).

## Earlier SHAs

`cf3b43e` (first Stage 2 delivery) and earlier results are superseded by this table.

## Not run here

| Kind | Status | Why |
|---|---|---|
| Runtime on the Neon preview database | **blocked** | no TCP 5432 from this environment; `console.neon.tech` not allow-listed (`NETWORK_ACCESS.md`) |
| Vercel Preview | **blocked** | Vercel team scope 403 |
| ZATCA sandbox | not run | not implemented yet (stage 6) |
| Migrations after the ledger core on a production copy | not run | needs Neon access or approval to use the connector on a fresh rehearsal branch (`MIGRATION_AND_CUTOVER.md`) |
| `sales-security`, `sales-workflow` | not run | need the Sales running-app preview |

Not claimed: "zero bugs"; regulatory compliance; production readiness.
