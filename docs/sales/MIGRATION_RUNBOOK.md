# Migration Runbook — Sales CRM & Commissions

Migration: `20260924090000_add_sales_crm_and_commissions` (migration **21**).

---

## 1. What it does

| | |
|---|---|
| New tables | **19** |
| New enum types | **11** |
| Indexes | 32 plain + 13 unique |
| Foreign keys | 38 — every one on a table this same migration creates |
| **Statements touching a pre-existing table** | **0** |

Verified by inspecting the generated SQL, not by intention: every `ALTER TABLE` in the file
adds a constraint to a new table. No existing column is added, altered, renamed or dropped.
The relation fields added to `Employee`, `Customer`, `Order` and `ProductSKU` in the Prisma
schema are Prisma-level only and produce no DDL.

**Consequence:** the currently released build reads every existing table unchanged, so this
migration can be applied before the application that uses it — expand first, and nothing to
contract.

---

## 2. Environment boundary — read before running anything

**This migration has NOT been applied to production, and this runbook does not authorise it.**

Applied so far:

| Target | Identity | Purpose |
|---|---|---|
| Preview | endpoint `ep-wandering-leaf-…` / database **`sales_preview`**, as **`sales_preview_migrator`** | The isolated preview target. Created **empty**; nothing was copied into it. |
| Regression | same endpoint / database `neondb`, as `neondb_owner` | So the existing 26-suite regression could run against the new schema. |
| Preview (superseded) | same endpoint / database `sales_crm_preview`, as `neondb_owner` | The first preview database. Still present and untouched; replaced because a restricted role cannot be retrofitted onto tables another role already owns. |

### Why the preview database is a fresh one rather than a branch

The authorised parent, `erp-regression-r1`, was inspected first. Its business tables are
empty, but it holds **17 untagged, staff-shaped `Employee` rows** — matching production's
employee count exactly, six with passwords set, with the real role spread. It therefore could
not be verified as synthetic-only, so it was **not branched**. A new empty database on that
non-production branch was created instead: no data copied, no branch slot consumed, and the
parent untouched.

### The guard, and the second identity

Migrations run under their **own** credential, `sales_preview_migrator`, through their own
runner: `scripts/sales-preview/withmigrate.mjs`. The application's credential cannot run them
and its runner refuses `prisma` outright. The separation is the point — an application that
can rewrite its own schema is an application whose schema anything reaching it can rewrite.

`withmigrate.mjs` is an **allowlist**, not a denylist. Three things must hold on every
connection path — `DATABASE_URL`, `DIRECT_URL`, `SHADOW_DATABASE_URL`,
`ERP_TEST_DATABASE_URL`, `POSTGRES_URL`:

1. the endpoint is the approved non-production one,
2. the database is `sales_preview`,
3. the **role** is `sales_preview_migrator`.

(3) is the condition the previous revision of this runbook did not have. The old guard checked
where a connection pointed but not who it connected as, so it would have run a migration as
`neondb_owner` — a role that is a member of `neon_superuser`, and therefore of
`pg_read_all_data` and `pg_write_all_data`, across every database on the branch.

Three production identifiers are denied as well, as a second line and never as the only one. A
denylist alone is not sufficient and this project has the scar to prove it: an earlier guard
named an endpoint that exists in no environment at all and was therefore protecting nothing.

Proven in both directions, and the proof is runnable — `sh scripts/sales-preview/guard-proof.sh`
drives every refusal and the one acceptance, for both runners, without opening a connection.

What the migration role can and cannot do: it owns every table in `sales_preview` and may
change them, and it holds `CREATE` on that database and its `public` schema. It is **not**
superuser, has **no** `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS`, is a member of
**no** role, cannot drop or rename the database, and cannot read anything in any other
database on the branch. `DATABASE_ISOLATION.md` has the 36 assertions.

---

## 3. Preparation

1. Confirm the target: `prisma migrate status` through the guarded runner. It prints the host
   and database it resolved. If it is not `sales_preview`, **stop**.
2. Confirm the migration is unchanged from what was certified:
   `git diff <certified-sha> -- prisma/migrations/20260924090000_add_sales_crm_and_commissions/`
   must be empty.
