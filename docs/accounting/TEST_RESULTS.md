# Test results

**Tested commit: `74d4b03dbb071998ce3a55e338385f9c5722d0db`** on branch `feature/accounting-ledger-core`
of [https://github.com/ibrahim1440/flow.com](https://github.com/ibrahim1440/flow.com) (unpushed; see
`README.md` → "Which implementation this is"). One run of `scripts/accounting/local-release-gates.sh`
from a clean working tree ran every step below on that one commit, including the isolated year-end
browser scenario, the backend regression certification and all Sales suites. Baseline: `origin/main` @ `fc64c05`.

Commits after `74d4b03` change only `docs/accounting/`. To check this:
`git diff --name-only 74d4b03 HEAD` must list nothing outside `docs/`.

These are local results on synthetic data, produced and reported by the implementer. They are **not**
an independent review, **not** accountant acceptance and **not** production readiness. The stage 6
tests are local self-consistency and independent local checks; **they are not ZATCA validation**,
which is blocked here (`ZATCA_REQUIREMENTS.md` §1–2).

Run: 2026-09-29 12:59–13:16 UTC (`evidence/test-runs/74d4b03-summary.txt`).
- **Environment:** container Linux, Node 22, PostgreSQL 16.13 on a local disposable server
  (127.0.0.1:54329); Chromium via Playwright. HTTP and browser steps run against `next start`
  connected as the restricted runtime role `accounting_app`; the year-end scenario runs its own
  `next start` (runtime role) on the separate disposable database `erp_finance_yearend`; the Sales
  running-app suites run against `next start` on a fresh disposable `sales_preview` as `sales_preview_app`.
- **Production differs:** PostgreSQL 17 on Neon. Nothing here ran against Neon, Vercel or ZATCA.
- **Data:** all synthetic.
- **Stored evidence (URLs masked; scanned for the fixture password and the run's generated Sales
  role password: none):** `evidence/test-runs/74d4b03-*.tap`, `74d4b03-summary.txt`; captures in
  `evidence/app/` (79 screens from `capture.mjs` plus the browser-form steps, including
  `ACC-65-ye-*` and `ACC-70-simplified-gaps`).

**Invalid run kept for the record:** the first run on `7093c95` (`evidence/test-runs/7093c95-*`) is
**not valid for its HTTP and browser steps on :3040**. A server started earlier by hand (older code,
provisional switch on) was still listening, the runner's own server could not bind, and those suites
tested the stale server: `http-no-switch` failed 0/2 and `tax-forms` failed for that reason. The
runner now refuses to start when the port is already served (`74d4b03`); the rerun above is the result.

| Kind | Command | Result @ `74d4b03` | What it proves / does not |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | clean | |
| Lint | accounting sources, tests, scripts | clean | |
| Production build | `npm run build` | exit 0 | |
| Accounting unit | `npm run test:accounting:unit` | **46/46** | +5 `einvoice-qr-independent.test.ts`: TLV bytes written by hand (both QR layouts), SPKI from the SEC 2 secp256k1 constants, DER parsed by hand, BigInt ECDSA verifier, FIPS 180-2 vector, other curves refused, rules catch the other layout — **independent of the implementation, not ZATCA validation** |
| Accounting DB integration | `npm run test:accounting:db` | **110/110** | e-invoice case now checks the QR layout (44/96/88 bytes) and tag 7 = the stored signature |
| Accounting scripts | `npm run test:accounting:scripts` | **4/4** | credential-rotation verifier |
| Finance regression | `test:finance:unit`, `test:finance:db` | **52/52, 40/40** | Finance behaviour unchanged |
| HTTP, production configuration | server without `ACCOUNTING_PROVISIONAL_POSTING`, `runtime-no-switch.test.mjs` | **2/2** | |
| HTTP (runtime role) | authz 5, runtime-workflow 7, stage2 4, bank-corrections 3, receivables 3, inventory 5, ops-integration 1, fixed-assets 3, tax 2 | **all pass** | duties, four-eyes, concurrency, guards the runtime role cannot bypass |
| Browser, operational forms | `ops-forms.mjs` | **2/2** | |
| Browser, packing and dispatch | `ops-pack-dispatch.mjs` | **6/6** | |
| Browser, fixed assets | `fa-forms.mjs` | **8/8** | incl. the blocked current-year close |
| Browser, e-invoicing and VAT | `tax-forms.mjs` | **6/6** | +1: a simplified invoice's QR layout checked from the database and its standards gaps shown on screen (not SDK-validated, local key, QR layout unconfirmed, tag 9 absent) |
| **Browser, year-end close** | `local-year-end-browser.sh` → `year-end-forms.mjs` (isolated `erp_finance_yearend`) | **5/5** | conditions met; prepared by the preparer (their approval refused: no button, HTTP 403); approved and posted by a second person; CLOSING entry 2025-12-31 in the locked period 12 = hand-calculated lines; retained earnings 80,000.00; income statement unchanged; opening 2026 = hand figures, P&L zero; balance-sheet screen at 2025-12-31 (found defects 35 and 36) |
| Sales regression | pure 161 (48 + 113); DB 23/23; running app `sales-security` 34/34, `sales-workflow` 231/231 | all pass | |
| Backend regression certification | `local-certification.mjs 74d4b03…` (clean worktree, fresh `erp_e2e`) | **26 suites, 2,301 assertions, 0 failed** | see "Certification assertion count" |
| Accessibility | `a11y.mjs` (axe-core, WCAG 2.1 A/AA; 56 views) | **0 serious/critical** | automated rules only |
| Browser capture | `capture.mjs` (79 screens) | 0 page errors, 0 horizontal overflow | |

