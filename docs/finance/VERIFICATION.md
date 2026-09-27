# Finance — verification record and review handoff (2026-09-26)

Branch `feature/finance-cash-budget` (worktree `C:\Projects\ERP-finance-cash-budget`), base
`origin/main` `4640cbe`. Local commits only — **not pushed, not merged, not deployed**.
Every database operation below ran against the portable PostgreSQL on `127.0.0.1:54329`
(ENVIRONMENT.md); no Neon endpoint was contacted.

## 00. Release candidate `release/finance-sales-20260927` (2026-09-27)

`57b99db` = UAT `4ec5baf` + Sales `c8b37dd` (merge, no conflicts) on `origin/main` `4640cbe`.
Production steps were not executed (RELEASE-20260927.md §6).

| Check | Result |
|---|---|
| Typecheck; lint (finance, nav, Sales services, tests); build | clean; clean; compiles |
| Finance unit | 52/52 |
| Finance DB (incl. 5 Sales-collection tests) | 40/40, 0 skipped |
| Application server connected **as `finance_app`** (DML only) on a disposable database: HTTP authz/identity/decisions | 11/11 |
| same server: integrated navigation (4 roles); decision checks D2–D6 | 4/4; pass |
| same server: 11-step walkthrough (Sales collection → allocation once → budget → approvals → reservation → pending line → record payment → statement confirms → actuals) | 11/11; balances identical to the UAT candidate |
| Local migration rehearsal (8 migrations) on a fresh database built by the production commit's own migrations + seed + synthetic volume | 43 existing tables identical; no existing table altered; empty drift; 12/12 triggers; `finance_app` refused all 10 privileged writes; **production build's client reads all 43 models on the migrated schema**; recovery from the server-side copy identical to the baseline |
| Clean-checkout backend regression (no `.env`, disposable DB) vs `origin/main` | the same 26 failing assertions as `main` — none new, none fixed (below) |
| Clean-checkout Playwright (critical-path, permissions, responsive, ui-resilience) | 32 passed, 2 failed, 15 did not run (serial suites stop at the first failure) — the same two failures as the Sales baseline |

**Correction.** An earlier version of this section called the failures below "identical on
`main`, i.e. in production today". A matching failure on the baseline proves only that the
release did not introduce it; it does not prove the deployed workflow is affected. Each one was
therefore investigated on an isolated database through the real API (§00a).

### 00a. The 17 core-operation assertions — root causes and disposition

Reproduced on the disposable `erp_e2e` (127.0.0.1:54329) through the HTTP API with a real admin
session. **No product defect was found**; all three causes are in the tests. Fixes are on
`fix/core-ops-regression-ordering` (from `main` `4640cbe`: `57fdc67`, `d58098d`, `41c5e4e`),
merged into the release as `9295a10`/`5c4577d`/`1521a05`; no assertion was removed or loosened.

| # | Assertions | Root cause | Evidence | Disposition |
|---|---|---|---|---|
| 1 | `production-concurrency` A1×3, B1×2, C1×4, C3×4 (13) | The race was ordered by a 350 ms head start, which only holds with remote-database latency. Locally the requirement/roast committed *before* the hold/cancel — a legitimate serialization in which acceptance is correct | Forced ordering: a separate session holds the route's own advisory lock (7762, line key) so the request parks mid-transaction; the hold/cancel commits via `/api/orders/[id]/status`; the lock is released. Result: parked = 1, hold/cancel 200, requirement/roast **409**, green stock 120 → 120, 0 movements, no batch, no production order. Reverse order: accepted, as designed | Test fixed to force the ordering and to assert it happened ("parked mid-transaction when the hold/cancel was sent"). 37/37 |
| 2 | `lifecycle-locks` D1/D2 (3) | Delivery used the SKU's oldest available lot, which the fixture had fully reserved for *another* order (20/20 reserved); the server's refusal "reserved for another order" is correct | `StockAllocation`: the order's own reservation was on a different lot | Test now delivers from the lot reserved for the line and asserts that reservation exists. 37/38 — the remaining failure is G1's wall-clock "work overlapped" check (timing; passes 2 of 3 runs; not one of the 17), left unchanged |
| 3 | `workflow-alignment` A4 (1) | Looked up the committing employee by username `admin`, which the seed does not create | The recorded owner is the seeded administrator who committed | Test identifies the session's employee by its PIN selector. 45/45 |

