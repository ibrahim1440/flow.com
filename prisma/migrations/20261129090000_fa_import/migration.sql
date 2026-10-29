-- «استيراد الأصول الثابتة من قيود» (batch 22 WP-G, owner answer 6). ADDITIVE ONLY, one transaction (PostgreSQL 16 / 17).
-- The asset register kept in Qoyod is brought in once, before the opening is posted, as OPENING assets (cost and
-- accumulated depreciation at the day before go-live); the opening grid then carries them (applyFaOpening).
--
--   1. "FixedAssetImport" — one row per imported CSV file: its name, its sha256 checksum (ONE live import per checksum:
--      a partial unique index, so the same file imported twice replays the first import instead of doubling the
--      register; after an undo the same file may be imported again), the row count, the Σ cost / Σ accumulated, the
--      control totals the accountant typed from Qoyod's trial balance, who and when, and revertedAt / revertedBy (an
--      undo, once). Never deleted, not truncated, audited; only the undo columns change, once (fixed_asset_import_guard).
--   2. "FixedAsset"."importId" — the batch an asset came from (nullable; FK RESTRICT; indexed). Only an OPENING asset
--      carries it (a CHECK).
--   3. fixed_asset_no_delete() — replaced in place with nested IFs (a record's field is read only inside the branch of
--      its own table: the L-13 defect of WP-I is fixed by this text too) and ONE new branch: «إلغاء الاستيراد» may delete
--      an asset of an unreverted import — still OPENING, with no event other than its OPENING one — and that OPENING
--      event, only while the opening is not posted and only inside the undo (the session names the batch:
--      SET LOCAL hiqbah.fa_import_undo = '<import id>'). Everything else is refused with FA_KEPT, as before.
--      NOTE for WP-I (20261201090000_fa_no_delete_fix): its CREATE OR REPLACE must keep this import branch.
--   4. The runtime role (flowcom_app), when it exists, is granted the table and the functions.
-- Rollback: docs/hr/migration-review/rollback-20261129090000_fa_import.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "FixedAssetImport" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "fileName" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "rows" INTEGER NOT NULL,
  "totalCost" DECIMAL(18,2) NOT NULL,
  "totalAccumulated" DECIMAL(18,2) NOT NULL,
  "controlTotals" JSONB,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revertedAt" TIMESTAMP(3),
  "revertedBy" TEXT,
  CONSTRAINT "FixedAssetImport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FixedAssetImport_values_check" CHECK ("rows" > 0 AND "totalCost" > 0 AND "totalAccumulated" >= 0 AND "totalAccumulated" <= "totalCost"
    AND "checksum" ~ '^[0-9a-f]{64}$' AND length(btrim("fileName")) BETWEEN 1 AND 200
    AND ("controlTotals" IS NULL OR jsonb_typeof("controlTotals") = 'array')
    AND (("revertedAt" IS NULL) = ("revertedBy" IS NULL)))
);
CREATE UNIQUE INDEX "FixedAssetImport_checksum_live_key" ON "FixedAssetImport"("checksum") WHERE "revertedAt" IS NULL;
CREATE INDEX "FixedAssetImport_createdAt_idx" ON "FixedAssetImport"("createdAt");

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "FixedAsset" ADD COLUMN "importId" TEXT;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_importId_fkey" FOREIGN KEY ("importId") REFERENCES "FixedAssetImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_import_check" CHECK ("importId" IS NULL OR "acquisitionKind" = 'OPENING');
CREATE INDEX "FixedAsset_importId_idx" ON "FixedAsset"("importId");

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fixed_asset_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE undo text := nullif(current_setting('hiqbah.fa_import_undo', true), '');
BEGIN
  IF TG_TABLE_NAME = 'FixedAsset' THEN
    IF OLD."status" = 'DRAFT' THEN
      RETURN OLD;
    END IF;
    -- «إلغاء الاستيراد» (20261129090000_fa_import): an OPENING asset of the unreverted import the session undoes,
    -- before the opening is posted, with nothing recorded on it but its OPENING event (already deleted by then).
    IF undo IS NOT NULL AND OLD."importId" = undo AND OLD."acquisitionKind" = 'OPENING'
       AND EXISTS (SELECT 1 FROM "FixedAssetImport" i WHERE i."id" = undo AND i."revertedAt" IS NULL)
       AND NOT EXISTS (SELECT 1 FROM "AccountingSettings" s WHERE s."openingEntryId" IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM "FixedAssetEvent" e WHERE e."assetId" = OLD."id") THEN
      RETURN OLD;
    END IF;
  ELSIF TG_TABLE_NAME = 'FixedAssetEvent' THEN
    IF undo IS NOT NULL AND OLD."kind" = 'OPENING' AND OLD."glState" = 'OPENING'
       AND EXISTS (SELECT 1 FROM "FixedAsset" a JOIN "FixedAssetImport" i ON i."id" = a."importId"
                    WHERE a."id" = OLD."assetId" AND a."importId" = undo AND a."acquisitionKind" = 'OPENING' AND i."revertedAt" IS NULL)
       AND NOT EXISTS (SELECT 1 FROM "AccountingSettings" s WHERE s."openingEntryId" IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM "FixedAssetEvent" e WHERE e."assetId" = OLD."assetId" AND e."id" <> OLD."id") THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'FA_KEPT: % rows are part of the books and are never deleted (reverse or cancel them)', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

-- An import is a record of what entered the register: only its undo is written, once.
CREATE OR REPLACE FUNCTION fixed_asset_import_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."fileName" <> OLD."fileName" OR NEW."checksum" <> OLD."checksum" OR NEW."rows" <> OLD."rows"
     OR NEW."totalCost" <> OLD."totalCost" OR NEW."totalAccumulated" <> OLD."totalAccumulated"
     OR NEW."controlTotals" IS DISTINCT FROM OLD."controlTotals" OR NEW."createdBy" <> OLD."createdBy" OR NEW."createdAt" <> OLD."createdAt"
     OR OLD."revertedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'FA_FROZEN: an import never changes; it is only undone, once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fixed_asset_no_delete BEFORE DELETE ON "FixedAssetImport" FOR EACH ROW EXECUTE FUNCTION fixed_asset_no_delete();
CREATE TRIGGER fixed_asset_import_guard BEFORE UPDATE ON "FixedAssetImport" FOR EACH ROW EXECUTE FUNCTION fixed_asset_import_guard();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "FixedAssetImport" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "FixedAssetImport" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "FixedAssetImport" TO flowcom_app;
    GRANT EXECUTE ON FUNCTION fixed_asset_no_delete(), fixed_asset_import_guard() TO flowcom_app;
  END IF;
END $$;

COMMIT;
