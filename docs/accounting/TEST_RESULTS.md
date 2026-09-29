# Test results

**Tested commit: `efa357ab1298762117db42a5280b8e20636743f3`** on branch `feature/accounting-ledger-core`
of [https://github.com/ibrahim1440/flow.com](https://github.com/ibrahim1440/flow.com) (unpushed; see
`README.md` → "Which implementation this is"). The run started from a clean working tree
(`git status --porcelain` was empty) and ran every step below on that one commit, including the
backend regression certification and the Sales suites. Baseline: `origin/main` @ `fc64c05`.

Commits after `efa357a` change only `docs/accounting/`. To check this:
`git diff --name-only efa357a HEAD` must list nothing outside `docs/`.

These are local results on synthetic data, produced and reported by the implementer. They are not
an independent certification.

Run: 2026-09-29 03:13–03:25 UTC (`evidence/test-runs/efa357a-summary.txt`).
- **Environment:** container Linux, Node 22, PostgreSQL 16.13 on a local disposable server
  (127.0.0.1:54329); Chromium via Playwright. HTTP and browser steps run against `next start`
  connected as the restricted runtime role `accounting_app`.
- **Production differs:** it runs PostgreSQL 17 on Neon. Nothing here ran against Neon or Vercel.
- **Data:** all synthetic.
- **Stored evidence (URLs masked; scanned for the fixture password and the run's generated Sales
  role password: none):** `evidence/test-runs/efa357a-*.tap`, `efa357a-summary.txt`; captures in
  `evidence/app/`; regressions written before their fixes: `stage4-gaps-before-fix.txt`,
  `stage4b-workflows-before-fix.txt`, `stage4b-layer-check-before-fix.txt` (and the earlier ones).
- **Runs that are not counted:**
  - At `46e29a8`, the runner exported `.env` (the dev database) before the DB suites, and the
    integration-database guard refused to run.
  - At `373dbd0`, the first attempt failed nearly every step because the local PostgreSQL server
    had stopped while the container was idle. The runner now checks the server first. The re-run
    at `373dbd0` was all green; one Arabic string was then fixed (`efa357a`) and everything was run
    again. Only the `efa357a` run is reported here.

