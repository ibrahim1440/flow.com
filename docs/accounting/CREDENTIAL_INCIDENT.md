# Credential incident: exposed `neondb_owner` password (production project)

Status: **OPEN. No credential has been rotated.** The owner has approved *preparing* rotation and
recovery (2026-09-27). That is **not** authorisation to change a production credential. No secret
value appears in this document, the repository, or any command shown here.

Every statement below is labelled **FACT** (observed directly, with how) or **HYPOTHESIS** (inferred,
with what would confirm it). Until a hypothesis is resolved, the affected item is treated as exposed.

## 1. The exposure

| # | Statement | Label | Basis |
|---|---|---|---|
| E1 | The password of role `neondb_owner` in Neon project `dark-lab-61530722` ("hiqbah") was returned in clear by the Neon `get_connection_string` tool, for branch `br-billowing-fire-aq5eyiku` (endpoint `ep-noisy-night-aq3qczk4`), on 2026-09-27 shortly after 15:02 UTC | FACT | the tool output in this agent session |
| E2 | The same URL appeared in the text of a shell command that wrote a local `.env.rehearsal` file (since deleted) | FACT | this session's command history |
| E3 | The password was valid for `br-billowing-fire` at that moment | FACT | Neon issued it for that branch |
| E4 | No copy exists in `flow.com` git history (every revision) or in workspace files | FACT | pattern search reporting counts only: 0 |
| E5 | Copies remain in this session's transcript and tool-result files. The platform retains them, and they cannot be redacted from inside the session | FACT | — |
| E6 | Nobody is known to have used the password | HYPOTHESIS; cannot be tested | Neon log queries returned no records at all for the live branch, even when active, so logs are unavailable as evidence either way |

Redaction is not possible where it matters (E5), and would not be a substitute anyway.
**Rotation is the remedy.**

## 2. Which branches are affected

| # | Statement | Label | Basis / what resolves it |
|---|---|---|---|
| B1 | Roles are branch-scoped. A child branch receives a copy of the parent's roles when it is created, and a password reset affects one branch only | FACT (vendor documentation) | Neon docs, *Manage roles*: "roles in the parent branch are duplicated in the child branch"; "Resets are branch-scoped, so reset the role on each branch where it is used" |
| B2 | All 10 branches of `dark-lab-61530722` carry `neondb_owner` with `created_at 2026-05-10T07:43:27Z` and `updated_at 2026-05-10T07:43:33Z` | FACT | Neon API role metadata, read per branch (no secrets) |
| B3 | Every branch has the **same password** as E1 | **HYPOTHESIS**, likely | B1 + B2 are consistent with it, but an unchanged `updated_at` does not prove the password is identical (for example, SQL `ALTER ROLE … PASSWORD` may not update that metadata). Resolved only by an authentication test per endpoint (§6), which needs TCP 5432 |
| B4 | The four branches without a compute endpoint (`br-cold-wave`, `br-fancy-unit`, `br-quiet-sky`, `br-crimson-glitter`) cannot be logged into today, but would accept the password as soon as an endpoint is added or they are restored into another branch | HYPOTHESIS from B1 | Treat as exposed. `br-fancy-unit` is the documented restore source for production, so a restore from it must be followed by a re-check (§6, V5) |

**Treated as exposed until resolved:** all 10 branches (table in §8).

## 3. Consumers of the credential