## Test changes since `da37cb0`

- New: `einvoice-qr-independent.test.ts`, `year-end-forms.mjs` (with `seed-year-end-scenario.ts` and
  `local-year-end-browser.sh`), a simplified-invoice step in `tax-forms.mjs`.
- Changed, not weakened: `einvoice-pure.test.ts` passes the DER signature bytes to `qrTlv` and uses a
  different hash for the negative verification; `einvoice.test.ts` compares tag 6 as text and adds
  length and tag 7 checks. The fixture gains one posted cash sale to the walk-in customer (a
  simplified e-invoice).
- Fixed during this round: defects 32–36 (`DEFECTS_AND_LIMITATIONS.md`), two of them product
  defects found by the new browser test (balance sheet before 1 January refused; untranslated heading).

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
and receives 409. At `74d4b03` the count is 2,301 (the stored output does not print the race line;
2,301 is the 409 outcome). At `da37cb0` the race ended `complete=200`, hence 2,300 (it was 2,301 at `efa357a`,
where it ended 409). At `7943ed3` the log records `complete=200`, hence 2,300. It was 2,301 at `d92f592`
and at `d580432` (409), and 2,300 at `cf3b43e` (200). The race outcome varies from run to run;
0 failed in every run.

## Earlier SHAs

`da37cb0` (stages 5–6), `efa357a` (stage 4b with certification and Sales), `d49d8b6` (first stage 4b delivery), `7943ed3` (stage 4 delivery), `d92f592` (Stage 3 delivery), `cf3b43e` (first Stage 2 delivery) and earlier results are superseded by this table; their stored evidence stays in `evidence/test-runs/`.

## Not run here

| Kind | Status | Why |
|---|---|---|
| Runtime on the Neon preview database | **blocked** | no TCP 5432 from this environment; `console.neon.tech` not allow-listed (`NETWORK_ACCESS.md`) |
| Vercel Preview | **blocked** | Vercel team scope 403 |
| ZATCA SDK validation of the generated XML and QR | **blocked** | the SDK is downloaded from zatca.gov.sa, refused by this environment's egress policy (re-attempted 2026-09-29, `evidence/zatca/access-attempts-2026-09-29.txt`); a third-party copy was not run (provenance unverified) |
| ZATCA sandbox / simulation submission | not run | needs network access to gw-fatoora.zatca.gov.sa and a test CSID from the developer portal |
| Migrations after the ledger core on a production copy | not run | eleven migrations (no new migration in this round); needs Neon access or approval to use the connector on a fresh rehearsal branch (`MIGRATION_AND_CUTOVER.md`) |
| Independent review, accountant acceptance | not done | not something the implementer can do |

Not claimed: "zero bugs"; ZATCA or other regulatory compliance; accountant acceptance; production readiness.
