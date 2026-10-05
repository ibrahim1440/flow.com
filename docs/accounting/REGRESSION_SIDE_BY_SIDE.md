# Backend regression suite: baseline vs feature, side by side

Run date: 2026-09-27 (UTC). Runner: `node scripts/e2e/regression/run-all.mjs` (26 suites).

## Summary

| | Baseline | Feature |
|---|---|---|
| Suites run | 26 | 26 |
| Assertions passed | 2289 | 2290 |
| Assertions failed | 11 | 11 |
| Suites that were not green | harness-selftest, h2a-hardening, reset-safety | harness-selftest, h2a-hardening, reset-safety (the same three) |

- Both runs fail the same 11 assertions, with the same text, in the same suites. No failure is new on the feature branch. The only difference is one extra passing assertion in `completion-gate` on the feature run. That assertion only runs when a race goes one particular way, so it is not a code difference (details below).
- The controlled re-runs explain all 11 failures on both trees. Once the one condition behind each suite was corrected, every one of those suites passed on both trees: harness-selftest 375/0, h2a-hardening 145/0, reset-safety 30/0.
- None of the failures is a product defect. 10 come from the test environment and harness setup. 1 comes from the seed data (it exposes a harness weakness and a seed-data quality issue, not a runtime defect).
- None of the 26 suites exercises the accounting module. This suite is evidence that shared workflows did not regress. It is **not** evidence about accounting correctness.

## Commits and trees

| | Path | HEAD at run time | Notes |
|---|---|---|---|
| Baseline | `/home/user/flow-baseline` | `fc64c05c1ef4e607365e0e0c5d7c32482ed2e26e` (= origin/main) | Working tree clean. `.next/BUILD_ID` 15:00:46 UTC. 29 migrations. |
| Feature | `/home/user/flow.com` (`feature/accounting-ledger-core`) | `fa8fc0ebbac63a9273ec5c201f71e472b3f134c4` | See the caveat below. `.next/BUILD_ID` 14:49:09 UTC. 30 migrations (adds `20260928090000_accounting_ledger_core`). |

**Caveat: the feature tree changed while I was working (someone else, not this session).**
- When this session started, `git rev-parse HEAD` returned `2a05d72…`. Before any run began it had moved to `fa8fc0e…` (commit "accounting: application-runtime verification as a restricted DML-only role").
- `git diff 62cff11 HEAD -- src prisma` is empty, so committed `src/` and `prisma/` are unchanged since `62cff11`, as expected.
- From 16:23 UTC, uncommitted edits also appeared in the working tree. They touch 7 files under `src/app/{api,dashboard}/accounting|finance` plus docs and tests.
- The server under test ran the prebuilt `.next` from 14:49, so these edits did not affect runtime behaviour.
- harness-selftest reads `src/` text statically, so it may have seen the edited files. It passed every source-scan check anyway, and its only failures are the `.env` checks described below.
- None of these modifications came from this session.

## Environment (identical for both runs)

- **Node:** v22.22.2 for both trees. Next 16.2.4 in both `node_modules`.
- **Database:** PostgreSQL 16 at `127.0.0.1:54329`, database `erp_e2e`.
  - Before each run it was dropped and recreated, then `COMMENT ON DATABASE erp_e2e IS 'hiqbah-finance-disposable'` was set.
  - Each tree migrated it with its own `npx prisma migrate deploy` (baseline 29 migrations, feature 30), then seeded it with its own `npx tsx prisma/seed.ts`. `seed.ts` is byte-identical in both trees.
  - The script refuses any URL that is not host `127.0.0.1` port `54329` or that contains `neon`. No hosted database was contacted.
- **Credentials:** `JWT_SECRET` and `PIN_LOOKUP_SECRET` come from `/home/user/flow.com/.env` for both runs. I checked that they equal the values in the baseline tree's own `.env`.
  - Five distinct random six-digit seed PINs were generated per run with `crypto.randomInt`. The pin policy (`src/lib/pin-policy.ts`) only requires `/^[0-9]{6}$/`.
  - The PINs were held only in shell variables. The admin PIN was passed as `ERP_TEST_ADMIN_PIN`.