3. Confirm the count: 21 migrations found, 20 applied, 1 pending.
4. Take a recovery point if the target holds anything you would miss. The preview database is
   disposable by design, so this step exists for any other environment.

---

## 4. Execution

```bash
MIGRATE_ENV=<the migration env file> \
  node scripts/sales-preview/withmigrate.mjs prisma migrate deploy
```

The env file here is **not** the one the application uses. `scripts/sales-preview/README.md`
describes both.

Never `prisma db push`, never `migrate reset`, never `migrate resolve` to skirt a failure, and
never from a build step. The build script in this project runs `validate-env`,
`prisma generate` and `next build` — no migration — and the clean-build gate asserts that.

---

## 5. Verification

After applying:

- `migrate status` → **"Database schema is up to date!"**, 21 migrations found.
- Row counts on every pre-existing table unchanged.
- The 19 new tables exist and are empty.
- Every foreign key validates: `SELECT … FROM pg_constraint WHERE contype='f' AND NOT convalidated` returns nothing.
- The existing regression suite passes against the new schema — the strongest single signal
  that nothing was disturbed.

Evidence for each is recorded in `VERIFICATION_REPORT.md`.

### A note on reading `_prisma_migrations` directly

The table holds **22** rows for 21 migrations. The extra one is `20260522000000_baseline`,
marked rolled back with `applied_steps_count = 0`: the first attempt against `sales_preview`
failed on a missing `CREATE` privilege on the database *before executing any statement*, and
was cleared with `prisma migrate resolve --rolled-back` before the grant was added and the
deploy re-run. `--rolled-back` leaves `finished_at` NULL, so a naive
`COUNT(*) FILTER (WHERE finished_at IS NULL)` reports one unfinished migration on a database
that is entirely up to date. Count `rolled_back_at IS NULL` as well, or just ask
`prisma migrate status`.

The grant that was missing, for anyone reproducing this: Prisma issues
`CREATE SCHEMA IF NOT EXISTS "public"`, and PostgreSQL checks `CREATE` on the *database* even
when the schema already exists. `GRANT CREATE ON DATABASE sales_preview TO sales_preview_migrator`
is what it needs — on that database only.

---

## 6. Rollback

### Application rollback — the preferred route

Because the migration is purely additive, **the previous build runs against schema 21
unchanged**. Reverting the application alone is sufficient and touches no data. This is the
fastest and least disruptive option and should be the default.

### Schema rollback

Prisma does **not** generate down-migrations, so there is no automatic reverse. Nor is
redeploying older code sufficient on its own if data has been written to the new tables.

To remove the schema, a new forward migration must be written that drops the 19 tables and 11
types in dependency order (children first: `CommissionLedgerEntry`, `CommissionAccrual`,
`CollectionEvent`, `CommissionAssignment`, `CommissionTier`, `CommissionPlanVersion`,
`CommissionPlan`, `OpportunityOrder`, `QuoteLine`, `Quote`, `SampleShipment`, `Activity`,
`OpportunityStageEvent`, `OpportunityOwner`, `LeadConversion`, `Opportunity`, `Lead`,
`PipelineStage`, `SalesTarget`).

**That is destructive and irreversible.** Any CRM data entered is lost. Do not treat it as a
routine reversal; prefer the application rollback, and export anything worth keeping first.

### Data rollback

There is no data migration in this release — nothing was backfilled, converted or rewritten —
so there is no data rollback to perform. That is a deliberate property of the design, not luck.

---

## 7. If this is ever applied to production

Out of scope for this task and not authorised here. When it is:

1. Fresh recovery point immediately before the schema write.
2. Census before and after; every pre-existing row count must be identical.
3. Apply through an explicit allowlisted runner, never from a build.
4. Confirm the currently-live build still answers `/api/health` against the new schema —
   additivity proven in production reality, not only in rehearsal.
5. **Disable the sandbox collection source.** It is gated on `SALES_SANDBOX_COLLECTIONS`, a
   database-host check and its own privilege, but none of those should be the only thing
   standing between production and a synthetic collection event.
