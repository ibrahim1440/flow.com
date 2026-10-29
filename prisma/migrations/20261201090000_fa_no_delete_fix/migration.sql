-- L-13 — fixed_asset_no_delete() on the tables without a "status" column (batch 22 WP-I, BATCH22-DESIGN §2 WP-I).
-- ONE FUNCTION REPLACED IN PLACE, one transaction (PostgreSQL 16 / 17); no table, row, trigger or grant changes otherwise.
--
-- The defect: `IF TG_TABLE_NAME = 'FixedAsset' AND OLD."status" = 'DRAFT'` is ONE SQL expression; PL/pgSQL plans it
-- against the row type and does not short-circuit, so on "FixedAssetCategory", "FixedAssetEvent",
-- "FixedAssetDepreciationRun", "FixedAssetDepreciationLine", "FixedAssetAddition" and "FixedAssetDisposal" (no
-- "status", or not the asset's) a DELETE raised 42703 «record "old" has no field "status"» instead of FA_KEPT (P0001).
-- The delete was refused either way, but with the wrong code and message (the application's error mapping and the
-- tests expect FA_KEPT).
--
-- The fix: OLD."status" is read only inside the FixedAsset branch (a nested IF). The function's CURRENT definition is
-- patched rather than re-typed, so a branch a later migration of the same batch added (WP-G: an OPENING asset of an
-- unreverted import) is kept: each `IF TG_TABLE_NAME = 'FixedAsset' AND OLD."status" = '<S>' THEN` becomes
-- `IF TG_TABLE_NAME = 'FixedAsset' THEN IF OLD."status" = '<S>' THEN … END IF; END IF;` — the function is refused (the
-- migration aborts) if a condition still combines TG_TABLE_NAME with a column of OLD afterwards, i.e. if its shape is not
-- the one this fix knows.
-- Then EXECUTE is re-granted to the runtime role (flowcom_app), when it exists.
-- Verifier check 69: no `OLD."status"` outside the FixedAsset branch, and a DELETE on each guarded table (one row, in a
-- rolled-back subtransaction) raises SQLSTATE P0001.
-- Rollback: docs/hr/migration-review/rollback-20261201090000_fa_no_delete_fix.sql.
BEGIN;

DO $$
DECLARE def text; fixed text;
BEGIN
  def := pg_get_functiondef('fixed_asset_no_delete()'::regprocedure);
  -- The original single-branch form (20261121090000_fixed_assets): `IF … AND OLD."status" = 'DRAFT' THEN RETURN OLD; END IF;`
  fixed := regexp_replace(def,
    'IF\s+TG_TABLE_NAME\s*=\s*''FixedAsset''\s+AND\s+OLD\."status"\s*=\s*(''[A-Z_]+'')\s+THEN\s+RETURN\s+OLD;\s+END\s+IF;',
    'IF TG_TABLE_NAME = ''FixedAsset'' THEN' || chr(10) || '    IF OLD."status" = \1 THEN' || chr(10) || '      RETURN OLD;' || chr(10) || '    END IF;' || chr(10) || '  END IF;',
    'g');
  IF fixed ~ 'TG_TABLE_NAME\s*=\s*''[A-Za-z]+''\s+AND\s+(NOT\s+)?\(?\s*OLD\.' OR fixed ~ 'OLD\.\S+[^;]*\s+AND\s+TG_TABLE_NAME' THEN
    RAISE EXCEPTION 'fa_no_delete_fix: fixed_asset_no_delete() still reads a column of OLD inside a combined condition — its definition is not one this fix knows; fix it by hand';
  END IF;
  IF fixed <> def THEN
    EXECUTE fixed;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT EXECUTE ON FUNCTION fixed_asset_no_delete() TO flowcom_app;
  END IF;
END $$;

COMMIT;
