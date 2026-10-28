-- The owner's shortfall threshold (feat/shortfall-threshold). ADDITIVE ONLY, one transaction (PostgreSQL 16 / 17).
--
--   1. Four NULLABLE "SystemConfig" columns — Settings › Inventory «حد النقص عند الاستلام». NULL = the owner has not set
--      the value and the built-in default applies (src/lib/inventory/shortfall-threshold.ts):
--        · "inventoryShortfallPercent"         NUMERIC(5,2)  — a shortfall above this % of the line needs a supervisor
--                                                              (default 2); CHECK 0–100;
--        · "inventoryShortfallValueSar"        NUMERIC(12,2) — … above this value at the moving average (default 500 SAR);
--                                                              CHECK ≥ 0;
--        · "inventoryShortfallZeroNeedsAdjust" BOOLEAN       — a line received at zero needs a supervisor (default on);
--        · "inventoryShortfallRollingMultiple" NUMERIC(6,2)  — a receiver whose shortfalls over 30 days pass this many times
--                                                              the value limit needs a supervisor (default 2); CHECK 0–1000.
--   2. "StockTransferLine"."shortfallValue" NUMERIC(18,2), nullable, CHECK ≥ 0 — the value of a line's shortfall as judged
--      at the receipt (the write-off's own value; NULL = none, or not known), so the rolling 30-day sum per receiver reads
--      what was recorded. Every existing row is NULL there.
--      Above the limit a receiver's shortfall needs inventory › adjust and the full stock-change gate (step-up).
--      Changed by the admin role (verified individual, step-up), each change in SettingsAuditLog (section "inventory").
-- Nullable, no default: metadata only, no row rewritten, no trigger fired. No new table, sequence or function, so no grant
-- (the runtime role's grants on "SystemConfig" and "StockTransferLine" cover the columns).
-- Rollback: docs/hr/migration-review/rollback-20261118090000_shortfall_threshold.sql.
BEGIN;

ALTER TABLE "SystemConfig"
  ADD COLUMN "inventoryShortfallPercent" DECIMAL(5,2),
  ADD COLUMN "inventoryShortfallValueSar" DECIMAL(12,2),
  ADD COLUMN "inventoryShortfallZeroNeedsAdjust" BOOLEAN,
  ADD COLUMN "inventoryShortfallRollingMultiple" DECIMAL(6,2);

ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_inventoryShortfall_check" CHECK (
  ("inventoryShortfallPercent" IS NULL OR ("inventoryShortfallPercent" >= 0 AND "inventoryShortfallPercent" <= 100))
  AND ("inventoryShortfallValueSar" IS NULL OR "inventoryShortfallValueSar" >= 0)
  AND ("inventoryShortfallRollingMultiple" IS NULL OR ("inventoryShortfallRollingMultiple" >= 0 AND "inventoryShortfallRollingMultiple" <= 1000))
);

ALTER TABLE "StockTransferLine" ADD COLUMN "shortfallValue" DECIMAL(18,2);
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_shortfallValue_check" CHECK ("shortfallValue" IS NULL OR "shortfallValue" >= 0);

COMMIT;
