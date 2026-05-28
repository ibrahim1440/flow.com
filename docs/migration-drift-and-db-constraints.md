# Migration Drift and Manual DB Constraints

> **Status: Migration baseline established 2026-05-22. Schema drift resolved. `prisma migrate deploy` is now the production deployment command. `_prisma_migrations` contains three applied migrations: `20260522000000_baseline`, `20260526115344_add_qc_final_decision_reason`, `20260528084853_add_rate_limit`. Old migrations archived at `prisma/migrations_archive_before_baseline_20260522/`.**

## 1. Current Status

### Schema vs Live Database

`schema.prisma` **matches the live database exactly.**

Running the following command returns an empty migration:

```bash
npx prisma migrate diff \
  --from-schema prisma/schema.prisma \
  --to-config-datasource \
  --script
# Output: "-- This is an empty migration."
```

There is no active schema mismatch. Every table, column, index, foreign key, and enum
defined in `schema.prisma` exists in the live database with the correct structure.

### Historical Context — Drift Resolved 2026-05-22

The drift was **migration-history tracking drift only**, not a live schema mismatch.

The project previously used `prisma db push` (and in some cases `prisma db execute`) as its
primary schema-change workflow instead of `prisma migrate dev` + `prisma migrate deploy`. As a
result, the `_prisma_migrations` table and the `prisma/migrations/` directory did not fully
represent the schema running in production.

This was resolved on 2026-05-22 by executing the full replacement baseline (Option A — see
Section 5). `_prisma_migrations` now tracks a single row: `20260522000000_baseline`.

**Pre-baseline tables that had no migration (all now covered by baseline):**
`BlendIngredient`, `CuppingSessionBatch`, `CustomerRoastPreference`, `FinishedGoodsLot`,
`InventoryMovement`, `LoginAttempt`, `ProductSKU`, `ProductionOrder`, `PurchaseRecord`,
`Supplier`.

**Pre-baseline columns with no migration (all now covered):**
`Employee.pinHash`; `OrderItem.productId`, `productSkuId`; `RoastingBatch.isBlend`,
`productId`, `productionOrderId`; `QcRecord.colorGround`, `colorWhole`;
`CoffeeProduct.defaultGreenBeanId`, `expectedRoastLoss`; `CuppingSession.sessionToken`;
`CuppingScore.sessionBatchId`.

**Pre-baseline untracked enums (all now covered):**
`PurchaseType`, `MovementType`, `InventoryCategory`, `SourceDocType`, `LotStatus`,
`ProductionOrderStatus`.

**Pre-baseline index replacement (now covered):**
The old `RoastingBatch_batchNumber_key` (single-column unique on `batchNumber`) was replaced
by `RoastingBatch_greenBeanId_batchNumber_key` (composite unique). The baseline captures
the composite index; the old single-column index is not present.

---

## 2. Dangerous Commands — Do Not Run Without Explicit Approval

> **Baseline established 2026-05-22.** The commands below document their previous danger and their updated status. `prisma migrate deploy` and `prisma migrate dev` are now unblocked. `prisma migrate reset` and `prisma db push` remain off-limits for production.

| Command | Why it is dangerous |
|---|---|
| `prisma migrate dev` | **Safe for local development as of 2026-05-22.** The baseline is in sync. Use this to generate new tracked migration files for schema changes. Review generated SQL before committing. Never run in production. |
| `prisma migrate deploy` | **Production deployment command as of 2026-05-22.** Used in `package.json build`. The baseline ensures no pending migrations fail. Safe in CI/CD. |
| `prisma migrate reset` | Drops and recreates the entire database — all data is destroyed |
| `prisma db push` (without explicit approval) | Continues to worsen migration-history drift. Must not be used as a routine schema change tool going forward |

---

## 3. Manual Database Constraints Added Outside Prisma Migrations

The following five CHECK constraints were added directly to the live database using
`prisma db execute`. The first four were applied on 2026-05-19; the fifth,
`FinishedGoodsLot_availableQty_non_negative`, was applied on 2026-05-22. They enforce
non-negative inventory quantities at the database level.

| Constraint name | Table | Column | Rule |
|---|---|---|---|
| `GreenBean_quantityKg_non_negative` | `GreenBean` | `quantityKg` | `>= 0` |
| `RoastingBatch_greenBeanQuantity_positive` | `RoastingBatch` | `greenBeanQuantity` | `> 0` |
| `RoastingBatch_roastedBeanQuantity_non_negative` | `RoastingBatch` | `roastedBeanQuantity` | `>= 0` |
| `RoastingBatch_wasteQuantity_non_negative` | `RoastingBatch` | `wasteQuantity` | `>= 0` |
| `FinishedGoodsLot_availableQty_non_negative` | `FinishedGoodsLot` | `availableQty` | `>= 0` |

