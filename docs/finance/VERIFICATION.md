# Finance — verification record and review handoff (2026-09-26)

Branch `feature/finance-cash-budget` (worktree `C:\Projects\ERP-finance-cash-budget`), base
`origin/main` `4640cbe`. Local checkpoint commit only — **not pushed, not merged, not deployed**.
Every database operation below ran against the portable PostgreSQL on `127.0.0.1:54329`
(ENVIRONMENT.md); no Neon endpoint was contacted.

## 1. Commands and results

Prerequisite: `npm run db:local` (portable PostgreSQL running). Suites that log in read the
fixture password from the gitignored `.env`, e.g.
`FIN_PASSWORD="$(sed -n 's/^FIN_FIXTURE_PASSWORD=//p' .env | tr -d '"')"` — never typed or printed.

| # | Command | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | clean |
| 2 | `npx eslint src/app/dashboard/finance src/lib/finance tests/finance --quiet` | clean |
| 3 | `npm run build` (no migrations run by the build) | compiles |
| 4 | `npm run test:finance:unit` | **31/31** pass (pure finance 19, DB guard 4, sales-collection rule 8) |
| 5 | `npm run test:finance:db` (erp_finance_test, `--test-concurrency=1`) | **21 pass, 0 fail, 5 skipped** (the 5 are the planned sales-collection tests) |
| 6 | `npx next start -p 3040` then `npm run finance:fixture -- --reset` | server up on the fixture |
| 7 | `BASE_URL=http://localhost:3040 FIN_PASSWORD=… npm run test:finance:http` | **6/6** pass (reset fixture first) |
| 8 | `BASE_URL=http://localhost:3040 FIN_PASSWORD=… npm run test:finance:ui` | **10/10** workflow steps pass (reset fixture first) |
| 9 | `FIN_PASSWORD=… node tests/finance/visual/capture.mjs <dir>` / `states.mjs <dir>` | 13 screens, 12 states/breakpoints captured |
| 10 | `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` (with `.env.test`) | empty — migrated DB and schema agree |
| 11 | Repository regression suites, `npm run regression` (see §4) | 21/26 suites pass; the 5 that fail also fail on unmodified `origin/main` or for an environmental reason |

Mutation check: with the eligible-cash fix (§2) reverted, the lifecycle test fails; restored,
it passes.

## 2. Financial lifecycle (area 3) — what the tests prove

`tests/finance/integration/lifecycle.test.ts`:

1. A receipt recorded on arrival as PENDING does not change eligible cash; confirming it does.
2. Reviewed and classified, it is allocated by the approved rule (50 % to a category).
3. A payment request above the category limit is held and routed to the category's named
   approver, who approves it.
4. The transfer is made outside the app and recorded as a PENDING outgoing line; "Record
   payment made" pays the reservation from it. **Unallocated cash is exactly what it was before
   the payment** (the fix: pending outflows are deducted from eligible cash).
5. The bank statement containing both lines is imported: preview reports 2 "confirms a recorded
   line", 0 new; commit inserts **0 lines** and confirms both existing ones.
6. Book cash moves once per line; the budget actual for the payment category is 4,000.00 once
   and for the receipt category 8,000.00 once; the obligation is settled once; exactly one
   `PAYMENT` allocation entry exists.
7. Re-importing the same statement changes nothing.
8. Ambiguity: two identical pending −250.00 lines → the statement row is FLAGGED; the reviewer
   merges it into one of them; book cash still shows one −250.00; re-import inserts nothing.
