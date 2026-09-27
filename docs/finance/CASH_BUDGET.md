# Finance — cash management, receipt allocation and the monthly cash budget

Branch `feature/finance-cash-budget`, cut from `origin/main` at `4640cbe` (2026-09-19). Not
merged, not deployed, no production data touched.

## 1. What exists and where

| Area | Route (UI) | Service | API |
|---|---|---|---|
| Overview | `/dashboard/finance` | `src/lib/finance/server/dashboard.ts` | `GET /api/finance/overview`, `/forecast`, `/pools` |
| Transactions & reconciliation | `/dashboard/finance/transactions` | `transactions.ts`, `reconciliation.ts` | `/api/finance/transactions/**`, `/imports`, `/imports/preview`, `/transfers`, `/matches`, `/attachments`, `/reconciliations` |
| Cash allocation | `/dashboard/finance/allocation` | `allocation.ts`, `ledger.ts` | `/api/finance/categories`, `/rules`, `/rules/preview`, `/allocations/*`, `/reservations`, `/payments` |
| Monthly budget | `/dashboard/finance/budget` | `budgets.ts` | `/api/finance/budgets/**`, `/notes` |
| Obligations & forecasts | `/dashboard/finance/obligations` | `obligations.ts`, `dashboard.ts` | `/api/finance/obligations`, `/forecast-items`, `/forecast` |
| Reports & settings | `/dashboard/finance/reports` | `setup.ts` | `/api/finance/setup/**`, `/export`, `/audit` |
| Approvals (dialog in every tab) | header button | `approvals.ts`, `approval-core.ts` | `/api/finance/approvals`, `/{id}/decide`, `/{id}/withdraw` |

Pure calculation modules (no database): `src/lib/finance/money.ts` (integer halalas, exact
largest-remainder splitting), `allocation-engine.ts`, `variance.ts`, `phasing.ts`,
`forecast.ts`, `csv.ts`, `classes.ts`, `connectors.ts` (bank-feed interface, none registered).

One sidebar entry ("المالية / Finance"); the six areas are tabs inside the section.

## 2. Reporting basis and sources of actual figures

**Cash basis.** The accounting module (S0) has a chart of accounts and manual journals, but no
operational module posts accounting events and `AccountingSettings.setupComplete` is false.
Accrual actuals would therefore be incomplete, so:

- budgets are receipts and payments (`basis = CASH`); `ACCRUAL` is refused with the reason;
- the accrual view is shown as unavailable with the live reasons (Reports & settings);
- net cash flow is labelled "not profit"; no profit figure is derived anywhere (acceptance 19).

**Actuals** = `BankTransactionSplit` rows of CONFIRMED bank lines dated in the month up to the
report date, by budget category. A split is written only when a person reviews a line; splits
must sum exactly to the line. Transfers between company accounts carry no split and never
reach receipts or payments. Settlements are split gross (+) and fee (−) so the total equals
the net deposit. Loans and owner contributions are financing categories, shown separately.

**Completeness** is reported with every figure: lines needing review, pending lines, the date
all accounts are reconciled through. A zero actual is called "verified" only when complete.

**What does not exist on `main`** and therefore is not a source: invoices, receipts, payments,
bank accounts, payroll, branches, cost centres; orders carry no prices. Receipts are matched
to **orders** by reference (no invoice value is available, so outstanding amounts are not
computed). Purchase records can become one obligation each (they carry no payment status).

## 3. The six concepts, kept apart

| Concept | Record | Never |
|---|---|---|
| Bank/cash transaction | `BankTransaction` (+ splits, matches) | deleted — voided with reason |
| Allocation | `AllocationEntry` (append-only, DB trigger) | an expense, a bank transfer or a journal |
| Reservation | `PaymentReservation` | a payment |
| Payment | outgoing `BankTransaction` + `PAYMENT` entry + obligation match | counted twice; **never sent by the app** |
| Accounting revenue/expense | Accounting module (untouched) | inferred from cash |
| Forecast | `FinForecastItem`, obligations, `FinForecastSnapshot` | counted as cash |

Balances (policy D1, adopted 2026-09-26): **confirmed outgoing payment commitments reduce the
cash available for new allocation before bank settlement, and each economic payment reduces it
exactly once** (`src/lib/finance/exactly-once.ts`, `server/ledger.ts`).

- category balance = opening carried + allocations + incoming − payments − outgoing;
  category available = balance − open requests (approved and awaiting approval).
- **eligible cash** = unrestricted confirmed book cash − pending outgoing lines that are
  *confirmed commitments* (entered by a person, paid against a request, or reviewed). An
  imported pending outflow nobody has confirmed is **awaiting review**: shown on the pool
  card and in the review queue, not deducted. Pending inflows never count. A possible-duplicate
  pair counts once until a reviewer merges or separates it.
- **allocated** (held back) = Σ max(category balance, approved requests, 0): an approved request
  beyond the category's balance holds back the excess; an overspent category frees nothing.