Each fixed suite failed on the unfixed tests (13, 3, 1 failures) and passes after.

**Playwright — why 15 did not run.** Both files are `serial`; a failure stops the rest of its
group. The two failures were test faults: "Dispatch ships the order in full" matched a hidden
element with `.first()` although the form showed "Max: 24 units" (screenshot); "sees only the
modules they hold" looked for labels in a sidebar whose groups are collapsed until opened and
which the client re-closes at hydration, and — with Sales — admin and CRM roles reach some pages
through a subunit's contextual bar. Fixed in `d58098d`/`41c5e4e` (main-valid) and `87b6e47`
(release: compares against everything navigation offers). Final results: §00b.

- `reset-safety` (9): the disposable test database is not configured as an authorized reset
  target, so the guarded training/factory reset refuses — environment, not product. Production
  never runs it.

### 00b. Clean-checkout run of the release head `87b6e47`

Fresh worktree (no `.env`), `npm ci`, fresh `erp_e2e`, migrate, seed, build, server on :3050.

| Suite | Result |
|---|---|
| Backend regression (26 suites, 2,289 assertions) | 10 failed, was 26: `reset-safety` 9 (environment, above) and `lifecycle-locks` G1 1 (wall-clock overlap check, "together 101 ms vs single 45 ms"; timing, not one of the 17). All 17 core-operation assertions pass |
| Playwright critical-path, permissions, responsive, ui-resilience | **49 passed, 0 failed, 0 did not run** (was 32/2/15). No exclusions |

**Mutation check of the fixed concurrency test.** On a scratch copy of `4640cbe`, the late
barrier `assertOrderStillAcceptsProduction` was removed from both routes, the app rebuilt and
the fixed `production-concurrency` run on a fresh database: **5 failures** — A1/B1 return 201 and
leave a production order for a held/cancelled order. The test therefore detects the defect it
names. C1/C3 (roast) still refuse with 409 without the barrier, because the roasting ceiling is
re-read inside the same advisory lock and a held/cancelled order has no remaining demand; that
is a second, independent refusal, not a gap. Restored afterwards (no changes left).

### 00b′. The two remaining regression items, resolved (release `c5c778c`)

**`lifecycle-locks` G1** measured wall-clock overlap of two reviews that draw on the same stock
lot (where serializing is legitimate) against a biased baseline (a re-review). It now proves the
property with locks: a separate session holds order M's `Order` and `OrderItem` rows; a review of
order N must complete meanwhile, and a review of M must be seen waiting on a lock (`8c56814`).
Result: 39/39 in 3 of 3 runs. Negative control — the session also locks the shared lots, i.e. a
global serialization: the unrelated review times out and G1 fails. No product defect.

**`reset-safety`** was re-run with the server configured as an authorized reset target
(`ERP_TRAINING_RESET_ENABLED=true`, `ERP_RESET_ALLOWED_HOST=127.0.0.1`,
`ERP_RESET_ALLOWED_DATABASE=erp_e2e`). That exposed a test fault hidden behind the environment
refusal: C0 "a user without settings.reset is refused" asked the seeded administrator, whose stored
permissions are `{}` and resolve to the admin role defaults (`getUserWithPermissions`, since
`df884d0`), which include `settings.reset` — so C0 performed a real factory reset of the disposable
database and C1 found nothing to delete. C0 now uses an admin with the privilege explicitly false
(`1ac674d`). Results: authorized target **30/30**; unauthorized target 8 failures, every one the
environment refusal ("not an authorized destructive-reset target", 403) or its consequence.
Production has none of the three variables, so the factory/training reset is refused there by the
environment gate regardless of privilege.

Design note (not changed here): an administrator stored with empty permissions inherits every
sub-privilege, including factory reset. Production is protected by the environment gate; whether
reset should be excluded from the admin defaults is an owner decision.

### 00b″. Sales through `822f30c` (release `4102c39`) — checks affected by the merge

`822f30c` adds migration `20260927100000_protect_movement_provenance` (three foreign keys on
`CommissionLedgerEntry` become `ON DELETE RESTRICT`) and makes the page behind the mobile
drawer `inert`. Only the checks those changes can affect were re-run:

| Check | Result |
|---|---|
| Typecheck; lint (changed files); build | clean; clean; compiles |
| Finance unit; Finance DB (incl. Sales-collection links, which truncate the commission tables) | 52/52; 40/40 |
| Sales shell suite (`playwright.shell.local.config.ts`, `erp_shell_local` + one synthetic collection), incl. three new drawer keyboard tests | 38/38 |
| Clean checkout: operational regression (26 suites, 2,293 assertions) | 8 failed — all `reset-safety` environment refusals (§00b′); every core-operation suite passes |
| Clean checkout: Playwright (critical-path, permissions, responsive, ui-resilience) | 49/0/0 |
| Local rehearsal of the 9 migrations | ran to completion (exit 0); results not yet recorded |

Not re-run: the DB-backed Sales suites (`npm run regression:sales`) — they are locked to the Sales
preview database (`ep-wandering-leaf` / `sales_preview`, role `sales_preview_app`); the Sales
branch reports 1,062 assertions in 13 suites green at `822f30c`.

### 00c. The production application on the migrated database, as the restricted role

`4640cbe` (fresh worktree, own `npm ci`, own build) served on a database built by its own
migrations + seed and then migrated by the release (28 migrations = 20 + 8); the server
connected as `finance_app` (DML only; `pg_stat_activity` showed `finance_app` sessions).

| Check | Result |
|---|---|
| `main`'s own backend regression (26 suites, 2,270 assertions) | 26 failed — **the identical failure set** of `main` on its own unmigrated database (the 17 test faults above, fixed only on the release branch, + `reset-safety` 9) |
| `main`'s own Playwright (same four files; `erp_e2e` copy of the migrated database, the suite accepts only that name) | 44 passed, 1 failed, 1 did not run — identical to `main` on its own database (the dispatch test fault, fixed in `d58098d`) |
| Server log | 0 "permission denied" / "must be owner" |
| Privileged writes as `finance_app` after the runs | 10/10 refused: TRUNCATE, DISABLE TRIGGER, DROP TRIGGER, `session_replication_role`, DDL, DROP TABLE, self-decision, forged pre-approved request, audit-row DELETE, audit-row UPDATE; an ordinary read works |

So the currently deployed application keeps working, reads and writes, on the migrated schema
under the restricted role — the precondition for migrating before the merge and for the
instant rollback to `dpl_6Aa8nwC1xyyB3nmtrYCffCSKM4Cq`.

Not tested: production data and volume, Neon branch copy, point-in-time restore, the
`ui-ux-alignment` branch, the Sales shell suite on this commit (35/35 at `995b3bf`).

## 0. Local UAT candidate (2026-09-26) — `uat/finance-sales-20260926`

Started from `9351e74710343259767e460f3f5cf6629e30c266`; adds the resolved decisions D2–D6,
the Sales-collection link in the review panel, fixture additions, rehearsal tooling and a local
Sales shell config (UAT.md). Outside Finance files, this pass changed only test tooling
(`playwright.shell.local.config.ts`, `tests/shell/local-*.ts`). Run on the final commit, with
the server built from it on http://localhost:3080 against `erp_finance_integration_dev`:

| # | Check | Result |
|---|---|---|
| U1 | `npx tsc --noEmit`; `eslint` (finance, `src/lib/nav`, tests, scripts/finance); `npm run build` | clean; clean; compiles |
| U2 | Finance unit (`tsx --test tests/finance/unit/*.test.ts`) | **52/52** (36 + 16 new: D4a completeness, D3b profit names) |
| U3 | Finance DB (`erp_finance_integration`) | **40/40, 0 skipped** (33 + 6 decision tests + 1 collection-suggestion test) |
| U4 | HTTP (authz, first grant, approver identity, decisions) | **11/11** |
| U5 | Integrated navigation (Finance entry in the Sales registry, 4 roles) | **4/4** |
| U6 | Decision checks on the running build (`uat-decisions-ui.mjs`), screenshots in `decisions/uat/` | D2, D3a/D3b, D4a, D5, D6 **pass** |
| U7 | Walkthrough automated (`workflow-ui.mjs`): approved Sales collection → receipt → allocation once → budget → approval → payment request → override → pending line → record payment → statement confirms → actuals | **11/11 steps**; balances per step in UAT.md |
| U8 | Sales shell navigation suite, **unchanged spec**, on an isolated local database `erp_shell_local` (3 disposable `NAV_` logins + 1 synthetic collection created through the Sales services) | **35/35** |
| U9 | Migration rehearsal on a fresh local database (MIGRATION_REHEARSAL.md §0) | preserved, no drift, 12/12 triggers, runtime role refused every privileged write, recovery from the copy identical to the baseline |