| Kind | Command | Result @ `efa357a` | What it proves / does not |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | clean | |
| Lint | `npx eslint src/lib/accounting src/app/api/accounting src/app/dashboard/accounting src/app/dashboard/finance/_components src/components/AccountingStatusChip.tsx tests/accounting scripts/accounting` | clean | The operational pages touched for the status chip (purchases, production, packaging, dispatch) have lint errors identical in number to `main` (`fc64c05`); none is new |
| Production build | `npm run build` | exit 0 | |
| Accounting unit | `npm run test:accounting:unit` | **30/30** | |
| Accounting DB integration | `npm run test:accounting:db` (owner role, `erp_finance_integration`) | **94/94** | Earlier 79 plus: stage 4 gaps (6, written failing first), stage 4b workflows (6: returns vs corrections over three periods, costing robustness ×3, conversion cost, supplier credit notes), operational integration (3: purchase → roast → pack incl. partial/top-up → dispatch → invoice; failures, retries, crashed worker, loss above band, locked period, unknown writer; roast cancellation, opening quantities, blend, QC rejection, kilogram lot). The chain test was re-derived by hand for stage 4b |
| Accounting scripts | `npm run test:accounting:scripts` | **4/4** | credential-rotation verifier |
| Finance regression | `test:finance:unit`, `test:finance:db` | **52/52, 40/40** | Finance behaviour unchanged |
| HTTP, production configuration | server **without** `ACCOUNTING_PROVISIONAL_POSTING`, fresh fixture, `runtime-no-switch.test.mjs` | **2/2** | |
| HTTP authorisation | `authz.test.mjs` | **5/5** | |
| HTTP runtime workflow | `runtime-workflow.test.mjs` | **7/7** | |
| HTTP Stage 2 | `stage2-workflow.test.mjs` | **4/4** | |
| HTTP bank corrections | `bank-corrections.test.mjs` | **3/3** | |
| HTTP receivables | `receivables-workflow.test.mjs` | **3/3** | |
| HTTP inventory | `inventory-workflow.test.mjs` | **5/5** | |
| HTTP operations | `ops-integration.test.mjs` | **1/1** (one scenario, 51 assertions) | As an operations user with no accounting access, through the routes the operational screens call: purchase, roast (with synthetic overhead absorption), QC, pack, dispatch; the invoice built from the order takes the dispatched cost; price credit note and supplier price-reduction credit note through the HTTP parsers; green-coffee count; cancelled batch with restock; blend; QC rejection; packaging-material count; the accountant's queue and reconciliation; the viewer cannot act |
| Browser, operational forms | `tests/accounting/visual/ops-forms.mjs` | **2/2** | An operations user fills the real purchase form and roast-to-stock form; the screens show "posted to accounts" and the documents and journal exist (`evidence/app/OPS-form-*.png`). The dispatch and packing forms are driven over HTTP only |
| Sales regression | `run-sales.mjs commission-engine quotes-domain`; `sales-commissions-db.mjs` on a fresh local `sales_preview` (DML-only role) | **161 pure (48 + 113); DB 23/23** | commission and quote behaviour unchanged. `sales-security` and `sales-workflow` (running-app suites) were not run |
| Backend regression certification | `node scripts/e2e/regression/local-certification.mjs efa357a…` (clean worktree, fresh `erp_e2e`) | **26 suites, 2,301 assertions, 0 failed** | includes the operational suites (orders to delivery, packaging, roasting) with the integration in their transactions |
| Accessibility | `a11y.mjs` (axe-core, WCAG 2.1 A/AA; 46 views incl. ACC-48..51) | **0 serious/critical** | automated rules only; no manual screen-reader test; the operational screens were not in the audit |
| Browser capture | `capture.mjs` (66 screens incl. ACC-48..53, invoice costing, and the purchases, production, packaging, dispatch screens) | 0 page errors, 0 horizontal page overflow | rendering evidence (`evidence/app/`) |

## Test changes since `7943ed3` (why they are not weakening)

- **`inventory.test.ts` chain:** re-derived by hand for stage 4b. A landed cost and a price
  difference on green coffee already roasted now follow the goods into roasted coffee and abnormal
  loss instead of COGS; the customer return goes through the return workflow; the invoice reversal
  moves the cost to "delivered, not invoiced" instead of restoring stock. Every figure is in the
  file header. While re-deriving it, a real defect was found and fixed (defect 25).
- **`receivables.test.ts`, `subledger-history.test.ts`:** credit notes now state their type
  (`creditType: "PRICE_ADJUSTMENT"`); a credit note without it is refused.
- **`inventory.test.ts` historical GRNI:** the explanation adds credit notes awaiting settlement.
- **Fixture:** customer returns through the workflow; synthetic cost pools; a supplier credit note;
  an order line ready to ship and a BOM; new users (`acc.warehouse`, `ops.roastery`).

## Earlier test changes, since `d92f592`

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

`d49d8b6` (first stage 4b delivery), `7943ed3` (stage 4 delivery), `d92f592` (Stage 3 delivery), `cf3b43e` (first Stage 2 delivery) and earlier results are superseded by this table; their stored evidence stays in `evidence/test-runs/`.

## Not run here

| Kind | Status | Why |
|---|---|---|
| Runtime on the Neon preview database | **blocked** | no TCP 5432 from this environment; `console.neon.tech` not allow-listed (`NETWORK_ACCESS.md`) |
| Vercel Preview | **blocked** | Vercel team scope 403 |
| ZATCA sandbox | not run | not implemented yet (stage 6) |
| Migrations after the ledger core on a production copy | not run | needs Neon access or approval to use the connector on a fresh rehearsal branch (`MIGRATION_AND_CUTOVER.md`) |
| `sales-security`, `sales-workflow` | not run | need the Sales running-app preview |

Not claimed: "zero bugs"; regulatory compliance; production readiness.