- **Server:** `node node_modules/next/dist/bin/next start -p 3010`, started from the tree with `nohup env -i` and this exact variable set:
  - `PATH`, `HOME`, `NODE_ENV=production`
  - `DATABASE_URL` and `DIRECT_URL`, both pointing at erp_e2e
  - `JWT_SECRET`, `PIN_LOOKUP_SECRET`
  - `ACC_RUNTIME_DATABASE_URL=` (empty)

  Two points about how Next loads `.env`:
  - Next also loads the tree's own `.env`, but values set in the process environment take precedence. So both servers had identical DB and secrets.
  - The feature `.env` has one key the baseline `.env` lacks, `ACC_RUNTIME_DATABASE_URL`. It is blanked in **both** runs so that neither server gets a variable the other does not. It is also referenced nowhere under `src/`.

  Other details:
  - PID was written to `server-<label>.pid` and the server was stopped with `kill <pid>` from a trap. `pkill` and `killall` were not used.
  - Port 3040 (PID 2355, cwd `flow.com`, DB `erp_finance_dev`) was never touched and was still answering `/api/health` 200 at the end.
- **Suites:** run with `env -i` and these variables: `PATH`, `HOME`, `ERP_TEST_DATABASE_URL` (erp_e2e), `ERP_TEST_BASE_URL=http://127.0.0.1:3010`, `ERP_TEST_ADMIN_PIN`, `PIN_LOOKUP_SECRET`. The default allowlist was used (it contains `erp_e2e`).
- **Server-side errors:** each server log contains exactly the same two expected `[API Error]` lines, both from hostile-input tests:
  - `invalid byte sequence for encoding "UTF8": 0x00`
  - `Unexpected end of JSON input`
- **Leak check:** I grepped every scratchpad log for the JWT secret, the PIN lookup secret and both DB passwords. There were 0 hits.

### Exact commands (secrets redacted)

Script: `scratchpad/run-tree.sh <tree> <label> [--reset-guard] [suite…]`. It does the following:

```bash
set -a; . /home/user/flow.com/.env; set +a                      # inside the script's own process
E2E=postgresql://finance_local:<redacted>@127.0.0.1:54329/erp_e2e
psql postgresql://finance_local:<redacted>@127.0.0.1:54329/postgres \
  -c "DROP DATABASE IF EXISTS erp_e2e" -c "CREATE DATABASE erp_e2e" \
  -c "COMMENT ON DATABASE erp_e2e IS 'hiqbah-finance-disposable'"
cd <tree>
DATABASE_URL=$E2E DIRECT_URL=$E2E npx prisma migrate deploy
DATABASE_URL=$E2E DIRECT_URL=$E2E ERP_SEED_ENABLED=true \
  SEED_PIN_ADMIN=<redacted> SEED_PIN_INVENTORY=<redacted> SEED_PIN_ROASTING=<redacted> \
  SEED_PIN_QC=<redacted> SEED_PIN_DISPATCH=<redacted> npx tsx prisma/seed.ts
nohup env -i PATH=$PATH HOME=$HOME NODE_ENV=production DATABASE_URL=$E2E DIRECT_URL=$E2E \
  JWT_SECRET=<redacted> PIN_LOOKUP_SECRET=<redacted> ACC_RUNTIME_DATABASE_URL= \
  [ERP_TRAINING_RESET_ENABLED=true ERP_RESET_ALLOWED_HOST=127.0.0.1 ERP_RESET_ALLOWED_DATABASE=erp_e2e]  # --reset-guard only
  node node_modules/next/dist/bin/next start -p 3010 > scratchpad/server-<label>.log 2>&1 &
echo $! > scratchpad/server-<label>.pid
env -i PATH=$PATH HOME=$HOME ERP_TEST_DATABASE_URL=$E2E ERP_TEST_BASE_URL=http://127.0.0.1:3010 \
  ERP_TEST_ADMIN_PIN=<redacted> PIN_LOOKUP_SECRET=<redacted> \
  node scripts/e2e/regression/run-all.mjs [suite…] > scratchpad/regression-<label>.log 2>&1
kill $(cat scratchpad/server-<label>.pid)
```

Main runs:

```bash
bash run-tree.sh /home/user/flow-baseline baseline     # -> regression-baseline.log
bash run-tree.sh /home/user/flow.com      feature      # -> regression-feature.log
```

## Per-suite results

