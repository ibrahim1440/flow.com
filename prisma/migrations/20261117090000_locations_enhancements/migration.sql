-- Stock locations, round 2 («تحسينات المواقع») — the owner's decisions after batch seventeen. ADDITIVE ONLY, one
-- transaction (PostgreSQL 16 / 17). The one enum value is added IF NOT EXISTS and not used before COMMIT.
--
--   1. In-transit stock («في الطريق») for two-step transfers (send → in transit → receive). ONE system location
--      "loc_transit" (type TRANSIT, «في الطريق»): what has been sent and not yet received sits there as an ordinary
--      "StockBalance" (green coffee, materials) or as a finished lot located there with status IN_TRANSIT — so every
--      existing invariant holds unchanged (Σ balances = the company total; check 45) and in-transit stock counts in the
--      company totals and valuation. Which transfer it belongs to is on the transfer's lines. Exactly one TRANSIT
--      location (partial unique index), never the default / production site, never inactive, never deleted, never
--      re-typed (CHECK + trigger stock_location_transit_guard; the migration asserts it exists). The application never
--      offers it as a site. stock_location_guard (20261115090000) is replaced in place: a site is not deactivated while
--      an IN_TRANSIT transfer names it as source or destination.
--      "StockLocation_type_check" WIDENED (DROP + ADD) by 'TRANSIT'.
--   2. "StockTransfer": "mode" (IMMEDIATE — the one-step «تحويل فوري», every existing row — | TWO_STEP), the statuses
--      WIDENED (DROP + ADD) by IN_TRANSIT and RECEIVED (IMMEDIATE: POSTED | CANCELLED; TWO_STEP: IN_TRANSIT | RECEIVED |
--      CANCELLED), "sentAt" and the receipt ("receivedAt", "receivedBy", "receivedByName", "receiveNote").
--      "StockTransferLine": "itemKind" WIDENED by 'FG_LOT' (a finished-goods lot; "qty" in units), "qtyReceived" and
--      "qtyShort" (a partial receipt: the shortfall, written off as a transit loss with "varianceReason"), "fgLotId"
--      (the lot that travels — the source lot moved whole, or the part split off it).
--   3. "LotStatus" + 'IN_TRANSIT' (a finished lot on its way: every path that promises or ships requires AVAILABLE).
--      "FinishedGoodsLot"."splitFromLotId" (FK RESTRICT to the lot a transfer split it from — traceability to the source
--      lot and, through it, the roast).
--   4. "StockReorderPoint" (new): a reorder point per item per location (green lots, materials — and finished SKUs, in
--      units: the owner's decision before release), set in each item's / SKU's settings; «تحت حد إعادة الطلب» is evaluated
--      per location (a SKU: its AVAILABLE units at that site); the company-wide reorder point stays.
--   5. "Roaster"."locationId" and "Station"."locationId" (nullable FK RESTRICT): where a roaster / a workstation draws
--      from and books into; NULL = the production site (isProduction stays the fallback).
--   6. Inventory › transfer_send / transfer_receive / transfer_cancel — the transfer duties as their own permissions,
--      written true to every stored permission document (accounts, role templates) that holds today's equivalent —
--      send / receive: inventory › receive or adjust; cancel: inventory › adjust — so nobody loses access.
--   7. The two label profiles the owner approved, as the defaults: «ملصق كيس البن الأخضر» on the 100 × 70 mm thermal roll
--      and «ملصق رف» on 50 × 30 mm. The print dialog picks them by "presetKey" (THERMAL_100x70 / COMPACT_50x30); this
--      makes sure both preset profiles exist with exactly those sizes — inserted if missing (same ids and values as
--      20261016150000_print_system), repaired if a row with that key drifted. Idempotent.
--   8. The runtime role (flowcom_app), when it exists, is granted the new table and functions.
-- Row counts touched: 1 "StockLocation" row inserted; permission documents (a few) rewritten for the three keys; 0–2
-- preset profiles inserted or repaired; no stock row changes.
-- Rollback: docs/hr/migration-review/rollback-20261117090000_locations_enhancements.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "StockLocation" DROP CONSTRAINT "StockLocation_type_check";
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_type_check" CHECK ("type" IN ('ROASTERY', 'WAREHOUSE', 'CAFE', 'BRANCH', 'OTHER', 'TRANSIT'));
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_transit_check" CHECK ("type" <> 'TRANSIT' OR (NOT "isDefault" AND NOT "isProduction" AND "isActive"));
CREATE UNIQUE INDEX "StockLocation_one_transit" ON "StockLocation" ("type") WHERE "type" = 'TRANSIT';
INSERT INTO "StockLocation" ("id", "code", "nameAr", "nameEn", "type", "isDefault", "isProduction", "sortOrder", "notes", "createdBy", "updatedBy")
VALUES ('loc_transit', 'TRANSIT', 'في الطريق', 'In transit', 'TRANSIT', false, false, 999,
        'موقع النظام للبضاعة المرسلة ولم تُستلم بعد (تحويل على خطوتين).', 'migration', 'migration')
ON CONFLICT DO NOTHING;

-- The transit location must exist now (council F3): an id / code taken by another row would have made the insert above
-- do nothing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "StockLocation" WHERE "id" = 'loc_transit' AND "type" = 'TRANSIT') THEN
    RAISE EXCEPTION 'loc_transit (type TRANSIT) is missing: a location already uses the id loc_transit or the code TRANSIT — rename it, then apply again';
  END IF;
