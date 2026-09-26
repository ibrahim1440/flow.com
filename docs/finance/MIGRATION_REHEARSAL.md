# Finance migrations — rehearsal procedure on an isolated database (proposal, not executed)

**Nothing in this document has been run against production or against any copy of it.** It
is the procedure an authorised person follows to rehearse the Finance migrations on an
isolated database before any production change is even scheduled.

## What is being rehearsed

| Migration | Effect | Touches existing tables? |
|---|---|---|
| `20260926005011_add_finance_cash_budget` | 27 new tables, CHECKs, partial unique indexes, append-only triggers | **No** — every `ALTER TABLE` targets a table created in the same set |
| `20260926092523_finance_statement_matching_and_db_controls` | 3 columns on finance tables, four-eyes triggers | No |
| `20260926140000_finance_strict_four_eyes` | stricter approval guards; drops the self-approval column and helper | No (finance tables only) |

When integrated with Sales, the three Sales migrations (`20260924090000_*`, `20260925130833_*`,
`20260925131140_*`) sort first and are rehearsed in the same run; they *do* add relations to
existing tables (Employee, Customer, Order, ProductSKU) — their owners sign off on that part.

## Roles

- **Owner of the production database** (only they): creates and later deletes the isolated copy,
  holds its owner credential.
- **Operator**: runs the commands below from a machine whose environment contains **only** the
  copy's credentials (never the main checkout's `.env`, which points at production).
- **Reviewer**: checks the recorded outputs and signs off.

## Procedure

1. **Record the starting point.** Production deployment id and commit (today:
   `dpl_6Aa8nwC1xyyB3nmtrYCffCSKM4Cq`, `main` `4640cbe`), the integration candidate commit to be
   rehearsed, and the time.
2. **Create the isolated copy (owner).** In the Neon console, create a branch from the
   production branch (`br-weathered-bread-aqais7hp`) at the recorded time, name it
   `rehearsal-finance-YYYYMMDD`, with its own compute endpoint. It contains production data:
   treat it as sensitive, do not attach it to any Vercel environment, delete it afterwards.
   *Alternative with no production data:* a fresh local database migrated from scratch (as in
   ENVIRONMENT.md §4) — proves the SQL, not the upgrade path on real rows.
3. **Point only at the copy.** Put the copy's owner URL in the shell environment (not a file in
   the repository). Before anything else, confirm the host is the new endpoint and **not**
   `ep-dawn-dust-aqn1u1uf`, `ep-jolly-feather-aqne6cp1` or any other shared endpoint:
   `node scripts/finance/check-env.mjs` (masked output) and read the host line.
4. **Pre-checks (read-only).**
   - `npx prisma migrate status` → exactly the expected pending migrations, nothing unexpected
     applied.
   - Row counts of existing core tables (Employee, Order, OrderItem, InventoryMovement,
     Customer, ProductSKU) and the `_prisma_migrations` list — saved.
5. **Apply.** `node scripts/migrate-deploy.mjs` (the repository's `prisma migrate deploy`
   wrapper; the build never migrates). Record duration and output.
6. **Post-checks.**
   - `npx prisma migrate status` → up to date; `npx prisma migrate diff --from-config-datasource
     --to-schema prisma/schema.prisma --script` → empty.
   - The row counts from step 4 are unchanged.
   - Trigger inventory present (`pg_trigger`): `AllocationEntry_append_only`,
     `AllocationEntry_transfer_approval`, `AllocationRun_append_only`, `FinAuditLog_append_only`,
     `BankTransaction_no_delete`, `BudgetLine_protect_approved`,
     `BudgetRevision_protect_approved`, `BudgetRevision_four_eyes`,
     `AllocationRuleVersion_four_eyes`, `FinApprovalRequest_guard`,
     `PaymentReservation_override_approval`, `FinBudget_reopen_approval`.
   - `FinSettings` has no `allowSelfApproval` column.
7. **Runtime role.** On the copy, create a non-owner application role with DML only (as
   `scripts/finance/local-postgres.mjs grant-app` does locally), then confirm from a session as
   that role: TRUNCATE refused, `ALTER TABLE … DISABLE TRIGGER` refused, a self-decision on an
   approval request refused (the SQL in `tests/finance/integration/lifecycle.test.ts` "no
   self-approval bypass" can be run by hand on a test request).
8. **Application smoke test.** Build the candidate and run it locally against the copy **with
   the runtime role** (not the owner): log in as an administrator on the copy, open existing
   modules (orders, inventory, dashboard) and Finance; Finance shows its empty state until
   accounts are added. Do not run the Finance fixture or the destructive test suites against a
   copy of production data.
9. **Rollback rehearsal.** The migrations have no down scripts. Rehearse the real rollback:
   restore the copy to the step-2 point (Neon "restore branch to a point in time"), confirm the
   step-4 counts and migration list are back. For production, the rollback is the same
   point-in-time restore plus redeploying the previous build.
10. **Record and clean up.** Keep outputs from steps 3–9, the durations and the reviewer's
    sign-off; the owner deletes the rehearsal branch.

## Only after a successful rehearsal

A separate, explicit approval for production: maintenance window, a backup branch taken
immediately before, the same commands run by the owner (never from a developer checkout), the
runtime role switched, and the post-checks repeated.