| Suite | Baseline passed / failed | Feature passed / failed |
|---|---|---|
| harness-selftest | 373 / **2** | 373 / **2** |
| production-gate | 71 / 0 | 71 / 0 |
| workflow-alignment | 45 / 0 | 45 / 0 |
| production-concurrency | 37 / 0 | 37 / 0 |
| lifecycle-locks | 39 / 0 | 39 / 0 |
| completion-gate | 69 / 0 | 70 / 0 (see note) |
| reservation-cas | 22 / 0 | 22 / 0 |
| packaging-stock | 49 / 0 | 49 / 0 |
| packaging-concurrency | 24 / 0 | 24 / 0 |
| packaging-idempotency | 64 / 0 | 64 / 0 |
| packaging-identity | 73 / 0 | 73 / 0 |
| unified-packaging | 183 / 0 | 183 / 0 |
| legacy-packaging-routes | 53 / 0 | 53 / 0 |
| production-demand | 81 / 0 | 81 / 0 |
| blend-integrity | 105 / 0 | 105 / 0 |
| po-lifecycle | 132 / 0 | 132 / 0 |
| hardening | 117 / 0 | 117 / 0 |
| platform-hardening | 47 / 0 | 47 / 0 |
| h2a-hardening | 144 / **1** | 144 / **1** |
| h2b-hardening | 165 / 0 | 165 / 0 |
| finished-products | 61 / 0 | 61 / 0 |
| delivery | 22 / 0 | 22 / 0 |
| order-edit-integrity | 137 / 0 | 137 / 0 |
| order-to-delivery | 88 / 0 | 88 / 0 |
| release-simulation | 66 / 0 | 66 / 0 |
| reset-safety | 22 / **8** | 22 / **8** |
| **Total** | **2289 / 11** | **2290 / 11** |

**Note on completion-gate.** `completion-gate.mjs:327-329` only runs its "after the race the fully delivered order can still be completed" check when the concurrent complete call loses the race and gets 409:
- Baseline race: `deliver=201 complete=200`, so the check did not run.
- Feature race: `deliver=201 complete=409`, so the check ran and passed.

This is scheduling nondeterminism, not a code difference. I diffed the full list of `[PASS]`/`[FAIL]` names across the two logs, and this line is the only difference.

## Failures

Each failure has two rows: a failure row and an impact row.

- **Failure row:** Baseline and Feature show whether the assertion failed in that run. Identical? says whether the failure text matches across the two runs.
- **Impact row:** Category is (a) environment/harness condition, (b) product defect, or (c) test data. Accounting and shared workflows give the impact on each. Release disposition says whether the failure is acceptable for release.

### harness-selftest

**H-1**

| Assertion | Baseline | Feature | Identical? |
|---|---|---|---|
| "a wholly unconfigured environment exits non-zero" (`status=0`) | FAIL | FAIL | yes |

Root cause:
- `harness-selftest.mjs:1231` runs `scripts/validate-env.ts` with `cwd: REPO` and an env holding only PATH (`runValidator({})`).
- `validate-env.ts` starts with `import "dotenv/config"`, which loads `REPO/.env`.
- Both trees contain a local `.env` (baseline `-rw------- 587 B`, feature `707 B`) that defines `DATABASE_URL` and `PIN_LOOKUP_SECRET`. So the "unconfigured" environment is in fact configured, and the validator exits 0.

| Category | Accounting impact | Shared-workflow impact | Release disposition |
|---|---|---|---|
| (a) environment | None | None. The build validator itself behaves correctly: the weak-secret and valid-environment cases pass. | Acceptable. This is an artefact of a developer checkout; CI or a clean clone has no `.env`. The re-run proves it: 375/0 on both trees. |

**H-2**

| Assertion | Baseline | Feature | Identical? |
|---|---|---|---|
| "and reports BOTH variables, not just the first" (validator printed "required server configuration is present") | FAIL | FAIL | yes |

Root cause: the same as H-1. Because `.env` supplied both variables, the validator printed its success line instead of naming the missing variables.

| Category | Accounting impact | Shared-workflow impact | Release disposition |
|---|---|---|---|
| (a) environment | None | None | Acceptable (same as H-1). |

### h2a-hardening

**A-1**

| Assertion | Baseline | Feature | Identical? |
|---|---|---|---|
| "and no roast lost its provenance during this suite" (`44 batches`) | FAIL | FAIL | yes, 44 in both |