Earlier evidence kept for areas this pass did not change: the clean-checkout backend
regression and Playwright `permissions` / `responsive` / `ui-resilience` / `critical-path` at
`9351e74` (26 baseline-identical regression failures, 32 passed / 2 baseline Playwright
failures, no new failure) — not re-run, because this pass changed no non-Finance application
code.

**U8, precisely.** The suite reads no pre-existing record except one kind: the Finance user's
collections screen must list at least one collection (the first local run, with none, failed
exactly that assertion: 34/35). One synthetic collection makes the local database represent
the preview faithfully for what the suite asserts. Remaining gap: the preview database's
*real* records (volume, and any data shapes only production-derived data has) are not
exercised; the spec, its assertions and the preview guard are unchanged
(`git diff 9351e74 -- tests/shell/navigation.spec.ts playwright.shell.config.ts scripts/sales-preview/` is empty).

## 1. Commands and results (closure pass)

Prerequisite: `npm run db:local` (portable PostgreSQL running). Suites that log in read the
fixture password from the gitignored `.env`, e.g.
`FIN_PASSWORD="$(sed -n 's/^FIN_FIXTURE_PASSWORD=//p' .env | tr -d '"')"` — never typed or printed.

| # | Command | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | clean |
| 2 | `npx eslint src/app/dashboard/finance src/lib/finance tests/finance --quiet` | clean |
| 3 | `npm run build` (no migrations run by the build) | compiles |
| 4 | `npm run test:finance:unit` | **36/36** (pure finance 19, DB guard 4, sales-collection rule 8, exactly-once rules 5) |
| 5 | `npm run test:finance:db` (`erp_finance_test`) | **28 pass, 0 fail, 5 skipped** — the 5 are the sales-collection specifications (§7) |
| 6 | `npx next start -p 3040`; `npm run finance:fixture -- --reset` | fixture server |
| 7 | `BASE_URL=http://localhost:3040 FIN_PASSWORD=… npm run test:finance:http` | **7/7** (incl. approver identity from the session) |
| 8 | `BASE_URL=http://localhost:3040 FIN_PASSWORD=… npm run test:finance:ui` | **10/10** workflow steps |
| 9 | `capture.mjs` / `states.mjs` / `decision-crops.mjs` | 13 screens, 13 states/breakpoints, 16 decision crops |
| 10 | `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` (`.env.test`) | empty |
| 11 | Repository backend regression, **clean checkout** of `90b64ae` (no `.env`; configuration from the process environment; disposable `erp_e2e`) vs clean `origin/main` (`erp_mvp_test`) | §4: identical to baseline; `harness-selftest` **375/375** |
| 12 | Playwright `permissions`, `responsive`, `ui-resilience`, `critical-path` — same clean checkouts | this branch **44 passed, 1 failed**; `origin/main` **44 passed, 1 failed** — the same test (§4) |
| 13 | Same Playwright suites on the trial integration branch (sales + finance) vs the sales head `aa9ef8c` alone | trial **32 passed, 2 failed**; sales alone **32 passed, 2 failed** — the same two: the dispatch test above and `permissions` "UAT Sales sees only the modules they hold" (the sales registry moved Orders; pre-existing on the sales branch) |
| 14 | Trial integration branch: finance unit / DB | 36/36; **33/33, 0 skipped** |

Mutation checks: disabling the request↔line tracing in `ledger.ts` makes the first D1 test fail
("available falls once"); restoring it passes. The earlier eligible-cash mutation check (first
pass) still applies to the lifecycle test.

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

**D1 exactly-once** (`tests/finance/integration/exactly-once.test.ts`, closure pass) traces one
6,000.00 payment against a 5,000.00 category through: request held for override (not a
commitment) → approved (available −1,000) → transfer entered as a pending line before linking →
"Record payment made" → the bank feed shows it pending (attached) → the statement shows it
settled (SETTLES) → the same statement again: **available stays 4,000.00 from approval on**, one
bank line, one PAYMENT entry. Also: bank feed before recording; release before paying; a failed
transfer (line voided: the request reopens, nothing is freed until it is released); a rejected
override; an unmatched pending card purchase (awaiting review until confirmed, then −450 once);
races (one line cannot pay two requests; one request is paid once; four allocations of more than
half the room → one). Cash, eligible, reserved, allocated and available at every step:
`evidence/d1-balances.md`.

