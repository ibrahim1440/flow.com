# Release proposal — accounting ledger core (NOT approved; nothing released)

**Nothing has been merged, deployed to production, or migrated in production.** Production
(`ep-dawn-dust`) was only read (to identify it) and copied into a rehearsal branch.

## What would be released
Branch `feature/accounting-ledger-core` → `main`: migration `20260928090000_accounting_ledger_core`
(additive), accounting services/API/screens, commission → ledger posting (gated), tests, docs.

## Gates still open before any production step
| Gate | State | Owner action |
|---|---|---|
| Branch pushed / draft PR | **blocked** — `git push` and GitHub API return 403: the Claude GitHub App is not installed for `ibrahim1440/flow.com` | install/connect it (claude.ai → Connectors → GitHub, or github.com/apps/claude) |
| Vercel Preview | **blocked** — Vercel returns 403 for scope `ibrahimmutambak-4927s-projects`; `vercel.json` disables deployments of this branch until its Preview env is set | grant the connection that team scope; then set **branch-scoped Preview** `DATABASE_URL`/`DIRECT_URL` for `feature/accounting-ledger-core` → Neon `hiqbah-erp-test` / `preview-accounting-ledger-core` / `accounting_preview` (never production), `ACCOUNTING_PROVISIONAL_POSTING=isolated-test`; then remove the `false` entry |
| Preview database contents | empty (created and marked disposable) | allow this environment's egress to `*.neon.tech` (or run `scripts/accounting/preview-setup.sh` from a machine that can reach Neon) |
| Preview smoke + UAT | not run | `UAT_AR.md` on the Preview |
| Accountant decisions | open | `POLICIES.md` "Still needed" |
| Production migration | not run | explicit owner approval required |

## Proposed production sequence (after approval only)
1. Neon backup branch of the live branch (restore point).
2. `prisma migrate deploy` as `neondb_owner` (via `scripts/migrate-deploy.mjs`).
3. Verify: 30 migrations, 11 functions / 9 triggers, `erp_app` privileges (as in the rehearsal).
4. Deploy the build; `/dashboard/accounting` shows "set-up not complete" — **nothing posts** until
   the accountant completes set-up, cutover and approvals (commission events wait as PENDING).
5. Rollback before set-up: redeploy the previous build (schema is additive). After postings:
   corrections only (see `MIGRATION_AND_CUTOVER.md`).

## Risk notes
- The commission outbox trigger starts writing `AccountingEvent` rows immediately after the
  migration, even before set-up; they wait (no journals). Harmless, but the table grows.
- Rehearsal proved the schema on production's shape; it did not run the new build against that copy.