These were verified to exist in the database via `information_schema.check_constraints`
immediately after application. `FinishedGoodsLot_availableQty_non_negative` was verified
via `information_schema.check_constraints`: `check_clause = ("availableQty" >= (0)::double precision)`.

Rollback SQL (if ever needed):

```sql
ALTER TABLE "GreenBean"      DROP CONSTRAINT IF EXISTS "GreenBean_quantityKg_non_negative";
ALTER TABLE "RoastingBatch"  DROP CONSTRAINT IF EXISTS "RoastingBatch_greenBeanQuantity_positive";
ALTER TABLE "RoastingBatch"  DROP CONSTRAINT IF EXISTS "RoastingBatch_roastedBeanQuantity_non_negative";
ALTER TABLE "RoastingBatch"  DROP CONSTRAINT IF EXISTS "RoastingBatch_wasteQuantity_non_negative";
ALTER TABLE "FinishedGoodsLot" DROP CONSTRAINT IF EXISTS "FinishedGoodsLot_availableQty_non_negative";
```

---

## 4. Prisma Cannot Represent These CHECK Constraints

Prisma's schema language (`schema.prisma`) has no `@check` or `@@check` attribute.
The five constraints above are **invisible to Prisma's schema engine**:

- `prisma migrate diff` will never generate or detect them in either direction.
- Running `prisma migrate dev` in the future may generate a migration that rewrites
  `GreenBean` or `RoastingBatch` without preserving these constraints, silently dropping them.
- `prisma db push` will also silently drop them if it rewrites affected tables.

**Any future migration that touches `GreenBean`, `RoastingBatch`, or `FinishedGoodsLot` must be reviewed to ensure these five constraints are not silently dropped.** If a migration regenerates any of these tables, the five `ALTER TABLE ... ADD CONSTRAINT` statements must be appended manually before the migration is applied.

---

## 5. Baseline Execution Record — Completed 2026-05-22

Option A (Full Replacement Baseline) was executed on 2026-05-22. The following steps
were performed in order:

1. **Neon snapshot created:** `before-migration-baseline-20260522` (production branch, never expires).
2. **`_prisma_migrations` backup:** Saved to `/tmp/hiqbah_migrations_backup_20260522.json` with full restore SQL for the three deleted rows.
3. **Baseline SQL generated:**
   ```bash
   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > /tmp/hiqbah_baseline_generated.sql
   ```
   Output: 556 lines — 22 CREATE TABLE, 6 CREATE TYPE, 15 CREATE INDEX/UNIQUE INDEX, 33 ALTER TABLE ADD CONSTRAINT. No INSERT, DELETE, UPDATE, or DROP statements.
4. **Five P0 CHECK constraints appended manually** to the bottom of the SQL (Prisma cannot generate them — see Sections 3 and 4).
5. **Baseline migration file created:** `prisma/migrations/20260522000000_baseline/migration.sql` (577 lines).
6. **Old migration directories archived:** Moved to `prisma/migrations_archive_before_baseline_20260522/`. The four directories (`20260506142657_init`, `20260510000000_add_system_config`, `20260510000001_add_cupping`, `20260511000000_green_bean_bilingual`) are preserved there.
7. **Old `_prisma_migrations` rows deleted:** Three rows (`init`, `add_system_config`, `add_cupping`) deleted via targeted `DELETE WHERE migration_name IN (...)`. `20260511000000_green_bean_bilingual` was never in the table and was not touched.
8. **Baseline marked applied:**
   ```bash
   npx prisma migrate resolve --applied 20260522000000_baseline
   ```
9. **Empty diff confirmed:**
   ```bash
   npx prisma migrate diff --from-schema prisma/schema.prisma --to-config-datasource --script
   # Output: -- This is an empty migration.
   ```
10. **`package.json` build script updated:**
    - `"build"`: `prisma generate && prisma migrate deploy && next build`
    - `"db:push"` → renamed to `"db:push:local"`: `prisma db push` (local/prototype only)

### Baseline SQL Review Checklist (Executed)

These items were verified before the baseline was marked applied:

- [x] No `DROP TABLE` statements
- [x] No `DROP COLUMN` statements
- [x] No `DROP CONSTRAINT` statements other than the intentional batchNumber index replacement
- [x] No `ALTER COLUMN ... TYPE` statements
- [x] No `SET NOT NULL` on columns that could contain NULL values in existing data
- [x] The five P0 CHECK constraint `ALTER TABLE` statements are present
- [x] If a migration touches `GreenBean`, `RoastingBatch`, or `FinishedGoodsLot`, verify the five P0 constraints are not dropped
- [x] If a migration regenerates those tables, manually add the `ADD CONSTRAINT` statements back
- [x] All FK `ON DELETE` behaviors match `schema.prisma` (CASCADE, SET NULL, RESTRICT)
- [x] The `SystemConfig` singleton `INSERT INTO "SystemConfig" ("id") VALUES ('singleton')` is NOT included (row already exists in the DB)

---

## 6. Recommended Future Process for Schema Changes

> Apply this process before any future schema additions, including planned items such as
> `Role`/RBAC tables.

**Steps in order:**

**a. ~~Establish the migration baseline first~~ — Complete as of 2026-05-22.** `_prisma_migrations` contains a single row: `20260522000000_baseline`. The active `prisma/migrations/` directory contains only the baseline and `migration_lock.toml`. Future schema changes may now proceed via `prisma migrate dev` locally followed by `prisma migrate deploy` in production.

**b. Generate the proposed SQL for review before applying:**
   ```bash
   npx prisma migrate diff \
     --from-schema prisma/schema.prisma \
     --to-schema prisma/schema_with_new_changes.prisma \
     --script
   ```
   Review for destructive operations before touching the database.

**c. Inspect for CHECK constraint impact.** If the migration touches `GreenBean`,
   `RoastingBatch`, or `FinishedGoodsLot`, verify the five P0 constraints are not dropped.
   If the migration regenerates those tables, manually add the `ADD CONSTRAINT` statements back.

**d. Apply via `prisma migrate dev` only after baseline and review are complete.**
   This generates a tracked migration file and applies it to the DB in a single step.

**e. Document any new `prisma db execute` constraints** in this file immediately after
   applying them. Do not rely on memory or git history alone.

---

## 7. Safe Commands Reference

| Command | Safety | Notes |
|---|---|---|
| `npx prisma migrate diff --from-schema ... --to-config-datasource --script` | Read-only | Reports drift; does not modify DB or files |
| `npx prisma migrate diff --from-empty --to-schema ... --script` | Read-only | Generates full schema SQL for review |
| `npx prisma db execute --stdin` | Write — requires explicit approval | Used for targeted SQL not representable in schema.prisma (e.g., CHECK constraints) |
| `npx prisma migrate resolve --applied <name>` | Write — requires explicit approval | Records a migration as applied without running it; only use after full SQL review |
| `npx prisma migrate deploy` | **Production command** — used in `build` script | Safe. Baseline ensures no pending migrations fail. Use in CI/CD and production deploys. |
| `npx prisma migrate dev` | **Safe for local development** | Generates tracked migration files for schema changes. Review generated SQL before committing. Never run in production. |
| `npx prisma studio` | Read-only UI | Safe to run at any time |

---

## 8. Warning: db push Is Not an Acceptable Schema Change Workflow

> **This project must not rely on `prisma db push` as the normal schema change workflow
> going forward.**

`db push` applies schema changes directly to the database without creating a migration file.
It has no rollback capability, creates no audit trail, and makes `prisma migrate deploy`
(the standard production deployment command) unsafe to run.

**These consequences existed before 2026-05-22 and are now resolved by the baseline:**
- ~~Half the database schema had no migration coverage~~ — all 22 tables covered by `20260522000000_baseline`.
- ~~`migrate deploy` would fail in CI or a fresh environment~~ — `migrate deploy` is the production build command.
- ~~A future database restore from migrations would produce an incomplete schema~~ — the baseline covers the full schema.
- ~~Automated rollback of a bad deploy is not possible via the migration system~~ — the Neon snapshot `before-migration-baseline-20260522` provides a restore point; future migrations are tracked and reversible.

From this point forward, all schema changes must go through `prisma migrate dev` locally
and `prisma migrate deploy` in production. Migration files must be committed to version
control before being applied to the production database.

The only exception is constraints not representable in Prisma's schema language (such as
the five P0 CHECK constraints above), which must be applied via `prisma db execute` with
explicit approval and documented in this file.
