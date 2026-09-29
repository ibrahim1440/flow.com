# Test results

**Tested commit: `da37cb06b54e489d0192fad90b1df060e52b1005`** on branch `feature/accounting-ledger-core`
of [https://github.com/ibrahim1440/flow.com](https://github.com/ibrahim1440/flow.com) (unpushed; see
`README.md` → "Which implementation this is"). The run started from a clean working tree and ran
every step below on that one commit, including the backend regression certification and all Sales
suites. Baseline: `origin/main` @ `fc64c05`.

Commits after `da37cb0` change only `docs/accounting/`. To check this:
`git diff --name-only da37cb0 HEAD` must list nothing outside `docs/`.

These are local results on synthetic data, produced and reported by the implementer. They are not
an independent certification, not accountant acceptance and not production readiness. The stage 6
tests show our own local checks pass; **they are not ZATCA validation**.

Run: 2026-09-29 09:00–09:17 UTC (`evidence/test-runs/da37cb0-summary.txt`).
- **Environment:** container Linux, Node 22, PostgreSQL 16.13 on a local disposable server
  (127.0.0.1:54329); Chromium via Playwright. HTTP and browser steps run against `next start`
  connected as the restricted runtime role `accounting_app`; the Sales running-app suites run against
  `next start` on a fresh disposable `sales_preview` as the DML-only role `sales_preview_app`.
- **Production differs:** it runs PostgreSQL 17 on Neon. Nothing here ran against Neon, Vercel or ZATCA.
- **Data:** all synthetic.
- **Stored evidence (URLs masked; scanned for the fixture password and the run's generated Sales
  role password: none):** `evidence/test-runs/da37cb0-*.tap`, `da37cb0-summary.txt`; captures in
  `evidence/app/` (79 screens from `capture.mjs` plus the browser-form steps).

| Kind | Command | Result @ `da37cb0` | What it proves / does not |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | clean | |
| Lint | accounting sources, tests, scripts | clean | operational pages touched for the status chip keep the lint errors `main` has; none is new |
| Production build | `npm run build` | exit 0 | |
| Accounting unit | `npm run test:accounting:unit` | **41/41** | +6 depreciation arithmetic, +5 e-invoice building blocks (QR encoding matches the published phase-1 example) |
| Accounting DB integration | `npm run test:accounting:db` | **110/110** | +1 item link, +7 fixed assets, +2 year-end, +6 e-invoicing/VAT (retry, concurrency, locked/closed periods, chain and immutability guards) |
| Accounting scripts | `npm run test:accounting:scripts` | **4/4** | credential-rotation verifier |
| Finance regression | `test:finance:unit`, `test:finance:db` | **52/52, 40/40** | Finance behaviour unchanged |
| HTTP, production configuration | server without `ACCOUNTING_PROVISIONAL_POSTING`, `runtime-no-switch.test.mjs` | **2/2** | |
| HTTP (runtime role) | authz 5, runtime-workflow 7, stage2 4, bank-corrections 3, receivables 3, inventory 5, ops-integration 1 (51 assertions), fixed-assets 3, tax 2 | **all pass** | duties, four-eyes, concurrency, guards the runtime role cannot bypass |
| Browser, operational forms | `ops-forms.mjs` | **2/2** | purchase and roast-to-stock forms |
| Browser, packing and dispatch forms | `ops-pack-dispatch.mjs` | **6/6** | refusals; posted pack; held pack approved and posted by the accountant; blocked pack recovered by linking the item and retrying; dispatch refusals and postings; quantities, documents and journals checked |
| Browser, fixed assets and year-end | `fa-forms.mjs` | **8/8** | capitalisation four-eyes; threshold refusal; disposal (refused, then posted with its loss); run computed, duplicate refused, approved, reversed; reconciliation with nothing unexplained; year-end blockers shown |
| Browser, e-invoicing and VAT | `tax-forms.mjs` | **5/5** | profile four-eyes; invalid document fixed and retried; debit note through the receivables form; LOCAL_ONLY submission recorded as not sent; VAT return with nothing unexplained |
| Sales regression | pure 161 (48 + 113); DB 23/23; **running app: `sales-security` 34/34, `sales-workflow` 231/231** | all pass | the running-app suites against `next start` on a disposable `sales_preview` as a DML-only role (`scripts/e2e/regression/local-sales-app-suites.sh`) |
| Backend regression certification | `local-certification.mjs da37cb0…` (clean worktree, fresh `erp_e2e`) | **26 suites, 2,300 assertions, 0 failed** | see "Certification assertion count" below |
| Accessibility | `a11y.mjs` (axe-core, WCAG 2.1 A/AA; 56 views incl. ACC-60..65, ACC-70..72) | **0 serious/critical** | automated rules only; no manual screen-reader test |
| Browser capture | `capture.mjs` (79 screens) | 0 page errors, 0 horizontal page overflow | rendering evidence |

## Test changes since `efa357a`

- New suites only (listed above); no existing assertion was weakened. `support.ts` and the fixture
  reset also truncate the stage 5–6 tables. The fixture gained stage 5 data (synthetic classes,
  assets, one run), an approved synthetic e-invoicing profile, a synthetic national address for one
  customer, a 500 g SKU and an unlinked item (packing test).
- Found by the new tests and fixed before `da37cb0`: the disposal form closed on a refusal
  (defect 29); English text in the Arabic stage 5–6 screens (defect 30); the VAT reconciliation had
  no unexplained remainder (defect 31).

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
and receives 409. At `da37cb0` the race ended `complete=200`, hence 2,300 (it was 2,301 at `efa357a`,
where it ended 409). At `7943ed3` the log records `complete=200`, hence 2,300. It was 2,301 at `d92f592`
and at `d580432` (409), and 2,300 at `cf3b43e` (200). The race outcome varies from run to run;
0 failed in every run.

## Earlier SHAs

`efa357a` (stage 4b with certification and Sales), `d49d8b6` (first stage 4b delivery), `7943ed3` (stage 4 delivery), `d92f592` (Stage 3 delivery), `cf3b43e` (first Stage 2 delivery) and earlier results are superseded by this table; their stored evidence stays in `evidence/test-runs/`.

## Not run here

| Kind | Status | Why |
|---|---|---|
| Runtime on the Neon preview database | **blocked** | no TCP 5432 from this environment; `console.neon.tech` not allow-listed (`NETWORK_ACCESS.md`) |
| Vercel Preview | **blocked** | Vercel team scope 403 |
| ZATCA SDK validation of the generated XML | **blocked** | the SDK is downloaded from zatca.gov.sa, which this environment's egress policy blocks |
| ZATCA sandbox / simulation submission | not run | needs network access to gw-fatoora.zatca.gov.sa and a test CSID from the developer portal |
| Migrations after the ledger core on a production copy | not run | eleven migrations; needs Neon access or approval to use the connector on a fresh rehearsal branch (`MIGRATION_AND_CUTOVER.md`) |
| Year-end close through the browser | not run | the fixture has no prior year to close; the close is exercised in `year-end.test.ts` |

Not claimed: "zero bugs"; ZATCA or other regulatory compliance; accountant acceptance; production readiness.
