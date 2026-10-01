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
**The implementation is not complete**, so no gate below can make this releasable on its own. Green
local tests verify what is implemented; they do not show completeness.

| Gate | State | Owner action |
|---|---|---|
| Implementation complete | **no**: XAdES cryptographic stamp not implemented (simplified documents carry a local test signature; BR-KSA-28/29 fire in the secondary check); QR tag 9 absent (needs a ZATCA certificate); local rules not mapped to BR-KSA codes; VAT return items (exports, imports, reverse charge, corrections, carried-forward credit) and zakat not modelled | XAdES: network access to zatca.gov.sa or the official Security Features and XML Implementation standards uploaded with their URLs (`ZATCA_SDK_VALIDATION.md` §6); VAT and zakat: professional input |
| Branch pushed / draft PR | branch push possible since 2026-10-01 (see `TEST_RESULTS.md` for the pushed head); **no pull request opened** | owner: open a PR for review when wanted |
| Vercel Preview | **blocked** — the Vercel connector lists projects but project-scoped calls return 403 for scope `ibrahimmutambak-4927s-projects`; `vercel.json` disables deployments of this branch until its Preview env is set | re-authorise the Vercel connector for that scope; set branch-scoped Preview `DATABASE_URL`/`DIRECT_URL` → Neon `hiqbah-erp-test` / `preview-accounting-ledger-core` / `accounting_preview` yourself (secret; never production); then remove the `false` entry |
| Preview database contents | empty (created and marked disposable) | allow this environment's egress to `*.neon.tech` (or run `scripts/accounting/preview-setup.sh` from a machine that can reach Neon) |
| Preview smoke + UAT | not run | `UAT_AR.md` on the Preview |
| Accountant decisions | open | `POLICIES.md` "Still needed" |
| Migration rehearsal on a production copy | local rehearsal of all twelve on main's schema and seed: PASS (`evidence/rehearsal/`); on a production copy only the ledger core (2026-09-27) | owner authorises a Neon branch from the live branch (or names one to reuse) — plan in `MIGRATION_AND_CUTOVER.md` |
| Backup / restore | local dump → restore → verify: PASS, in the release gates; Neon restore procedure written, not exercised | owner authorises a restore-point branch |
| Build against a production copy | not run | needs the Preview above |
| E-invoicing beyond local validation | not started: **official SDK validation blocked** (harness gate NOT_RUN; secondary check leaves BR-KSA-28/29 — XAdES not implemented) (re-checked 2026-10-01; matrix, harness and Java 11 ready — `ZATCA_SDK_VALIDATION.md`; XAdES not implemented, so signature checks are expected to fail) — ZATCA documents, SDK download and sandbox refused by this environment's network policy (`evidence/zatca/access-attempts-2026-09-29.txt`); QR tags 6–8 follow the official documents as cited but are not SDK-validated, and tag 9 is impossible without a ZATCA certificate (`ZATCA_REQUIREMENTS.md` §3); no sandbox, no CSID; production refused by design | network access to zatca.gov.sa / gw-fatoora.zatca.gov.sa, developer-portal onboarding, SDK validation in CI, key custody decision |
| Independent review | not done; package `REVIEW_PACKAGE.md` | a reviewer other than the implementer |
| Accountant acceptance | not done; scenarios and decisions in `ACCOUNTANT_ACCEPTANCE.md`; stages 2–3 explicitly **not accepted** | the accountant |
| Credential remediation | open; inventory refreshed and rotation plan R0–R7 in `CREDENTIAL_INCIDENT.md` §10; nothing rotated | owner |
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
- The ledger-core rehearsal proved that schema on production's shape; it did not run the new build against that copy. The later eleven migrations were rehearsed only locally (main's schema and seed), not on a production copy.
- After the stage 4b migration, operational stock writes from outside this code (scripts, manual SQL) create UNINTEGRATED exception rows; they do not block the write.