The same path runs in the real UI (`workflow-ui.mjs` steps 7–10) with screenshots in
`evidence/workflow/`.

## 3. Controls: database vs service layer, and the trust boundary

**Enforced by PostgreSQL**, tested by connecting as the application role `finance_app`
(`lifecycle.test.ts`, "database controls under the application role"):

| Control | Mechanism | Evidence |
|---|---|---|
| Allocation ledger, runs, finance audit log append-only | `BEFORE UPDATE OR DELETE` triggers | UPDATE/DELETE refused |
| Bank lines voided, never deleted | trigger | DELETE refused |
| Approved budget revisions and their lines immutable | triggers | UPDATE/revert refused |
| **No self-approval, no exception** | `FinApprovalRequest_guard`; the `allowSelfApproval` column and its helper were **dropped** (migration `20260926140000`); no setting or session variable is consulted | re-enabling (column gone), re-adding the column, replacing the guard function, dropping or disabling the trigger, `SET session_replication_role = replica`: all refused; a raw-SQL self-decision refused |
| Requests are born pending | same trigger on INSERT | a forged, already-APPROVED request refused |
| Approval-gated states only through an approved four-eyes request | `PaymentReservation_override_approval`, `BudgetRevision_four_eyes`, `AllocationRuleVersion_four_eyes`, `AllocationEntry_transfer_approval`, `FinBudget_reopen_approval` | releasing a held payment, approving a revision (even naming another decider) and inserting a transfer entry directly: all refused |
| Nothing changes when a bypass fails | — | an md5 snapshot of 9 tables (requests, revisions, budgets, reservations, allocation entries, rule versions, audit log, bank lines, settings) is identical before and after all the attempts |
| Named approver ≠ requester | service (`createApproval`) | "cannot be the approver of your own request" |
| Signs, net = gross − fee, … | CHECK constraints | acceptance tests |
| One run per receipt, one live match per line/document, one active rule version, one completed reconciliation per account/date | (partial) unique indexes | acceptance tests |
| App role privileges | DML only; no TRUNCATE/TRIGGER/REFERENCES; owns nothing | TRUNCATE → permission denied; DISABLE TRIGGER / DROP TRIGGER / CREATE OR REPLACE FUNCTION → must be owner |

**Enforced only in the service layer** (every route goes through `financeHandler`; tested over
HTTP): which duty may prepare, approve, allocate, reconcile, close, manage settings; branch scope
(404 outside); routing to the named approver; spending limits and available balances;
validation; statement matching; idempotency keys; the pool advisory lock.

**Who decides — the identity boundary in three tiers.**

| Tier | Who | What stops self-approval | Evidence |
|---|---|---|---|
| 1. Ordinary application users | anyone using the web app or its API with their own login | The decider is the employee in the **signed `token` cookie**, verified on the server; permissions and active state are re-read from the database on every request. No request body field, query parameter or header is used as an identity. The service refuses a decision by the requester; so does the database. | `tests/finance/http/approver-identity.test.mjs`: a user holding both preparing and approving duties submits a budget, then tries to approve it while claiming another approver's id in body fields (`decidedBy`, `actorId`, `userId`, `approverId`, `employeeId`, …), query parameters and identity-style headers (`x-user-id`, `x-forwarded-user`, …) → **403** each time; tampered, malformed and unsigned cookies → **401**; the request stays PENDING with no decider. The real approver then approves while the body names the requester — the recorded `decidedBy` is the approver (from the session). |
| 2. The backend and its database credential | the deployed application code and anyone holding the `finance_app` (application) credential | The database refuses a decision whose recorded decider equals the recorded requester, forged pre-approved requests, and approval-gated states without an approved request. It **does not authenticate the human**: it trusts the ids the backend writes. Code or a person with this credential could write another employee's id as the decider. Mitigations: the credential is a server secret; the finance audit log is append-only for this role, so such a write leaves a permanent record naming the impersonated person. | `lifecycle.test.ts` "no self-approval bypass" (as `finance_app`) |
| 3. Privileged database administrators | the table owner / superuser (`finance_local` here; `neondb_owner` by default on Neon) | Nothing in these controls: they can disable or replace triggers and rewrite or truncate any table. Only organisational controls apply (separate non-owner runtime role, owner credential restricted to named administrators, provider audit trail, point-in-time restore). | not testable here; see ENVIRONMENT.md §6 |