| Consumer | Kind | Label | How established (no secret read) |
|---|---|---|---|
| `scripts/migrate-deploy.mjs`, via `DIRECT_URL` (and `prisma.config.ts` `directUrl`) | migration | FACT (code path) | code: production migrations use `DIRECT_URL`, which the operator supplies from their shell |
| The operator who ran the 2026-09-27 production migration and created `erp_app` | migration / operational | FACT (documented) | `docs/finance/RELEASE-20260927.md` §1e: "value from stdin" as the owner |
| Your local checkout `../ERP/.env` | operational | **HYPOTHESIS** | `scripts/finance/check-env.mjs` reads that file's `DATABASE_URL` host. Whether it holds the owner credential is unknown (the tool prints the host class only) |
| Vercel Preview `DIRECT_URL` (all Preview branches) | deployment | **HYPOTHESIS: suspected, not confirmed** | RELEASE-20260927 lists that the variable *exists* (metadata). Its value is sensitive and unread; which database or role it points to is unknown |
| Vercel Preview `DATABASE_URL` for three named release branches | deployment | **HYPOTHESIS** | same |
| Vercel Production `DATABASE_URL` | deployment | FACT (documented): **not** the owner. It points to `erp_app` since 2026-09-27 06:22:59 UTC | RELEASE-20260927 §1e; to be re-confirmed with `classify-db-urls.mjs` (§5, P2) |
| Rollback deployment `dpl_6Aa8nwC1xyyB3nmtrYCffCSKM4Cq`, and any production deployment built before 06:22:59 UTC | deployment | **HYPOTHESIS, likely** | Not inspected (no Vercel access; the value would be sensitive). Basis: (a) RELEASE-20260927 states this deployment "keeps the `neondb_owner` credential it was built with", written by the operator who switched the variable; (b) Vercel applies environment-variable changes only to deployments built afterwards. Confirmation: in Vercel, check that deployment's build time against the variable's last-updated time (metadata only) |
| `scripts/finance/rehearsal/rehearsal-db.mjs` | operational | FACT (code path) | writes temporary env files carrying rehearsal-branch URLs; leftovers may exist on operator machines |
| `scripts/sales-preview/*` | — | FACT: **not** a consumer | refuses any role but `sales_preview_migrator` / `sales_preview_app` |
| GitHub Actions | — | FACT: none in the repository (`.github/` absent). Organisation or repository secrets: unknown | check *Settings → Secrets* |
| Neon console / Neon MCP / passwordless `psql` | — | FACT: not password-based | account-authenticated |

## 4. `erp_app` and active sessions

- **`erp_app` is not rotated.** The role exists on the live branch and its copies, but its password
  was not part of E1/E2 (only the owner URL was returned), and the running production application
  uses it. Rotating it would force a
  redeploy for no security gain.
