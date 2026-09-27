# Credential incident — exposed `neondb_owner` password (production project)

Status: **OPEN — no credential has been rotated. The rotation below requires the owner's approval.**
Opened 2026-09-27. No secret value appears in this document, in the repository, or in any command
shown here.

## 1. What was exposed

| Item | Value |
|---|---|
| Credential | Password of Postgres role **`neondb_owner`** (database owner; creates/alters/drops objects, owns every table) |
| Neon project | **`dark-lab-61530722`** ("hiqbah") — the production project |
| How | During the accounting migration rehearsal (2026-09-27, shortly after 15:02 UTC) the Neon `get_connection_string` tool was called for rehearsal branch `br-billowing-fire-aq5eyiku`. It returned a full URL including the password, which entered (a) this agent session's transcript and (b) the text of the shell command that wrote a local `.env.rehearsal` file |
| Not exposed | `erp_app` (production runtime role, created 2026-09-27 06:21:45 UTC); `sales_preview_app` / `sales_preview_migrator` (on `br-bold-forest`); the test project `dry-smoke-16360248` owner (see §6) |

### Where copies exist now

| Location | State | Evidence |
|---|---|---|
| Git history of `flow.com` (all local commits including this branch) | **None** | `git grep` for Neon password tokens across all revisions: 0 files. The only URL-with-password matches are fixtures `u:p@…` and `hunter2SUPERSECRET` (synthetic) |
| Workspace files (`flow.com`, `flow-baseline`, `hiqbah_share2`, scratch/tmp) | **None** — `.env.rehearsal` deleted | recursive search for Neon password tokens, match count only: 0 |
| Agent session transcript / tool-result files held by the platform | **Retained; cannot be redacted from inside the session** | The platform keeps the conversation history. Local session files live in this ephemeral container and are reclaimed with it, but copies held server-side are outside my control |
| Figma, screenshots, evidence PNGs | None (synthetic data only) | — |

Redaction is therefore **not possible** for the one place that matters, and even where it is possible it would
not remove the risk. **Rotation is the remedy.**

## 2. Affected branches — the same password is on all ten

Neon copies roles (with their passwords) into a child branch at creation. A password reset applies to
**one branch only**. The role metadata below was read through the Neon API (no secrets). `neondb_owner`
has `updated_at = 2026-05-10T07:43:33Z` on every branch — the password has never been reset anywhere, so
**the exposed password is valid on every branch that has, or is given, a compute endpoint.**

| Branch id | Name (names are not trusted for identity) | Compute endpoint | Role `updated_at` | Notes |
|---|---|---|---|---|
| `br-weathered-bread-aqais7hp` | hiqbah-demo-training-20260529 | `ep-dawn-dust-aqn1u1uf` | 2026-05-10 07:43:33 | **LIVE PRODUCTION** (verified by application-written marker, RELEASE-20260927 §1b) |
| `br-fragrant-poetry-aqd0ndyx` | production (project default, *not* live) | `ep-jolly-feather-aqne6cp1` | same | parent of the live branch |
| `br-bold-forest-aq3z2qjq` | erp-regression-r1 | `ep-wandering-leaf-aqjtuin5` | same | full copy of production data (2026-09-11) |
| `br-billowing-fire-aq5eyiku` | rehearsal-accounting-ledger-core-20260927 | `ep-noisy-night-aq3qczk4` | same | branch the URL was issued for |
| `br-rough-violet-aq9nwnom` | rehearsal-finance-sales-20260927 | `ep-lingering-wave-aqtxp32f` | same | |
| `br-wild-credit-aqn8vqh6` | pre-deploy-backup-20260904 (**archived**) | `ep-proud-block-aq9mtqql` | same | |
| `br-cold-wave-aqrk91we` | rehearsal-migrated-preserved-20260927 | none | same | usable as soon as an endpoint is added |
| `br-fancy-unit-aqxm3hef` | backup-pre-finance-sales-20260927T0617Z | none | same | **designated restore source for production** (RELEASE-20260927 rollback plan) |
| `br-quiet-sky-aqgw77yy` | pre-pkgv2-migration20-20260919 | none | same | |
| `br-crimson-glitter-aq2ncfll` | pre-migration19-20260918 | none | same | |