**Trust boundary — what the database does not and cannot protect against:**

1. **The application's word about who is acting.** The database compares the ids it is given
   (`requestedBy`, `decidedBy`, `approvedBy`); it cannot authenticate a human. Code, or anyone
   holding the `finance_app` credential, could record a different employee as the decider.
   What stops that: authentication in the application; the credential kept out of reach of
   users; and the append-only audit log, which records every decision with its actor and cannot
   be edited by the application role. Forging therefore leaves a permanent record naming the
   impersonated person.
2. **Privileged database administrators.** A table owner or superuser — locally
   `finance_local`; on Neon, by default, `neondb_owner` — can disable or drop the triggers,
   replace the guard functions, rewrite rows and truncate the audit log. These controls do not
   constrain them and are not meant to. Production requirements: run the application as a
   separate non-owner role (like `finance_app`); keep the owner credential only for migrations,
   held by named administrators; rely on Neon's point-in-time restore and the provider's
   project audit trail for owner actions. None of this can be verified from here; the live
   database was not connected to (ENVIRONMENT.md §1).
3. **Migrations** run as the owner. A malicious migration could remove every control, so
   migrations need the same review as code.

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

**Existing suites, clean checkouts.** The regression harness is designed to run from a
checkout without a developer `.env`, taking everything from the process environment (its
self-test runs the shipped validator from the repository root with a scrubbed environment).
Two detached, disposable worktrees were therefore used — this branch at `90b64ae` and
`origin/main` at `4640cbe` — each with its own disposable database (`erp_e2e`,
`erp_mvp_test`), migrated and seeded with random PINs held only in session scratch files, built
and served with environment-only configuration. The working `.env` and the tests were not changed.