Root cause, part 1: the query at `h2a-hardening.mjs:280-282` does not match what the assertion claims to check.
- It counts **every** `RoastingBatch` in the database with `greenBeanId IS NULL AND NOT isBlend AND createdAt > now() - 20 min`. It is not scoped to this suite's fixtures.
- The seed (`prisma/seed.ts:276, 300`) creates 44 historical roasting batches with `greenBeanId: findBean(item.bean) || null`.
- `findBean` compares the item's bean name with `beanMap` keys. The item names are Arabic ("كولمبيا ويلا", "اثيوبي قوجي", …) and the keys are English `beanType` values ("Colombia Huila", "Ethiopia Guji", …). They never match, so all 44 seeded batches get a null bean (11+1+1+6+4+4+1+15+1 = 44).
- The DB is seeded moments before the run, so the seed rows are always inside the 20-minute window.

Root cause, part 2: evidence that the suite's own roasts are unaffected.
- During the baseline run all 44 null-bean batches had `createdAt` equal to the seed time (16:25:07) and batch numbers `B-2025…`.
- The suite's own race check A4 ("the roast that won keeps its provenance") passes, and dangling purchases and movements are 0.

| Category | Accounting impact | Shared-workflow impact | Release disposition |
|---|---|---|---|
| (c) test data. There is also a harness weakness: the check is time-windowed, not fixture-scoped. | None | No runtime defect: the delete/roast race guard works (A4 passes). Seed data quality issue: the demo/training seed gives 44 historical roasts no green-bean provenance, which will show in inventory and traceability views of any seeded demo DB. | Acceptable for release: no code path is broken and it is identical on baseline. Recommended follow-up (not blocking): scope the check to the suite's own prefix, and fix `findBean` (map Arabic names or add `nameAr`). The re-run proves it: 145/0 on both trees. |

### reset-safety

The eight failures below share one root cause. The server was started without the documented destructive-reset authorization, so `evaluateResetAuthorization` (`src/lib/reset-safety.ts`, identical in both trees) returned `ERP_TRAINING_RESET_ENABLED is not set to exactly "true"`. That covers:
- `ERP_TRAINING_RESET_ENABLED=true`
- `ERP_RESET_ALLOWED_HOST` (must include `127.0.0.1`)
- `ERP_RESET_ALLOWED_DATABASE` (must include `erp_e2e`)

`reset-safety.mjs` section C calls these routes "AN AUTHORIZED RESET OF A DISPOSABLE DATABASE", so the suite presupposes that authorization. The runner README does not list these variables; they are documented in `src/lib/reset-safety.ts`.

Check order in `src/app/api/admin/reset/route.ts:32-34`:
1. Authentication and privilege
2. The environment guard (returns 403)
3. The phrase check (returns 400)
4. The PIN check (returns 401)

R-1 through R-8 all follow from the guard returning 403. The guard behaved exactly as designed (deny-by-default). C0, "a user without settings.reset is refused … discloses nothing", passes in both runs.

Every reset-safety failure has the same impact:

| Category | Accounting impact | Shared-workflow impact | Release disposition |
|---|---|---|---|
| (a) environment: missing reset-authorization env on the server under test | None | Database reset tooling: no defect. The guard refuses correctly and nothing was deleted, which is why R-2 to R-5 show rows remaining. | Acceptable. The re-run proves it: 30/0 on both trees. A production deployment **must not** set these variables, so the refusal is the desired production behaviour. |

| # | Assertion | Baseline | Feature | Identical? |
|---|---|---|---|---|
| R-1 | "the authorized training reset is accepted" (`status=403 … not an authorized destructive-reset target`) | FAIL | FAIL | yes |
| R-2 | "packaging operations are gone" | FAIL (102 rows) | FAIL (103 rows) | same assertion; row counts differ by 1 |
| R-3 | "roasting batches are gone" | FAIL (231 rows) | FAIL (231 rows) | yes |
| R-4 | "finished stock is gone" | FAIL (105 rows) | FAIL (106 rows) | same assertion; row counts differ by 1 |
| R-5 | "the whole operational dataset is gone" | FAIL (InventoryMovement 645, …) | FAIL (InventoryMovement 649, …) | same assertion; counts differ slightly |
| R-6 | "the authorized factory reset is accepted" (`status=403`) | FAIL | FAIL | yes |
| R-7 | "a wrong confirmation phrase is still refused" (`status=403`, expected 400) | FAIL | FAIL | yes |
| R-8 | "a wrong PIN is still refused" (`status=403`, expected 401/429) | FAIL | FAIL | yes |

