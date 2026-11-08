-- 20261224090000_station_orders_board — «لوحة الطلبات المباشرة» (owner-approved design D15, option C, 8 Nov 2026).
--   1. "Order"."channel": where the order came from — SALES (a rep's quotation), DIRECT_SALE («بيع مباشر»), STORE (the web
--      store), CAFE (the café), BACK_OFFICE (entered on the Orders page). NULL on every existing order: readers derive the
--      source for those (a deal link → SALES, the DIRECT_SALE_CREATED audit row → DIRECT_SALE, otherwise BACK_OFFICE).
--   2. "Station"."type" accepts ORDERS_BOARD: a read-only board device. Nobody signs in on it; it holds no claims.
-- Additive and idempotent: one nullable column (no table rewrite, no data written), one CHECK on it, and the station type
-- CHECK replaced by a wider one. No index: the board reads open orders through the existing "Order_status_idx".
-- Rollback: docs/hr/migration-review/rollback-20261224090000_station_orders_board.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "channel" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_channel_check') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_channel_check"
      CHECK ("channel" IS NULL OR "channel" IN ('SALES', 'DIRECT_SALE', 'STORE', 'CAFE', 'BACK_OFFICE'));
  END IF;
  -- Column-level UPDATE on "Order" for the runtime role, only where the role already works column by column there.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app')
     AND EXISTS (SELECT 1 FROM information_schema.column_privileges
                  WHERE table_name = 'Order' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges
                      WHERE table_name = 'Order' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
    GRANT UPDATE ("channel") ON "Order" TO flowcom_app;
  END IF;
END $$;

ALTER TABLE "Station" DROP CONSTRAINT IF EXISTS "Station_type_check";
ALTER TABLE "Station" ADD CONSTRAINT "Station_type_check" CHECK ("type" IN ('ROASTING', 'QUALITY', 'PACKAGING', 'ORDERS_BOARD'));

COMMIT;