9. Opening balances: overview monthly receipts 0 and budget receipts actual 0 despite a 10,000
   opening balance; allocating 6,000 then 5,000 from it is refused ("Only 4000.00 SAR of the
   opening balance …");
   four concurrent 4,000 allocations → exactly one succeeds; category total = opening balance.

The same path runs in the real UI (`workflow-ui.mjs` steps 7–10) with screenshots in
`evidence/workflow/`.

## 3. Controls: database vs service layer

**Enforced by PostgreSQL** — tested by connecting as the application role `finance_app`
(`lifecycle.test.ts`, "database controls under the application role"):

| Control | Mechanism | Evidence |
|---|---|---|
| Allocation ledger, allocation runs, finance audit log are append-only | `BEFORE UPDATE OR DELETE` triggers | UPDATE/DELETE on `AllocationEntry`, DELETE on `FinAuditLog` refused |
| Bank lines are voided, never deleted | trigger | DELETE on `BankTransaction` refused |
| Approved budget revisions and their lines are immutable | triggers | UPDATE of an approved `BudgetLine`, revert of an approved `BudgetRevision` refused |
| Approval requests: no delete, decided requests frozen, decision needs a decider ≠ requester, request fields cannot be rewritten | `FinApprovalRequest_guard` | self-decision via raw SQL refused; delete refused; editing a decided request refused |
| Budget revision approved only by someone other than its submitter | `BudgetRevision_four_eyes` | raw-SQL self-approval refused |
| Allocation rule version activated only by someone other than its author | `AllocationRuleVersion_four_eyes` | (same mechanism; service tests cover the path) |
| Amount signs, net = gross − fee, etc. | CHECK constraints | acceptance tests |
| One allocation run per receipt, one live match per line/document, one active rule version per scope, one completed reconciliation per account/date | unique / partial unique indexes | acceptance tests |
| App role cannot TRUNCATE, cannot disable triggers, is not superuser/owner | role privileges | `TRUNCATE` → permission denied; `ALTER TABLE … DISABLE TRIGGER` → must be owner |

Limits of the database controls, stated plainly:

- A table **owner or superuser bypasses all of this** (can disable triggers). Production must
  run the application as a non-owner role (ENVIRONMENT.md §6). This is not yet the case on
  the shared Neon databases as far as this work could tell (not inspected — not connected).
- The database checks the **recorded** decider id; it cannot know which human is connected. It
  stops bugs and accidental self-approval, not a malicious SQL session that writes another
  user's id.
- `FinSettings.allowSelfApproval` is writable by `finance_app`. The service audits changes and
  requires `settings_manage`, but a raw SQL session could turn it on. Production follow-up:
  column privilege or a trigger that requires an approval to change it.

**Enforced only in the service layer** (every API route goes through `financeHandler` →
module + sub-privilege check; tested over HTTP in `tests/finance/http/`):
who may prepare, approve, allocate, reconcile, close periods, manage settings; branch scope
(out-of-scope records → 404); routing of overrides to the named approver; spending limits and
available-balance checks; amount/phasing/date validation; statement-matching rules; idempotency
keys; the pool advisory lock (a PostgreSQL feature, invoked by the service).

## 4. Shared code and existing consumers (area 4)

Tracked files changed outside the finance folders — the complete list:

| File | Change | Consumers checked |
|---|---|---|
| `src/lib/auth-shared.ts` | `"finance"` appended to `ALL_MODULES`; label; 10 sub-privileges | `buildDefaultPermissions("admin")` iterates `ALL_MODULES`, so a **new** admin default includes Finance; stored admin permissions are not changed (verified: a pre-Finance admin record gets 403 on Finance). Other role defaults list modules explicitly → no Finance. Login `resolveRoute` iterates `ALL_MODULES` — Finance is last, so only a Finance-only user lands on `/dashboard/finance`. Employees editor renders the module and its 10 keys from the same constants. `scripts/permission-backfill.ts` / `permission-impact-report.ts` keep their own inline copies and therefore **do not** grant Finance (intended). `tests/e2e/support/roles.ts` gives the e2e admin Finance; other e2e roles none. |
| `src/app/dashboard/layout.tsx` | one NAV item, gated by `hasModuleAccess(…, "finance")` | no-permission capture: no Finance entry for `no.finance` |
| `src/lib/i18n/translations.ts` | one key | — |
| `prisma/schema.prisma` | one appended block; no relation fields added to existing models | `migrate diff` empty |
| `package.json` | scripts only; **no dependency changes** | — |
| `.gitignore` | `/.local-postgres/` | — |

`src/lib/finance/money.ts` and `dates.ts` are **new** finance-only modules; the repository's
existing money/date helpers are untouched and no file outside the finance folders imports
anything from `src/lib/finance` (grep). Their unit tests cover halala conversion, rounding
(largest remainder), Riyadh date boundaries (21:00 UTC = next day) and month boundaries.

**Existing regression suites** (`npm run regression`, 26 suites, 2,267 assertions) were run
against a production build of this branch on a separate disposable database `erp_e2e`, then
against a production build of unmodified `origin/main` on a freshly seeded copy of the same
database (baseline, detached scratch worktree, removed afterwards):

| Suite | This branch | `origin/main` baseline | Cause |
|---|---|---|---|
| 21 suites (incl. `hardening`, `platform-hardening`, `h2a-hardening`, `h2b-hardening` — authentication, sessions, PIN credentials, authorization) | pass | pass | — |
| `workflow-alignment`, `production-concurrency`, `lifecycle-locks`, `reset-safety` | fail (27 assertions) | **fail, identical assertions** | pre-existing / environment (`reset-safety` needs training-reset configuration) |
| `harness-selftest` | 2 assertions fail | pass | environmental: its "wholly unconfigured environment" case runs `scripts/validate-env.ts`, which loads `.env` from the checkout (`dotenv/config`); this worktree has a local `.env`, the baseline checkout had none |

The Playwright UI suites under `tests/e2e/` were not run (they need the full seeded UI
environment); `tests/e2e/permissions.spec.ts` builds roles from the same constants.

**First grant without a circular dependency** (`tests/finance/http/admin-grant.test.mjs`):
an administrator whose stored permissions predate Finance gets 403 on Finance; through the
Employees API only (`employees.edit`) grants a preparer (`txn_enter`, `budget_prepare`,
`allocate`, `all_branches`) and an approver (`budget_approve`, `spend_override_approve`,
`transfer_approve`, `all_branches`); both work on their next request without logging in again;
the preparer creates, fills and submits a budget and cannot approve it (403); the approver
cannot prepare (403) and approves it; the administrator still has no Finance; revocation is
immediate. Branch-limited access (instead of `all_branches`) needs someone with
`settings_manage`, which the administrator can grant — including to themselves — the same way.

## 5. Manual acceptance walkthrough (two separate accounts)

Local only: `npm run db:local`, `npm run build`, `npx next start -p 3040`,
`npm run finance:fixture -- --reset`; open `http://localhost:3040/login`. Accounts (password =
`FIN_FIXTURE_PASSWORD` in the worktree `.env`): **preparer `fin.manager`**, **approver
`fin.approver`** — use two browser profiles (or one private window) so both stay signed in.

1. *Preparer* → Finance → Transactions: open **INCOMING TRANSFER 88213**. Note "not allocated
   before review". Classification "Other operating receipt", budget line "مقبوضات تشغيلية أخرى",
   **Save and mark reviewed** → **Allocate by approved rules**. Expect the allocation summary
   and a remaining unallocated amount.
2. *Preparer* → Monthly budget → **New budget** (next month, empty) → **Edit lines** → add Rent
   12,000.00 due on the 1st → **Save draft** → **Submit for approval**. Try to approve it from
   Approvals: the preparer cannot see it as decidable.
3. *Approver* → Approvals → open the budget → **Approve**.
4. *Preparer* → Cash allocation → **Payment request** → category "Green coffee purchases",
   obligation "Colombia Huila" (31,200.00). Expect the warning that it exceeds available and
   the limit and will be sent to the approver → **Send for approval**.
5. *Approver* → Approvals → the payment → note → **Approve**.
6. *Preparer* makes the transfer **in online banking (outside the app)**, then Transactions →
   **Manual entry**: account SNB-CUR, −31,200.00, status **Pending**, bank reference
   `TRF-AC771`, description → Save; open it, classify as supplier payment / green coffee →
   Save and mark reviewed.
7. *Preparer* → Cash allocation → the open request → **تسجيل الدفع المنفّذ / Record payment
   made**. Read the dialog text: the app sends no money. Choose the pending −31,200.00 line →
   **Record**. The request leaves the open list; the category is reduced; unallocated cash is
   unchanged from before step 6.
8. *Preparer* → Transactions → **Import CSV** → SNB-CUR, file with one row
   `<today>,-31200.00,TRF-AC771,OUTWARD TRANSFER` → map Date/Amount/Reference/Description →
   **Preview**: "Confirms a recorded line: 1", "New: 0" → **Import 1 line**: "imported 0 ·
   confirmed 1". The list still has one −31,200.00 line, now confirmed, with "confirmed by the
   bank statement".
9. *Preparer* → Monthly budget (current month): green-coffee payments actual = 57,700.00
   (26,500 + 31,200), not 88,900.00.
10. *Either* → Reports & settings → Audit log: the budget, approvals, reservation, payment and
    `statement_confirmed` events with users and times.

## 6. Verified locally vs ready for live integration

**Verified locally (this machine, disposable databases, production build):** everything in
§1–§5; Figma parity as recorded in FIGMA_PARITY.md (with the differences and decisions listed
there); guards refusing non-disposable targets.

**Not ready for live integration until:**

1. The owner resolves the Neon endpoint classification (ENVIRONMENT.md §1) and names the target.
2. The sales branch is merged first and this branch is rebased/merged on top, resolving the
   five conflicts and the navigation registry (SALES_INTEGRATION.md), then the planned
   sales-collection tests are implemented and pass.
3. Migrations are rehearsed on a Neon **branch copy** of the target, with a backup, and the
   application connects as a non-owner role (ENVIRONMENT.md §6); `allowSelfApproval` protected.
4. Product decisions D1–D7 (FIGMA_PARITY.md §4) are taken; D1 (pending outflows reduce
   eligible cash) is a business rule.
5. The Playwright UI suites and a manual pass run on the integrated branch.
6. Known gaps accepted or scheduled: CSV only (no bank connector); receipts matched to orders
   without invoice values; no payroll module; accrual view off; server error messages in English;
   no cost-centre screen; `/dashboard/finance` not selectable as an employee's default route
   (same as Accounting).
