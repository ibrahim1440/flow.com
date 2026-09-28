# Test results

**Tested commit: `7943ed3af314c8b8f720540203de71058c82709d`** on branch `feature/accounting-ledger-core`
of `ibrahim1440/flow.com` (unpushed; see `README.md` → "Which implementation this is").
The run started from a clean working tree (`git status --porcelain` was empty).
Baseline: `origin/main` @ `fc64c05`.

Commits after `7943ed3` change only `docs/accounting/`. To check this:
`git diff --name-only 7943ed3 HEAD` must list nothing outside `docs/`.

Run: 2026-09-28 12:16–12:27 UTC.
- **Environment:** container Linux, Node 22.22.2, PostgreSQL 16.13 on a local disposable server
  (127.0.0.1:54329); Chromium via Playwright.
- **Production differs:** it runs PostgreSQL 17 on Neon. Nothing here ran against Neon or Vercel.
- **Data:** all synthetic.
- **Stored evidence (URLs masked; scanned for database URLs, their passwords and the fixture
  password: none):**
  - `evidence/test-runs/7943ed3-summary.txt`
  - `evidence/test-runs/7943ed3-certification.log`
  - `evidence/test-runs/7943ed3-*.tap`
  - regressions written before their fixes, failing against the old code:
    `cashflow-regression-before-fix.txt`, `cashflow-history-before-fix.txt`,
    `subledger-history-before-fix.txt`, `grni-history-before-fix.txt`
- **The previous commit `d580432` was run the same way.** Every step passed except
  `runtime-no-switch`. That test asserted "no provisional journal anywhere", but the stage 4
  fixture deliberately seeds provisional inventory journals. The check was narrowed so that it
  still fails if the server creates any provisional journal, and a D-1 refusal case was added
  (`7943ed3`). This is the only change between the two runs.

| Kind | Command | Result @ `7943ed3` | What it proves / does not |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | clean | |
| Lint | `npx eslint src/lib/accounting src/app/api/accounting src/app/dashboard/accounting src/app/dashboard/finance/_components tests/accounting scripts/accounting` | clean | |
| Production build | `npm run build` | exit 0 | |
| Accounting unit | `env -i PATH=… HOME=… npm run test:accounting:unit` | **30/30** | Earlier 23, plus 7 inventory costing tests: FIFO and weighted-average consumption; the DECISION_PACK loss example (1,920.00 → 1,834.15 + 85.85); multi-output split; value conservation over 3,000 random sequences |
| Accounting DB integration | `env -i … npm run test:accounting:db` (owner role, `erp_finance_integration`) | **79/79** | Ledger core 25; Stage 2 13; cash flow 3 + 6 + **3 history**; bank corrections 8; receivables 10; **subledger history 2**; **inventory 9**. Inventory covers the whole purchasing → production → sale chain (every journal worked by hand, valuation = GL at three month ends, February margin unchanged by a later reversal), historical GRNI, and controls (FIFO, D-1 gating, bands, no negative stock or back-dating, racing posts, DB tamper, operational drafts) |
| Accounting scripts | `env -i … npm run test:accounting:scripts` | **4/4** | credential-rotation verifier |
| HTTP, production configuration | server as `accounting_app` **without** `ACCOUNTING_PROVISIONAL_POSTING`, fresh fixture, `runtime-no-switch.test.mjs` | **2/2** | An unapproved plan version stays BLOCKED, with no journal and no provisional journal created by the server. An inventory document cannot post while D-1 is undecided (409, nothing half-posted) |
| HTTP authorisation | `authz.test.mjs` | **5/5** | 401/403/409/400 cases; four-eyes |
| HTTP runtime workflow | `runtime-workflow.test.mjs` | **7/7** | journals, reversals, periods, commissions exactly once, reports, audit; SQL bypasses refused |
| HTTP Stage 2 | `stage2-workflow.test.mjs` | **4/4** | bill workflow, bank posting, aging/statement tie-outs, SQL bypass refused |
| HTTP bank corrections | `bank-corrections.test.mjs` | **3/3** | Finance cannot change a posted line; four-eyes void/replace; retry refused; guards hold for the runtime role |
| HTTP receivables | `receivables-workflow.test.mjs` | **3/3** | invoice duties and four-eyes; one journal under concurrency; receipt from a sales collection (commissions unchanged); aging ties to 1130; SQL bypasses refused |
| HTTP inventory (new) | `inventory-workflow.test.mjs` | **5/5** | Duties, idempotent create, four-eyes. Two concurrent posts give one 200 and one 409: one journal, one move, and a retry adds nothing. Cost of sales cannot be entered by hand. Back-dating is refused with nothing half-posted. A roasting batch posts within its band. Valuation and GRNI tie to the ledger. SQL bypasses are refused |
| Finance regression | `test:finance:unit`, `test:finance:db` | **52/52, 40/40** | Finance behaviour unchanged |
| Sales regression | `run-sales.mjs commission-engine quotes-domain`; `sales-commissions-db.mjs` on a fresh local `sales_preview` (DML-only role) | **161 pure (48 + 113); DB 23/23** | commission and quote behaviour unchanged. `sales-security` and `sales-workflow` (running-app suites) were not run |
| Backend regression certification | `node scripts/e2e/regression/local-certification.mjs 7943ed3…` (clean worktree, fresh `erp_e2e`) | **26 suites, 2,300 assertions, 0 failed** | see the assertion-count note below |
| Accessibility | `a11y.mjs` (axe-core, WCAG 2.1 A/AA; AR/EN; 1440/390; ACC-01..47) | **0 serious/critical** | automated rules only; no manual screen-reader test |
| Browser capture | `capture.mjs` (51 screens, on a freshly reseeded fixture) | 0 page errors, 0 horizontal page overflow | rendering evidence; Figma comparison in `FIGMA_PARITY.md` and `evidence/side/` |