Why each fails:
- **R-1:** the guard returned 403, as described above.
- **R-2 to R-5:** these follow from R-1. The reset was refused, so the rows the earlier suites accumulated are still there. The one-row differences are leftover fixture data that depends on race outcomes (for example the completion-gate race described earlier). They are not a behaviour difference.
- **R-6:** the same guard refusal as R-1, on `/api/admin/reset`.
- **R-7 and R-8:** the environment guard runs **before** the phrase and PIN checks, so an unauthorized database answers 403 before those checks are reached. This is intended layering: a refusal must change nothing, including rate-limit rows.

## Controlled re-runs (condition corrected, both trees)

Each re-run used a fresh `erp_e2e` (drop, create, comment, migrate, seed), the same server and suite env as the main runs, and a single suite. The "before" rows are the same single suite without the correction.

| Suite | Condition | Before: baseline | Before: feature | Correction | After: baseline | After: feature |
|---|---|---|---|---|---|---|
| harness-selftest | Local `.env` in REPO is loaded by `validate-env.ts` (dotenv, cwd = REPO) | 373 / 2 (in-tree, `env -i`) | 373 / 2 | Ran the suite from an env-free copy of each tree: `scratchpad/noenv-<tree>`, made with `tar` excluding `.env`, `.env.test`, `.env.local`, `.git`, `.next`, `node_modules`, with `node_modules` symlinked. No file in either repo was moved or deleted. | **375 / 0** | **375 / 0** |
| h2a-hardening | 44 seed roasts with null `greenBeanId` fall inside the suite's 20-minute window | 144 / 1 ("44 batches"). Script logged "seeded roasts with null greenBeanId inside the 20-minute window: 44" **before** any suite ran. | 144 / 1 ("44 batches"), same pre-run count of 44 | After seeding, `UPDATE "RoastingBatch" SET "createdAt" = "createdAt" - interval '1 day' WHERE "greenBeanId" IS NULL AND NOT "isBlend"`. This simulates the seed being older than the window. The in-window count became 0. No code change. | **145 / 0** (nulled provenance=0) | **145 / 0** (nulled provenance=0) |
| reset-safety | Server lacks the reset-authorization env | 22 / 8 (training-reset 403, reset 403) | 22 / 8 | Server started with `ERP_TRAINING_RESET_ENABLED=true ERP_RESET_ALLOWED_HOST=127.0.0.1 ERP_RESET_ALLOWED_DATABASE=erp_e2e` (identical for both trees) | **30 / 0** (training-reset 200, reset 200, wrong phrase 400, wrong PIN 401/429) | **30 / 0** |

Commands:

```bash
# harness-selftest (pure; no DB/server)
cd /home/user/<tree>                && env -i PATH=$PATH HOME=$HOME node scripts/e2e/regression/harness-selftest.mjs   # before
cd scratchpad/noenv-<baseline|feature> && env -i PATH=$PATH HOME=$HOME node scripts/e2e/regression/harness-selftest.mjs   # after
# h2a-hardening
bash run-tree.sh <tree> ctl-h2a-before-<t> h2a-hardening
AGE_SEED=1 bash run-tree.sh <tree> ctl-h2a-after-<t> h2a-hardening
# reset-safety
bash run-tree.sh <tree> ctl-reset-before-<t> reset-safety
bash run-tree.sh <tree> ctl-reset-after-<t> --reset-guard reset-safety
```

The feature schema adds accounting triggers and FKs. Under an authorized reset on the feature tree, both the training reset and the factory reset still returned 200 and emptied all 17 operational tables. The reset path is therefore not broken by the new accounting migration.

## Impact classification

### (i) Accounting module
- None of the 11 failures involves accounting code, tables or routes.
- More important for review: **this runner has no accounting coverage at all.** None of the 26 suites calls an `/api/accounting/*` route or asserts on `Account`, `JournalEntry`, `FiscalPeriod` or `AccountingEvent`.
- A green result here says nothing about ledger correctness. That evidence has to come from the accounting unit, DB and runtime tests (`test:accounting:*`).

