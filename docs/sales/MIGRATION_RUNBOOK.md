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
| Preview | endpoint `ep-wandering-leaf-…` / database **`sales_crm_preview`** | The isolated preview target. Created **empty**; nothing was copied into it. |
| Regression | same endpoint / database `neondb` | So the existing 26-suite regression could run against the new schema. |

### Why the preview database is a fresh one rather than a branch

The authorised parent, `erp-regression-r1`, was inspected first. Its business tables are
empty, but it holds **17 untagged, staff-shaped `Employee` rows** — matching production's
employee count exactly, six with passwords set, with the real role spread. It therefore could
not be verified as synthetic-only, so it was **not branched**. A new empty database on that
non-production branch was created instead: no data copied, no branch slot consumed, and the
parent untouched.

### The guard

`withsales.mjs` is an **allowlist**, not a denylist. The URL must name **both** the approved
endpoint **and** the database `sales_crm_preview`, or nothing runs. It checks every connection
path — `DATABASE_URL`, `DIRECT_URL`, `SHADOW_DATABASE_URL`, `ERP_TEST_DATABASE_URL`,
`POSTGRES_URL` — and denies three production identifiers as a second line of defence.

A denylist alone is not sufficient, and this project has the scar to prove it: an earlier
guard named an endpoint that exists in no environment at all and was therefore protecting
nothing.

Proven both ways: pointed at a production endpoint it refuses; pointed at the preview target
it proceeds.

---

## 3. Preparation

1. Confirm the target: `prisma migrate status` through the guarded runner. It prints the host
   and database it resolved. If it is not `sales_crm_preview`, **stop**.
2. Confirm the migration is unchanged from what was certified:
   `git diff <certified-sha> -- prisma/migrations/20260924090000_add_sales_crm_and_commissions/`
   must be empty.
3. Confirm the count: 21 migrations found, 20 applied, 1 pending.
4. Take a recovery point if the target holds anything you would miss. The preview database is
   disposable by design, so this step exists for any other environment.

---

## 4. Execution

```bash
SALES_ENV=<preview env file> node withsales.mjs prisma migrate deploy
```

Never `prisma db push`, never `migrate reset`, never `migrate resolve` to skirt a failure, and
never from a build step. The build script in this project runs `validate-env`,
`prisma generate` and `next build` — no migration — and the clean-build gate asserts that.

---

## 5. Verification

After applying:

- `migrate status` → **21 applied, 0 pending, 0 unfinished**.
- Row counts on every pre-existing table unchanged.
- The 19 new tables exist and are empty.
- Every foreign key validates: `SELECT … FROM pg_constraint WHERE contype='f' AND NOT convalidated` returns nothing.
- The existing regression suite passes against the new schema — the strongest single signal
  that nothing was disturbed.

Evidence for each is recorded in `VERIFICATION_REPORT.md`.

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
