-- The roasting station's sack scan becomes an owner's choice («تأكيد الكيس بالمسح في محطة التحميص»). ADDITIVE ONLY,
-- one transaction (PostgreSQL 16 / 17; nothing here needs to run outside a transaction block).
--
--   1. "SystemConfig"."stationLotScanRequired" BOOLEAN NOT NULL DEFAULT false — Settings › Production & roasting.
--      OFF (the default): the station shows no scan at all; the server picks the lot (product default, else FIFO among
--      the same coffee AT the production site) and the station shows «اسحب من: …». ON: the station offers the scan as
--      an override («كيس غير المقترح»), never a mandatory step. Changed by the admin role (step-up), each change in
--      SettingsAuditLog (section "production").
-- A constant default: metadata only, no row rewritten, no trigger fired. No new table, sequence or function, so no
-- grant (the runtime role's grant on "SystemConfig" covers the column).
-- Rollback: docs/hr/migration-review/rollback-20261116090000_station_lot_scan.sql.
BEGIN;

ALTER TABLE "SystemConfig" ADD COLUMN "stationLotScanRequired" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