## Test changes since `d92f592` (why they are not weakening)

- **New regressions, committed failing before their fixes:**
  - `cashflow-history.test.ts` (`aa1351e`, fixed in `ec6de49`);
  - `subledger-history.test.ts` (`4c2d6c1`, fixed in `31baa0a`);
  - the "historical GRNI" case in `inventory.test.ts` (red against `fde4632`'s report code, fixed
    in `ce93d3f`).
- **`receivables.test.ts`:** reallocating an unapplied credit note to another invoice used to
  assert "no journal". It now asserts one net-zero journal on 1130 that moves the balance from the
  credit note's open item to the invoice's. The receivables total is unchanged, and aging per
  invoice is now reproducible from the ledger.
- **`runtime-no-switch.test.mjs`:** see above; the guarantee (the server without the switch makes
  no provisional journal) is kept, and a D-1 case is added.
- **`support.ts`:** the reset also truncates the inventory tables and the operational tables they
  reference.

## Earlier test changes, since `cf3b43e`

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
and receives 409. At `7943ed3` the log records `complete=200`, hence 2,300. It was 2,301 at `d92f592`
and at `d580432` (409), and 2,300 at `cf3b43e` (200). The race outcome varies from run to run;
0 failed in every run.

## Earlier SHAs

`d92f592` (Stage 3 delivery), `cf3b43e` (first Stage 2 delivery) and earlier results are superseded by this table; their stored evidence stays in `evidence/test-runs/`.

## Not run here

| Kind | Status | Why |
|---|---|---|
| Runtime on the Neon preview database | **blocked** | no TCP 5432 from this environment; `console.neon.tech` not allow-listed (`NETWORK_ACCESS.md`) |
| Vercel Preview | **blocked** | Vercel team scope 403 |
| ZATCA sandbox | not run | not implemented yet (stage 6) |
| Migrations after the ledger core on a production copy | not run | needs Neon access or approval to use the connector on a fresh rehearsal branch (`MIGRATION_AND_CUTOVER.md`) |
| `sales-security`, `sales-workflow` | not run | need the Sales running-app preview |

Not claimed: "zero bugs"; regulatory compliance; production readiness.