- **A reset does not end sessions that are already open** (Neon: "The old password stops working on
  the next connection"; PostgreSQL checks passwords only at login). Any `neondb_owner` session opened
  before the reset keeps working until it disconnects.
- `neondb_owner` is a member of `neon_superuser`, and `pg_signal_backend` does not let one
  `neon_superuser` member terminate another's sessions. So lingering owner sessions cannot be killed
  from SQL as the owner.
- **Handling (part of the approved window):**
  1. List `neondb_owner` sessions (`pg_stat_activity`, read only) just before the reset.
  2. After resetting, if any remain that are not the operator's own, **restart the compute endpoint**
     of that branch. That closes every connection, including `erp_app`'s pooled ones for a few
     seconds. The application reconnects on its next request, and `erp_app`'s password is
     unchanged, so nothing needs redeploying.
  3. Schedule this in a quiet window and announce a possible brief error on in-flight requests.

## 5. Recovery path that does not depend on the old credential (prepare and verify first)

| Step | Purpose | Verified by |
|---|---|---|
| P1 | **Account-based access works:** you can sign in to the Neon console (with MFA) and open the SQL Editor on `br-weathered-bread-aqais7hp` as `neondb_owner` *without a password*. The console, API and passwordless `psql` authenticate with your Neon account, not the role password | you run `select current_user, current_setting('neon.endpoint_id', true);` in the SQL Editor → `neondb_owner`, `ep-dawn-dust-aqn1u1uf` |
| P2 | **Consumers known before the change:** `vercel env pull` (Preview and Production, per branch) into temporary files, then `node scripts/accounting/classify-db-urls.mjs <files>`. It prints role, endpoint and verdict, never values. Delete the files afterwards | output table saved with the incident record |
| P3 | **Rollback candidate that does not use the owner credential:** pick a production deployment built after 06:22:59 UTC and record it. Do not rely on `dpl_6Aa8` after rotation | Vercel deployment list (metadata) |
| P4 | **Data recovery is independent of credentials:** `br-fancy-unit-aqxm3hef` (backup before finance/sales) remains, and restore works through the console or API | exists (Neon metadata). No new branch is created without your approval (cost) |
| P5 | **Break-glass:** if the console is unavailable during the window, the Neon API with an API key (created beforehand, stored in your password manager) can reset the password again or create a new role. Test the key with a read-only call (`GET /projects/dark-lab-61530722`) | HTTP 200 on the read-only call |

## 6. Rotation and verification procedure (for approval; not yet authorised)

1. **R1 — Preview first (no production impact).** Remove or re-point every Preview variable that P2
   shows holds a `dark-lab-61530722` credential.
2. **R2 — Live branch** `br-weathered-bread-aqais7hp`: Console → Roles → `neondb_owner` →
   *Reset password*. Only you see the new value, and it goes straight into your password manager.
   Then apply §4 handling. Do not add it to Vercel (production has no `DIRECT_URL`; keep it that way).
3. **R3 — The other 9 branches**, one reset each (per branch, B1), including the endpoint-less ones.
   For the archived `br-wild-credit`, reset if the console allows it on an archived branch; otherwise
   you choose between unarchiving and resetting, or deleting it (deletion needs its own explicit
   instruction).
4. **R4 — Update migration consumers:** your local `.env` / shell profile used for `DIRECT_URL`.
   Delete any rehearsal temp env files.

**Verification:**

- **V1 (metadata):** `neondb_owner.updated_at` on all 10 branches is later than the reset start;
  `erp_app.updated_at` is unchanged (live 2026-09-27T06:21:45Z; `br-cold-wave` 06:03:15Z).
- **V2 (authentication, where TCP 5432 exists):**
  ```
  OLD_OWNER_URL_FILE=… NEW_OWNER_URL_FILE=… node scripts/accounting/verify-credential-rotation.mjs
  ```
  - Credentials are read only from files. Command-line or plain-environment URLs are refused.
  - **PASS** requires the intended endpoint to be reachable (TCP connect) **and** the old password
    to be rejected with SQLSTATE `28P01`. A timeout, DNS or network failure, TLS error or any other
    error is **INCONCLUSIVE**, never success.
  - The new credential must connect, and the server must report `neon.endpoint_id =
    ep-dawn-dust-aqn1u1uf`, user `neondb_owner` and database `neondb`.
  - Output shows only endpoint ids, verdicts and SQLSTATE classes.
  - Tested locally: `tests/accounting/scripts/rotation-verifier.test.mjs`.
- **V3:** `npx prisma migrate status` with the new `DIRECT_URL` lists the expected migrations.
- **V4:** production smoke (sign-in, one read); no database authentication errors in Vercel runtime
  logs for 30 minutes; `pg_stat_activity` shows `erp_app` sessions only, plus the operator's own.
- **V5:** re-run V1 after any branch restore or new branch creation.

## 7. Test project `dry-smoke-16360248`

Its `neondb_owner` is a different credential, and the work log has no record of it being exposed.
A precautionary reset is recommended before Preview variables are set; it needs no production
approval. The Preview runtime will use a restricted `accounting_app` role that you create in the
console, so its password never passes through this session. Grants come from
`scripts/accounting/runtime-grants.sql`.

## 8. Branch register (treat as exposed until V1 and V2 pass)

| Branch id | Endpoint | Role `updated_at` | Notes |
|---|---|---|---|
| `br-weathered-bread-aqais7hp` | `ep-dawn-dust-aqn1u1uf` | 2026-05-10 07:43:33 | live production (RELEASE-20260927 §1b; to be re-confirmed from Vercel config when access exists) |
| `br-fragrant-poetry-aqd0ndyx` | `ep-jolly-feather-aqne6cp1` | same | project default, named "production", not live |
| `br-bold-forest-aq3z2qjq` | `ep-wandering-leaf-aqjtuin5` | same | production-data copy |
| `br-billowing-fire-aq5eyiku` | `ep-noisy-night-aq3qczk4` | same | E1 source — **no longer listed by the Neon API on 2026-10-01** (deleted) |
| `br-rough-violet-aq9nwnom` | `ep-lingering-wave-aqtxp32f` | same | |
| `br-wild-credit-aqn8vqh6` | `ep-proud-block-aq9mtqql` | same | archived |
| `br-cold-wave-aqrk91we` | — | same | |
| `br-fancy-unit-aqxm3hef` | — | same | restore source |
| `br-quiet-sky-aqgw77yy` | — | same | |
| `br-crimson-glitter-aq2ncfll` | — | same | |
| `br-delicate-pond-aqs3rb3h` | `ep-rapid-rain-aq9ft4ev` | same (read 2026-10-01) | **new since the register was made**: `backup-pre-payout-integrity-20260929`, created 2026-09-29 from the live branch; carries `neondb_owner` and `erp_app`; treat as exposed; added to the preview deny list |

## 10. Inventory refresh (2026-10-01, Neon metadata only, no secret read)

- **Production `neondb_owner` not rotated:** the live branch `br-weathered-bread-aqais7hp` still has
  `neondb_owner` with `updated_at` 2026-05-10T07:43:33Z. Nothing indicates a rotation.
- **`erp_app` unchanged:** created 2026-09-27T06:21:45Z, not updated since.
- **One branch gone, one new:** `br-billowing-fire-aq5eyiku` (E1 source) is gone, and
  `br-delicate-pond-aqs3rb3h` is new (§8).
- **Endpoints:** every compute endpoint of the project reports `passwordless_access: true`, which is
  account-authenticated `psql` (not a password).
- **GitHub:** this session can push to `ibrahim1440/flow.com` through the Claude GitHub App (git
  proxy). No repository secrets were read; `.github/` is still absent from the branch.
- **Vercel:** the connector lists projects, but project-scoped calls (environment-variable metadata)
  return 403 for scope `ibrahimmutambak-4927s-projects`. So the Vercel consumers in §3 remain
  HYPOTHESES.

### Concrete rotation plan (for the owner; NOT executed, NOT authorised)

| Step | Action | Who | Verification |
|---|---|---|---|
| R0 | Freeze changes to production; create restore point `backup-pre-rotation-<date>` from the live branch | owner | Neon branch listed; read-only row counts recorded |
| R1 | List every consumer of `neondb_owner` (§3) and confirm each from metadata. Vercel needs the connector re-authorised for the team scope | owner / implementer | §3 rows moved from HYPOTHESIS to FACT |
| R2 | Reset `neondb_owner` on the **live** branch (Neon console → Roles → Reset password). The new value goes straight into a secret store, never into chat or a file in the repository | owner | `updated_at` changes in the Neon API |
| R3 | Update the consumers that legitimately need the owner role: migration operators' `DIRECT_URL` only. Production `DATABASE_URL` stays `erp_app` | owner | `classify-db-urls.mjs` shows the expected role classes |
| R4 | Redeploy anything built with the old value (the rollback deployment named in §3), or retire it | owner | the deployment's build time is after the variable change |
| R5 | Reset `neondb_owner` on every other branch in §8 that keeps an endpoint, or delete branches no longer needed (`br-delicate-pond`, `br-rough-violet`, `br-bold-forest`, `br-wild-credit`) | owner | per-branch `updated_at`; the old password fails to authenticate (V1/V2, needs TCP 5432) |
| R6 | Rotate `erp_app` if any evidence shows it was exposed (none so far) | owner | — |
| R7 | Record times, steps and verifications in §9; keep the hypotheses until they are verified | owner | — |

## 9. Log

| Time (UTC) | Event |
|---|---|
| 2026-09-27 ~15:0x | exposure (E1) |
| 2026-09-27, before 16:00 | local `.env.rehearsal` deleted |
| 2026-09-27 16:00–16:10 | scope from metadata |
| 2026-09-27 ~19:00 | facts separated from hypotheses; recovery path and strict verifier prepared; no rotation |
| 2026-10-01 08:20 | inventory refreshed from Neon metadata (§10); new branch `br-delicate-pond` added and denied for previews; rotation plan made concrete; no rotation |