| | This branch `90b64ae` | `origin/main` `4640cbe` | Classification |
|---|---|---|---|
| `harness-selftest` | 375/375 | 375/375 | resolved (earlier failure was the worktree's `.env`) |
| 21 other suites incl. `hardening`, `platform-hardening`, `h2a-hardening`, `h2b-hardening` (auth, sessions, PINs, authorization) | pass | pass | — |
| `workflow-alignment`, `production-concurrency`, `reset-safety` | fail | fail — identical assertions | **baseline** (pre-existing; `reset-safety` needs training-reset configuration) |
| `lifecycle-locks` | 3 fail (+1 flaky) | 3 fail | **baseline**; the extra "concurrent work overlapped rather than serializing" is a timing heuristic — rerun three times on this branch: pass, fail (37 vs 15 ms), pass; it also failed on `origin/main` in the first baseline |
| Playwright `permissions`, `responsive`, `ui-resilience`, `critical-path` | 44 passed, 1 failed | 44 passed, 1 failed | **baseline**: the same test fails on both — `critical-path` "Dispatch ships the order in full and it completes" (the delivery form's unit label is hidden) |

No regression introduced by Finance was found. The sales branch's own shell navigation suite
(`test:shell`) was **not** run: its guard binds it to the `sales_preview` database on Neon
endpoint `ep-wandering-leaf-aqjtuin5`, a production-derived branch this work does not connect to.

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
2. *Preparer* → Monthly budget → month selector → **+ New budget…** (next month, empty) → **Edit lines** → add Rent
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
   Save and mark reviewed. Cash allocation → the company pool card now says one outgoing line
   matches an approved request not yet recorded (counted once) — **unallocated is the same as
   after step 5**: the payment is not subtracted twice.
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

## 6. Closure table

| # | Issue | Fix or decision | Evidence | Status |
|---|---|---|---|---|
| 1 | The application role could enable self-approval (`FinSettings.allowSelfApproval`) | Exception removed: column and helper dropped; guards consult no setting or session variable; requests born pending; approval-gated states (held payment, rule activation, revision approval, category transfer, period reopen) require an APPROVED request decided by someone else; named approver ≠ requester (`20260926140000_finance_strict_four_eyes`, `d954c78`) | `lifecycle.test.ts` "no self-approval bypass" as `finance_app`: every bypass refused; 9-table snapshot unchanged; legitimate approval still works | **Closed** at the database boundary for the application role. Residual trust (§3): the recorded actor id, privileged DB administrators, migrations |
| 2 | D1 — commitments before settlement, exactly once | Implemented (`exactly-once.ts`, `ledger.ts`, import `SETTLES`, request↔line tracing, awaiting-review class) | `exactly-once.test.ts` (5 scenarios incl. races) with per-step balances in `evidence/d1-balances.md`; unit tests; mutation check | **Closed** |
| 3a | Straightforward visual discrepancies | App aligned to Figma: typography (line height), FIN-03 branch tables and title, FIN-04 toolbar and variance card, FIN-08 empty state and duplicate-reference warning, dialog labels | FIGMA_PARITY.md §1, §3 (FIN-01 geometry within 1–4 px), parity side-by-sides | **Closed** |
| 3b | Genuine design/usability choices | One sheet with crops, effect, recommendation and what each changes. D4b: Figma corrected to the permission policy (preparer not given `period_close`). D7: native controls, the ERP convention. | DECISIONS.md | D4b, D7 **closed**; D2, D3a, D3b, D4a, D5, D6 **open — needs your decision**; FIN-02/03/04/05/06 stay "Differs" |
| 4 | Which database serves www.beanflow.net | Read-only evidence: Vercel `flow-com` production deployment `dpl_6Aa8nwC1xyyB3nmtrYCffCSKM4Cq` (main `4640cbe`) → Neon `dark-lab-61530722` / branch `br-weathered-bread-aqais7hp` / endpoint **`ep-dawn-dust-aqn1u1uf`** — from independent Neon/Vercel metadata, corroborated by one `/api/health` GET; the deployed connection string itself is a sensitive variable and was not read | ENVIRONMENT.md §1 | **Identified (indirect evidence); protected as production**. Direct confirmation needs the owner. Owner action: `CLAUDE.md` (not modified) labels it "demo" and names a non-existent production endpoint; the main checkout's `.env` points at production. Guards unchanged |
| 5a | Approved sales/navigation integration commit | None exists (no PR, no remote integration branch; `ui-ux-alignment` unpushed and moving) | SALES_INTEGRATION.md §4 | **Blocked — dependency on an approval** |
| 5b | Five sales-collection tests | Implemented and passing on the disposable local branch `trial/finance-sales-integration-20260926` (merge `71b3043` of sales `aa9ef8c` + finance `4bb76bb`; head `04419a7`); specs complete and skipped on this branch; patches in `docs/finance/integration/` | trial: finance DB 33/33, 0 skipped; SALES_INTEGRATION.md §5 | **Verified on the trial branch only** |
| 5c | `aeb384a` | Ordinary commit on `feature/finance-cash-budget`, parent `597dd9c`; documents a trial merge; not a merge commit; no trial branch existed then | `git log`, SALES_INTEGRATION.md §6 | **Answered** |
| 6a | `harness-selftest` failure | Run in the intended isolated configuration: clean checkout, no `.env`, environment-only configuration | 375/375 on this branch and on `origin/main` | **Closed** |
| 6b | Existing Playwright + regression suites | Clean checkouts of this branch and `origin/main`, disposable databases | §4: identical to baseline; one baseline Playwright failure, one flaky timing assertion | **Closed** — no Finance regression found, on this branch or on the integration; `test:shell` not runnable (preview database on Neon) |

**Commits on `feature/finance-cash-budget` (local, not pushed):** `597dd9c` checkpoint → `aeb384a` →
`d954c78` four-eyes + D1 → `4bb76bb` environment evidence → `6991fb8` sales specs and patches →
`90b64ae` visual alignment → closure documentation commit.

## 7. Verified locally vs ready for live integration

**Verified locally** (disposable databases, production builds, Chrome emulation): everything in
§1–§6 marked Closed; the sales-collection behaviour on the trial branch.

**Not ready for live integration.** Remaining blockers:

1. **Decisions D2–D7** (DECISIONS.md) — material UI differences stay unresolved until you accept
   or reject each recommendation.
2. **Approved integration commit** for sales/navigation — then apply the patches there, remove
   the five skips, and run the suites (incl. `test:shell` in its own environment).
3. **Production database roles** — confirm the application connects to `ep-dawn-dust` as a
   non-owner role and that the owner credential is restricted (§3); cannot be verified from here.
4. **Migration rehearsal** (procedure: MIGRATION_REHEARSAL.md) on a Neon branch copy of `ep-dawn-dust`'s branch, with a backup, by
   someone authorised to touch it.
5. Known functional gaps unchanged: CSV import only (no bank connector); receipts matched to
   orders without invoice values; no payroll module; accrual view off; English server error
   detail; no cost-centre screen; `/dashboard/finance` not selectable as a default route.