All ten hold customer-derived data (copies of production at various dates), so each is in scope. A
connection test from here is impossible (the sandbox has no route to port 5432), so validity per branch
is established from metadata, and must be confirmed by connection after rotation (§5).

**Log evidence.** A Neon log query on the live branch for the exposure window, and for the whole last
24 hours, returned no records at all even though the compute was active — logs are not available as
evidence on this plan. Unauthorised use can therefore be neither shown nor ruled out. A read-only
`pg_stat_activity` probe (2026-09-27 16:05 UTC) found only Neon system sessions on a freshly woken
compute, which proves nothing either way.

## 3. Known consumers of the owner credential

| Consumer | Uses the exposed credential? | How established | Action at rotation |
|---|---|---|---|
| Vercel **Production** `DATABASE_URL` | **No, expected** — switched to `erp_app` pooled URL on 2026-09-27 06:22:59 | RELEASE-20260927 §1e (Vercel values are sensitive/unreadable) | none; verify with `classify-db-urls.mjs` (§4 A1) |
| Vercel **Production** `DIRECT_URL` | not present | RELEASE-20260927 (env metadata) | none |
| Vercel **Preview** `DIRECT_URL` (scope: all Preview branches) | **Unknown — prime suspect.** If it points at `ep-dawn-dust` as `neondb_owner`, every preview build carries the production owner credential | metadata only; value unreadable to this session (Vercel access 403) | remove from Preview, or replace with a test-project URL; must not hold a production credential regardless of rotation |
| Vercel **Preview** `DATABASE_URL` scoped to `release/pre-go-live-20260904`, `release/rc-order-operations-20260906`, `…0908` | **Unknown** | same | classify; delete or re-point to test databases |
| Vercel deployment **`dpl_6Aa8nwC1xyyB3nmtrYCffCSKM4Cq`** (the documented rollback candidate) and any production deployment built before 06:22:59 | **Yes** — built with the owner URL baked in (RELEASE-20260927: "keeps the `neondb_owner` credential it was built with") | release doc | **Rotation breaks instant rollback to these deployments.** Choose a rollback candidate built on `erp_app` first |
| `scripts/migrate-deploy.mjs` + `prisma.config.ts` (`DIRECT_URL`) | Yes when an operator runs production migrations; value is supplied from the operator's shell, never from the repo | code | operator uses the new URL; nothing to change in code |
| Owner's local checkout `../ERP/.env` (classified by `scripts/finance/check-env.mjs`, host only) | Possibly | check-env output (host classification) | owner replaces the value |
| `scripts/finance/rehearsal/rehearsal-db.mjs` | writes temporary env files with rehearsal-branch URLs | code | delete any retained rehearsal env files on operator machines |
| `scripts/sales-preview/*` | No — refuses any role other than `sales_preview_migrator` / `_app` | code (`ALLOWED_ROLE`) | none |
| GitHub Actions | No workflows in the repository (`.github/` absent). Repository/organisation secrets not visible to this session | repo | owner checks *Settings → Secrets and variables* once |
| Neon console / Neon MCP / passwordless `psql` | No — account-authenticated, not the role password | Neon | none (note: `passwordless_access` is enabled on all endpoints; account security is the control there) |

**Not rotated: `erp_app`.** It was not exposed, is the production runtime role, and rotating it would
force a production redeploy for no security gain.

## 4. Rotation procedure — for approval

The reset itself is to be performed **by the owner in the Neon console** (or `neonctl` on the owner's
machine). If this agent performed it through the Neon tool, the new password would be returned into the
conversation and the incident would repeat. The agent performs only the metadata checks.

**A. Preconditions (read-only)**
1. `vercel env pull --environment=preview /tmp/p.env` and `--environment=production /tmp/prod.env`
   (plus `--git-branch=<b>` for each branch-scoped set), then
   `node scripts/accounting/classify-db-urls.mjs /tmp/p.env /tmp/prod.env`; delete the files after.
   Record which variables are `EXPOSED OWNER CREDENTIAL` / `PRODUCTION DATABASE IN PREVIEW`.