END $$;

-- A site is not deactivated while a transfer on its way names it (council F2): its goods could neither arrive nor
-- return. stock_location_guard (20261115090000) replaced in place with that one more refusal.
CREATE OR REPLACE FUNCTION stock_location_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE refs text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."isDefault" THEN
      RAISE EXCEPTION 'STOCK_LOCATION_DEFAULT|%|%', OLD."id", OLD."nameAr" USING ERRCODE = 'P0001';
    END IF;
    IF OLD."isProduction" THEN
      RAISE EXCEPTION 'STOCK_LOCATION_PRODUCTION|%|%', OLD."id", OLD."nameAr" USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."isActive" AND NOT NEW."isActive" THEN
    IF OLD."isDefault" OR NEW."isDefault" THEN
      RAISE EXCEPTION 'STOCK_LOCATION_DEFAULT|%|%', OLD."id", OLD."nameAr" USING ERRCODE = 'P0001';
    END IF;
    IF OLD."isProduction" OR NEW."isProduction" THEN
      RAISE EXCEPTION 'STOCK_LOCATION_PRODUCTION|%|%', OLD."id", OLD."nameAr" USING ERRCODE = 'P0001';
    END IF;
    PERFORM 1 FROM "StockLocation" WHERE "id" = OLD."id" FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "StockBalance" WHERE "locationId" = OLD."id" AND "qty" > 0.0000005)
       OR EXISTS (SELECT 1 FROM "FinishedGoodsLot" WHERE "locationId" = OLD."id" AND ("unitsAvailable" > 0 OR "unitsReserved" > 0 OR "availableQty" > 0 OR "reservedQty" > 0)) THEN
      RAISE EXCEPTION 'STOCK_LOCATION_HOLDS_STOCK|%|%', OLD."id", OLD."nameAr" USING ERRCODE = 'P0001';
    END IF;
    SELECT string_agg('TR-' || lpad("number"::text, 5, '0'), ', ' ORDER BY "number") INTO refs
      FROM "StockTransfer" WHERE "status" = 'IN_TRANSIT' AND OLD."id" IN ("fromLocationId", "toLocationId");
    IF refs IS NOT NULL THEN
      RAISE EXCEPTION 'STOCK_LOCATION_IN_TRANSIT|%|%|%', OLD."id", OLD."nameAr", refs USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION stock_location_transit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."type" = 'TRANSIT' THEN
      RAISE EXCEPTION 'STOCK_LOCATION_TRANSIT|%|%', OLD."id", OLD."nameAr" USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF (OLD."type" = 'TRANSIT') <> (NEW."type" = 'TRANSIT') THEN
    RAISE EXCEPTION 'STOCK_LOCATION_TRANSIT|%|%', OLD."id", OLD."nameAr" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_location_transit_guard BEFORE UPDATE OR DELETE ON "StockLocation" FOR EACH ROW EXECUTE FUNCTION stock_location_transit_guard();

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "StockTransfer" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'IMMEDIATE';
ALTER TABLE "StockTransfer" ADD COLUMN "sentAt" TIMESTAMP(3);
ALTER TABLE "StockTransfer" ADD COLUMN "receivedAt" TIMESTAMP(3);
ALTER TABLE "StockTransfer" ADD COLUMN "receivedBy" TEXT;
ALTER TABLE "StockTransfer" ADD COLUMN "receivedByName" TEXT;
ALTER TABLE "StockTransfer" ADD COLUMN "receiveNote" TEXT;
ALTER TABLE "StockTransfer" DROP CONSTRAINT "StockTransfer_status_check";
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_status_check" CHECK ("status" IN ('POSTED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'));
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_mode_check" CHECK (
  ("mode" = 'IMMEDIATE' AND "status" IN ('POSTED', 'CANCELLED'))
  OR ("mode" = 'TWO_STEP' AND "status" IN ('IN_TRANSIT', 'RECEIVED', 'CANCELLED') AND "sentAt" IS NOT NULL));
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_received_check" CHECK (
  ("status" = 'RECEIVED') = ("receivedAt" IS NOT NULL AND "receivedBy" IS NOT NULL)
  AND ("receiveNote" IS NULL OR char_length("receiveNote") <= 500));