- **unallocated** = eligible − allocated: the cap for every new allocation. allocated +
  unallocated = eligible cash, exactly (acceptance 18).
- One payment has up to four records — request, recorded payment, pending line, settled line.
  They are traced, not added: an outgoing line for exactly an approved request's amount that is
  not yet linked is treated as that request's payment (reported, counted once) until "Record
  payment made" links it; a settled statement row confirms the pending line it was imported as
  (import status SETTLES); a failed payment (line voided) reopens the request, so availability
  returns only when the request itself is released.
- Step-by-step balances for each case: `evidence/d1-balances.md` (from
  `tests/finance/integration/exactly-once.test.ts`).

### Paying: "Record payment made" (no bank connector)

The application **never sends money**. The flow is: payment request (reservation) → approval
if over limit/balance → the person makes the transfer in online banking → records it here as
an outgoing line (usually PENDING, with the bank reference) → **"تسجيل الدفع المنفّذ / Record
payment made"** links the reservation to that line (category reduced, reservation released, in
one transaction). The button was previously labelled "Execute payment"; it was renamed because
it implied the app transfers funds.

### Statement lines that confirm an existing line

When a CSV statement is previewed/imported, each row is first checked against lines already
recorded by hand (same account, same signed amount, not void, never confirmed by a statement):
same bank reference, or — when either side has none — a statement date from 3 days before to
7 days after the recorded date. Exactly one candidate → the row **confirms that line** (status
PENDING→CONFIRMED when dated today or earlier, statement date and fingerprint attached, audit
`bank_txn.statement_confirmed`) and **no new line is created**. Several candidates → the row is
imported FLAGGED and a reviewer uses "same money as the recorded line — merge"
(`POST /api/finance/transactions/:id/resolve-duplicate`): the imported line is voided and its
statement identity moves to the recorded line. Re-importing the same statement is a no-op.

### Opening balances

Opening balances are account attributes, not transactions: they are never monthly receipts,
never budget actuals, and can be allocated once — manual allocation from an account's opening
balance is limited to the part not yet allocated, serialised by the pool lock (tested with four
concurrent attempts: exactly one succeeds).

## 4. Allocation engine

Fixed execution order: (1) VAT from matched documents, (2) all percentages on the same base,
(3) obligations due, (4) targets by priority, (5) weighted remainder, (6) rest unallocated.
Base = the receipt's unallocated net deposit − VAT reserved. Monthly targets do not refill
after spending; reserve targets refill only when `replenish` is set. Tax reserves cannot take
a flat percentage. Rules are versioned; a version takes effect only after approval by someone
else; automatic execution only under an approved version with `autoExecute`. One run per
receipt (unique), all pool writes serialised by a PostgreSQL advisory lock. Reclassifying or
voiding an allocated receipt posts reversing entries; if the money was spent the category
goes negative and an alert says so.

## 5. Decision on Actual Budget

Reviewed: the repository (MIT), the API docs, the API reference, budget automation and goal
templates. **Not integrated; no code copied; used as a reference.**

- Actual is a single-user, local-first personal-finance app. Its data lives in its own SQLite
  file synced by a separate server; the "API" is a Node package that downloads that file.
  Integrating it would create a second source of truth for cash beside the ERP's PostgreSQL,
  with no roles, approvals, branches or audit.
- Templates and automation are marked experimental and may change or be removed.
- Ideas adopted natively: integer minor units; priority-ordered filling; the difference between
  a simple monthly amount and an "up to" (refill) goal; weighted remainder; copying last month.

Because no Actual Budget code is included, no licence notice is required.

## 6. Database

Migrations (additive only):
`20260926005011_add_finance_cash_budget` — 27 new
tables, no change to existing tables) plus hand-written CHECK constraints, partial unique
indexes (one active rule version per scope, one completed reconciliation per account/date, one
live match per line/document) and append-only triggers (`AllocationEntry`, `AllocationRun`,
`FinAuditLog`; bank lines cannot be deleted; approved budget revisions and their lines cannot
change). `20260926092523_finance_statement_matching_and_db_controls` — statement-matching
columns and **database-level four-eyes controls** (see VERIFICATION.md §3): approval requests
cannot be deleted, decided requests cannot change, a decision needs a decider who is not the
requester; budget revisions and allocation-rule versions cannot be approved by their author.
`20260926140000_finance_strict_four_eyes` — removes the self-approval setting entirely (column
and helper dropped; no setting or session variable is consulted); requests must be created
pending; a held payment request, a rule going live, an approved revision, a category transfer
and a reopened period each require an APPROVED request decided by someone other than its
requester. Money is `Decimal(18,2)` SAR.

`schema.prisma` differs from `origin/main` by one appended block only. Do not run `prisma
format` on this repository: `origin/main` is not formatted and the tool rewrites unrelated models.

**Apply in a test environment** (never production without a backup and approval):

```bash
DATABASE_URL=… DIRECT_URL=… npm run db:migrate:deploy
```