2. Confirm the current production deployment's `DATABASE_URL` role is `erp_app` (A1 output) and that it
   was built after 2026-09-27 06:22:59 UTC. Pick the rollback candidate from deployments built after
   that time; record that `dpl_6Aa8…` stops being a valid rollback target after step B2.
3. Quiet window agreed (no production migrations in progress).

**B. Rotation (requires approval — production credential change)**
1. Preview first: delete or re-point every Preview variable found in A1 that holds a production-project
   URL. (No production impact; removes the credential from preview builds.)
2. Live branch `br-weathered-bread-aqais7hp` → Roles → `neondb_owner` → *Reset password*. Store the new
   value only in the owner's password manager / local `.env` used for migrations. Do not add it to
   Vercel (production has no `DIRECT_URL`; keep it that way). Runtime traffic uses `erp_app` and is not
   affected; if Neon reconfigures the compute, pooled connections reconnect.
3. The other nine branches, same action each — the reset is per branch. Endpoint-less branches
   (`br-cold-wave`, `br-fancy-unit`, `br-quiet-sky`, `br-crimson-glitter`) accept the reset through the
   API/console without a compute. For the archived `br-wild-credit`, reset if the console allows it
   on an archived branch; otherwise the owner decides between unarchive-then-reset and deletion (deletion
   is not performed by the agent without a separate explicit instruction).
4. Alternative the owner may prefer for stale copies: delete branches that are no longer needed
   (separate decision; copies of production data are a liability in themselves). `br-fancy-unit` stays
   while it is the documented restore source.

**C. Verification**
1. Agent: `list_postgres_roles` on all ten branches — `neondb_owner.updated_at` later than the rotation
   start on every one; `erp_app.updated_at` still 2026-09-27T06:21:45Z (live) / 06:03:15Z (`br-cold-wave`).
2. Owner's machine (needs TCP 5432):
   `OLD_OWNER_URL_FILE=… NEW_OWNER_URL_FILE=… node scripts/accounting/verify-credential-rotation.mjs`
   — every endpoint must refuse the old password with SQLSTATE `28P01`; the new live URL must connect as
   `neondb_owner` to `neondb`. Output contains only endpoint ids, PASS/FAIL and SQLSTATE codes.
3. `npx prisma migrate status` with the new `DIRECT_URL` → reports the expected migration list (proves the
   migration tooling works with the new credential).
4. Production smoke: sign-in and one read on www.beanflow.net; Vercel runtime logs show no database
   authentication errors for 30 minutes.
5. Re-run A1 on the Preview and Production env pulls: zero `EXPOSED OWNER CREDENTIAL` rows.
6. After any future branch **restore** or new branch creation, re-check C1 — restores and new children
   copy role state from their source.

**D. Close-out**: record times and results in §7, update RELEASE-20260927's rollback section, destroy the
old-URL file used in C2.

## 5. What this session will not do

Rotate or reset any credential, delete or unarchive branches, change Vercel variables, or read secret
values. These wait for approval (and Vercel/network access for A1).

## 6. Test project `dry-smoke-16360248`

Its `neondb_owner` (branch `br-withered-art-aw2zp5kr`, updated 2026-09-05) is a different credential and
is not known to be exposed. The accounting Preview will not use it at runtime: a restricted
`accounting_app` role is to be created by the owner in the console (so its password never passes through
this session), after which the agent applies grants by SQL. Precautionary reset of this test-project
owner is recommended before Preview variables are set; it needs no production approval.

## 7. Log

| Time (UTC) | Event |
|---|---|
| 2026-09-27 ~15:0x | exposure (get_connection_string on `br-billowing-fire`) |
| 2026-09-27 (same session, before 16:00) | local `.env.rehearsal` deleted |
| 2026-09-27 16:00–16:10 | scope established (this document); no rotation |
