-- Inventory privileges Option A, review corrections P2-4 / P3-8 (docs/hr/SOD.md §20.5).
-- ADDITIVE: two SourceDocType values; no row, table, constraint or other type is changed.
--   OPENING_BALANCE — the stock a new green bean or packaging material is created with (an IN
--                     movement; it used to be labelled MANUAL_ADJUSTMENT, which reads as a count).
--   RECEIVING       — a delivery of packaging material received under inventory › receive
--                     (POST /api/materials/:id/receive; positive IN only, audited).
-- Rollback: docs/hr/migration-review/rollback-20261017150000_inventory_receiving_source.sql.
BEGIN;

ALTER TYPE "SourceDocType" ADD VALUE IF NOT EXISTS 'OPENING_BALANCE';
ALTER TYPE "SourceDocType" ADD VALUE IF NOT EXISTS 'RECEIVING';

COMMIT;