## 7. Isolated development database used here

No PostgreSQL, Docker or WSL is installed on this machine, and the shared Neon endpoints were
not used. A disposable PostgreSQL 17 runs from `.local-postgres/` (gitignored; the
`embedded-postgres` npm package, MIT), loopback only, port 54329, UTF-8:

```bash
npm run db:local                         # start (keeps running)
set -a; . ./.env; set +a; node scripts/migrate-deploy.mjs   # erp_finance_dev
npm run finance:fixture -- --reset       # realistic local fixture (refuses any other DB)
```

`.env` in this worktree points only at `127.0.0.1:54329`; `.env.test` at `erp_finance_test`.

Guards, masked connection report, package source/version/integrity, stop/start/restart and the
**conflicting classifications of the shared Neon endpoints** are in `ENVIRONMENT.md`.

## 8. Build and tests

`npm run build` on `origin/main` is already migration-free (env check → `prisma generate` →
`next build`); migrations are only `npm run db:migrate:deploy`. The "build runs migrations"
note in the main checkout's `CLAUDE.md` is out of date.

| Suite | Command | Result |
|---|---|---|
| Pure unit (acceptance 1, 5/6 pure, 10, 11, 12, 14, rounding, CSV, forecast, DB guard, sales-collection matching rule, exactly-once rules) | `npm run test:finance:unit` | 36/36 pass |
| DB integration on `erp_finance_test` (acceptance 1–9, 13, 15–19, workflow, lifecycle with statement matching, duplicate merge, opening balances, D1 exactly-once, DB controls and bypass attempts as `finance_app`) | `npm run test:finance:db` | 28 pass, 0 fail, 5 skipped (sales-collection specifications) |
| HTTP on a running server (acceptance 16, 17; first grant by an administrator) | `npm run test:finance:http` | 6/6 pass |
| UI workflow in Chrome (classify → allocate → budget → approve → override → record payment made against a pending line → statement import confirms it → actuals once) | `npm run test:finance:ui` | 10/10 steps pass |
| Typecheck / production build | `npx tsc --noEmit`, `npm run build` | clean / compiles |

Exact commands, the repository's own regression suites and their baseline comparison are in
`VERIFICATION.md`.

`npm run dev` (webpack) fails on `main` before any finance code runs (`instrumentation` →
`server-env` → `pin-lookup` imports `node:crypto`); verification used `npm run build` +
`next start`. Project-wide `npm run lint` reports existing findings in untouched files; the
finance code lints clean.

## 9. First configuration

1. Grant the **Finance** module to the right employees (Employees screen) with separated
   duties: preparers (`txn_enter`, `reconcile`, `budget_prepare`, `allocate`) and approvers
   (`budget_approve`, `transfer_approve`, `spend_override_approve`, `period_close`). Existing
   employees, including admins, have no finance access until granted. Granting needs only
   `employees.edit` — the administrator does not need Finance — and takes effect on the
   grantee's next request (permissions are read from the database per request). Verified over
   HTTP in `tests/finance/http/admin-grant.test.mjs`.
2. Reports & settings → add bank/cash accounts with opening balances (last 4 digits only);
   mark guarantees restricted. Add branches and branch access if needed.
3. "Add suggested" for budget and allocation categories (names only, no amounts). Set targets,
   limits and override approvers on each allocation category.
4. Cash allocation → create a rules draft (percentages must be ≤ 100 %), preview it including
   the lower-collections scenario, submit; another person approves.
5. Monthly budget → new budget (copy last month or last month's actuals), add lines with due
   dates or explicit phasing, submit; another person approves.
6. Import statements, review and classify every line, reconcile each account.

## 10. Not done / needed before operational use

- **Bank connectivity:** CSV import only. `connectors.ts` defines the interface; no provider is
  connected and no credentials are stored.
- **Invoices and receipts:** none exist on `main`. Receipt → order matching records amounts and
  the VAT typed from the invoice; outstanding balances cannot be computed until orders carry
  values. Credit notes reduce the tax reserve only through an approved category transfer.
- **Sales collections (`feature/sales-crm-commissions`):** `SALES_COLLECTION` is a reserved
  match target that is refused on this branch. Field inventory, the five real merge conflicts
  (found by a trial merge), the navigation-registry change and the integration plan with its
  tests are in `SALES_INTEGRATION.md`.
- **Payroll** has no module; payroll obligations are entered (optionally repeating monthly).
- **Accrual view** stays off until operational modules post accounting events.
- **Cost centres** exist as a table and field; there is no cost-centre management screen yet.
- Attachments are stored in the database (5 MB limit), as the sales branch does.

## 11. Figma

File: https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/ERP-Design-System--amp--Order-Operations
— page "15 — Finance · Cash & Budget". Frame links and the parity table are in
`docs/finance/FIGMA_PARITY.md`; captures, side-by-sides and pixel diffs in `docs/finance/parity/`.