CREATE INDEX "StockTransfer_status_idx" ON "StockTransfer"("status");

ALTER TABLE "StockTransferLine" ADD COLUMN "qtyReceived" DOUBLE PRECISION;
ALTER TABLE "StockTransferLine" ADD COLUMN "qtyShort" DOUBLE PRECISION;
ALTER TABLE "StockTransferLine" ADD COLUMN "varianceReason" TEXT;
ALTER TABLE "StockTransferLine" ADD COLUMN "fgLotId" TEXT;
ALTER TABLE "StockTransferLine" DROP CONSTRAINT "StockTransferLine_itemKind_check";
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_itemKind_check" CHECK ("itemKind" IN ('GREEN_BEAN', 'MATERIAL', 'FG_LOT'));
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_receipt_check" CHECK (
  ("qtyReceived" IS NULL OR ("qtyReceived" >= 0 AND "qtyReceived" <= "qty" + 0.0000005))
  AND ("qtyShort" IS NULL OR ("qtyShort" > 0 AND "qtyReceived" IS NOT NULL AND char_length(btrim(coalesce("varianceReason", ''))) >= 3))
  AND ("varianceReason" IS NULL OR char_length("varianceReason") <= 300)
  AND (("itemKind" = 'FG_LOT') = ("fgLotId" IS NOT NULL)));
