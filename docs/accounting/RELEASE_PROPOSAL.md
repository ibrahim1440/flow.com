# Release proposal — accounting module (NOT proposed yet; NOT approved; nothing released)

**Nothing has been merged, deployed to production, or migrated in production.** Production
(`ep-dawn-dust`) was only read (to identify it) and copied into a rehearsal branch.

## What would be released
Branch `feature/accounting-ledger-core` → `main`: twelve migrations (`20260928090000_accounting_ledger_core`
through `20261003091000_accounting_tax_exemption_codes`, listed in `REQUIREMENTS_MATRIX.md` →
"Migration rehearsal"), accounting services, API and screens for stages 1–6, the operational
integration (events written inside the purchase, roasting, QC, packing, dispatch and count routes),
tests, docs. **No release package is proposed yet:** the gates below come first. E-invoicing is
LOCAL ONLY: releasing it does not connect to ZATCA.

## Gates still open before any production step
| Gate | State | Owner action |
|---|---|---|
| Branch pushed / draft PR | **blocked** — `git push` and GitHub API return 403: the Claude GitHub App is not installed for `ibrahim1440/flow.com` | install/connect it (claude.ai → Connectors → GitHub, or github.com/apps/claude) |
| Vercel Preview | **blocked** — Vercel returns 403 for scope `ibrahimmutambak-4927s-projects`; `vercel.json` disables deployments of this branch until its Preview env is set | grant the connection that team scope; then set **branch-scoped Preview** `DATABASE_URL`/`DIRECT_URL` for `feature/accounting-ledger-core` → Neon `hiqbah-erp-test` / `preview-accounting-ledger-core` / `accounting_preview` (never production), `ACCOUNTING_PROVISIONAL_POSTING=isolated-test`; then remove the `false` entry |
| Preview database contents | empty (created and marked disposable) | allow this environment's egress to `*.neon.tech` (or run `scripts/accounting/preview-setup.sh` from a machine that can reach Neon) |
| Preview smoke + UAT | not run | `UAT_AR.md` on the Preview |
| Accountant decisions | open | `POLICIES.md` "Still needed" |
| Migration rehearsal on a production copy | **only the ledger-core migration** (2026-09-27); the other eight are local only. The stage 4b migration adds a trigger on the operational `InventoryMovement` table and must be rehearsed with live-sized data and timed operational writes | a fresh Neon branch of production and egress to it (or run from a machine that can reach Neon) |
| Build against a production copy | not run | needs the Preview above |
| E-invoicing beyond local validation | not started: no SDK validation, no sandbox, no CSID; production refused by design | network access to zatca.gov.sa / gw-fatoora.zatca.gov.sa, developer-portal onboarding, SDK validation in CI, key custody decision |
| Independent review | not done | reviewer other than the implementer |
| Accountant acceptance | not done; stages 2–3 explicitly **not accepted** | `UAT_AR.md`, `DECISION_PACK.md` (D-1, D-2, loss bands, conversion rates, cost timing, cash-flow classes, cutover) |
| Credential remediation | open, separate workstream (`CREDENTIAL_INCIDENT.md`); no rotation performed or claimed | owner |
| Production migration | not run | explicit owner approval required |

## Proposed production sequence (after approval only)
1. Neon backup branch of the live branch (restore point).
2. `prisma migrate deploy` as `neondb_owner` (via `scripts/migrate-deploy.mjs`).
3. Verify: 41 migrations applied (29 today + 12), functions and triggers per migration as rehearsed (including the replaced journal-entry guard), `erp_app` privileges.
4. Deploy the build; `/dashboard/accounting` shows "set-up not complete" — **nothing posts** until
   the accountant completes set-up, cutover and approvals (commission events wait as PENDING).
5. Rollback before set-up: redeploy the previous build (schema is additive). After postings:
   corrections only (see `MIGRATION_AND_CUTOVER.md`).

## Risk notes
- The commission outbox trigger starts writing `AccountingEvent` rows immediately after the
  migration, even before set-up; they wait (no journals). Harmless, but the table grows.
- The ledger-core rehearsal proved that schema on production's shape; it did not run the new build against that copy, and the later eleven migrations have not been rehearsed at all.
- After the stage 4b migration, operational stock writes from outside this code (scripts, manual SQL) create UNINTEGRATED exception rows; they do not block the write.