### (ii) Shared workflows
Orders, production, inventory, delivery, PIN auth and reset tooling:
- **Orders, production, inventory, delivery and PIN auth:** 23 suites green on both trees with identical assertion sets. This is evidence of no regression from the accounting branch.
- **Reset tooling:** it behaves correctly both refused (unauthorized) and allowed (authorized), on both trees.
- **Seed data:** there is a pre-existing seed-data quality issue. The demo seed leaves 44 historical roasts with no green-bean provenance. It is not a runtime defect.
- **Not covered:** the feature migration adds triggers on the sales-module tables `CommissionPlanVersion` (approval guard) and `CommissionLedgerEntry` (accounting outbox). The Sales CRM suites are a separate runner (`run-sales.mjs`) against `sales_crm_preview`, and they were **not** part of this comparison. Commission workflows therefore have no regression evidence from this run.

### (iii) Release readiness
- The feature branch introduces **zero** new failures in this runner.
- All 11 failures are explained and reproduce identically on origin/main. When their conditions are corrected, each suite passes on both trees.
- By category, none is a product defect:
  - 10 are environment/harness conditions: harness-selftest ×2 and reset-safety ×8.
  - 1 is a test-data artefact: h2a-hardening ×1.
- They are acceptable for release **because the corrected re-runs pass**, not merely because they are pre-existing.
- Caveats that still stand:
  1. A certification run should be done from a clean checkout (no `.env`), with the reset-authorization variables set only on the disposable test server, so the harness reports green without manual interpretation.
  2. The h2a provenance check and the seed `findBean` mapping should be fixed so this check stops failing permanently.
  3. This runner is not accounting evidence. Accounting and commission-trigger changes need their own suites (accounting tests and `npm run regression:sales`) before release.

## Artefacts (scratchpad)

All paths are relative to `/tmp/claude-0/-home-user-hiqbah-share2/3f8b64a2-dce4-5086-91b8-8b48fa7b736b/scratchpad/`.

- **Main runs:** `regression-baseline.log`, `regression-feature.log`, `driver-*.log`, `server-*.log`, `seed-*.log`
- **Controlled runs:** `regression-ctl-{h2a,reset}-{before,after}-{baseline,feature}.log`, `driver-controlled.log`, `selftest-intree-*.log`, `selftest-noenv-*.log`
- **Script:** `run-tree.sh`
- **Env-free copies:** `noenv-baseline/`, `noenv-feature/`

## Cleanup
- Every server this session started on :3010 was stopped by PID; nothing is listening on 3010. The :3040 server (PID 2355) was untouched and still healthy.
- No tracked file in either repository was modified by this session and nothing was committed. The uncommitted changes in `/home/user/flow.com` came from someone else, as described in the caveat above.
- `erp_e2e` **existed before this session** (no comment, 30 migrations, 5 employees, not in use by any connection). It was not created by this task, so it was not dropped. It now holds the state left by the last controlled run (after an authorized reset: operational tables empty; employees, including the suite's RSF_ operators, and the comment `hiqbah-finance-disposable` remain). Drop it manually if it is not wanted.

## Reproducible certification (clean checkout), 2026-09-27

`scripts/e2e/regression/local-certification.mjs <sha>` runs the whole backend suite against a
disposable local database, from a clean `git worktree` of the given commit. It fixes the
conditions of the 11 former baseline failures without loosening any check:

| Suite | Condition | How it is set up |
|---|---|---|
| `harness-selftest` (2) | expects an unconfigured environment | the worktree has no `.env`; the script refuses to run if one exists |
| `reset-safety` (8) | needs the reset boundary on the test server | `ERP_TRAINING_RESET_ENABLED`, `ERP_RESET_ALLOWED_HOST=127.0.0.1` and `ERP_RESET_ALLOWED_DATABASE=erp_e2e` are set on that server only. The guard code is untouched, and the script refuses a non-local `DATABASE_URL` |
| `h2a-hardening` (1) | a global provenance invariant (no roast without a green bean) | fixed at the source: `prisma/seed.ts` maps each seeded bean name to its green bean (`BEAN_ALIASES`) and throws on an unknown name. The global assertion is unchanged, and the seeded database has 0 roasts without a bean |

The script also:
- generates the secrets for the run fresh (JWT, PIN lookup, seed PINs) and never prints them;
- runs `prisma generate` and `migrate deploy`, then the seed, the build and the server, all from
  the worktree.

Results:
- at `284e207`: 26 suites, 2,301 assertions, 0 failed;
- at `cf3b43e`: 26 suites, 2,300 assertions, 0 failed
  (`evidence/test-runs/cf3b43e-certification.log`).

The one-assertion difference is the race-dependent branch in `completion-gate`
(`TEST_RESULTS.md`).