CREATE INDEX "StockTransferLine_fgLotId_idx" ON "StockTransferLine"("fgLotId");

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TYPE "LotStatus" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';
ALTER TABLE "FinishedGoodsLot" ADD COLUMN "splitFromLotId" TEXT;
CREATE INDEX "FinishedGoodsLot_splitFromLotId_idx" ON "FinishedGoodsLot"("splitFromLotId");
ALTER TABLE "FinishedGoodsLot" ADD CONSTRAINT "FinishedGoodsLot_splitFromLotId_fkey" FOREIGN KEY ("splitFromLotId") REFERENCES "FinishedGoodsLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_fgLotId_fkey" FOREIGN KEY ("fgLotId") REFERENCES "FinishedGoodsLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "StockReorderPoint" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "itemKind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reorderPoint" DOUBLE PRECISION NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockReorderPoint_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockReorderPoint_itemKind_check" CHECK ("itemKind" IN ('GREEN_BEAN', 'MATERIAL', 'PRODUCT_SKU')),
    CONSTRAINT "StockReorderPoint_value_check" CHECK ("reorderPoint" >= 0 AND "reorderPoint" < 1000000000)
);
CREATE UNIQUE INDEX "StockReorderPoint_locationId_itemKind_entityId_key" ON "StockReorderPoint"("locationId", "itemKind", "entityId");
CREATE INDEX "StockReorderPoint_itemKind_entityId_idx" ON "StockReorderPoint"("itemKind", "entityId");
ALTER TABLE "StockReorderPoint" ADD CONSTRAINT "StockReorderPoint_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "StockReorderPoint" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- 5 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Roaster" ADD COLUMN "locationId" TEXT;
CREATE INDEX "Roaster_locationId_idx" ON "Roaster"("locationId");
ALTER TABLE "Roaster" ADD CONSTRAINT "Roaster_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Station" ADD COLUMN "locationId" TEXT;
CREATE INDEX "Station_locationId_idx" ON "Station"("locationId");
ALTER TABLE "Station" ADD CONSTRAINT "Station_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE r record; p jsonb; inv boolean; rcv boolean; adj boolean; changed boolean;
BEGIN
  FOR r IN SELECT 'Employee' AS t, "id", "permissions" FROM "Employee" UNION ALL SELECT 'AccessRole', "id", "permissions" FROM "AccessRole" LOOP
    BEGIN
      p := r."permissions"::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;  -- not JSON: left as it is (the application reads it as no access)
    END;
    IF jsonb_typeof(p) <> 'object' THEN CONTINUE; END IF;
    inv := coalesce(p #>> '{inventory,access}', 'none') <> 'none';
    rcv := coalesce(p #>> '{inventory,sub,receive}', 'false') = 'true';
    adj := coalesce(p #>> '{inventory,sub,adjust}', 'false') = 'true';
    IF NOT inv OR NOT (rcv OR adj) THEN CONTINUE; END IF;
    IF jsonb_typeof(p #> '{inventory,sub}') IS DISTINCT FROM 'object' THEN CONTINUE; END IF;
    changed := false;
    IF coalesce(p #>> '{inventory,sub,transfer_send}', '') = '' THEN p := jsonb_set(p, '{inventory,sub,transfer_send}', 'true'::jsonb, true); changed := true; END IF;
    IF coalesce(p #>> '{inventory,sub,transfer_receive}', '') = '' THEN p := jsonb_set(p, '{inventory,sub,transfer_receive}', 'true'::jsonb, true); changed := true; END IF;
    IF adj AND coalesce(p #>> '{inventory,sub,transfer_cancel}', '') = '' THEN p := jsonb_set(p, '{inventory,sub,transfer_cancel}', 'true'::jsonb, true); changed := true; END IF;
    IF NOT changed THEN CONTINUE; END IF;
    IF r.t = 'Employee' THEN UPDATE "Employee" SET "permissions" = p::text WHERE "id" = r."id";
    ELSE UPDATE "AccessRole" SET "permissions" = p::text WHERE "id" = r."id"; END IF;
  END LOOP;
END $$;

-- 7 ─────────────────────────────────────────────────────────────────────────────────────────────
INSERT INTO "PrintProfile" ("id", "name", "kind", "paperWidthMm", "paperHeightMm", "labelWidthMm", "labelHeightMm",
  "marginTopMm", "marginLeftMm", "marginRightMm", "marginBottomMm", "gapXMm", "gapYMm", "columns", "rows", "orientation", "scalePct", "dpi",
  "offsetXMm", "offsetYMm", "defaultStartSlot", "defaultCopies", "isPreset", "presetKey", "createdAt", "updatedAt")
VALUES
  ('print_preset_thermal', 'Thermal roll 100 × 70', 'THERMAL_ROLL', 100, 70, 100, 70, 0, 0, 0, 0, 0, 3, 1, 1, 'PORTRAIT', 100, 203, 0, 0, 1, 1, true, 'THERMAL_100x70', now(), now()),
  ('print_preset_compact', 'Thermal roll 50 × 30', 'THERMAL_ROLL', 50, 30, 50, 30, 0, 0, 0, 0, 0, 3, 1, 1, 'PORTRAIT', 100, 203, 0, 0, 1, 1, true, 'COMPACT_50x30', now(), now())
ON CONFLICT DO NOTHING;
UPDATE "PrintProfile" SET "kind" = 'THERMAL_ROLL', "paperWidthMm" = 100, "paperHeightMm" = 70, "labelWidthMm" = 100, "labelHeightMm" = 70,
       "columns" = 1, "rows" = 1, "isPreset" = true, "updatedAt" = now()
 WHERE "presetKey" = 'THERMAL_100x70'
   AND ("kind", "paperWidthMm", "paperHeightMm", "labelWidthMm", "labelHeightMm", "columns", "rows", "isPreset")
       IS DISTINCT FROM ('THERMAL_ROLL', 100::double precision, 70::double precision, 100::double precision, 70::double precision, 1, 1, true);
UPDATE "PrintProfile" SET "kind" = 'THERMAL_ROLL', "paperWidthMm" = 50, "paperHeightMm" = 30, "labelWidthMm" = 50, "labelHeightMm" = 30,
       "columns" = 1, "rows" = 1, "isPreset" = true, "updatedAt" = now()
 WHERE "presetKey" = 'COMPACT_50x30'
   AND ("kind", "paperWidthMm", "paperHeightMm", "labelWidthMm", "labelHeightMm", "columns", "rows", "isPreset")
       IS DISTINCT FROM ('THERMAL_ROLL', 50::double precision, 30::double precision, 50::double precision, 30::double precision, 1, 1, true);

-- 8 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "StockReorderPoint" TO flowcom_app;
    GRANT EXECUTE ON FUNCTION stock_location_transit_guard() TO flowcom_app;
  END IF;
END $$;

COMMIT;
