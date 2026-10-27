-- Unified inventory, phase 3 — stock locations («المواقع»). ADDITIVE ONLY, one transaction (PostgreSQL 16 / 17).
-- A location says WHERE stock is (phase 1's categories say WHAT it is). Valuation stays company-wide: the moving-average
-- cost ledger ("CostItem" / "CostMove") stays per item, never per location.
--
--   1. "StockLocation" (new, seeded with the three sites the owner named — all editable, none hard-coded in the
--      application): «مصنع التحميص» (ROASTERY, the default receiving site), «المستودع» (WAREHOUSE), «المقهى» (CAFE).
--      Exactly ONE default receiving site and exactly ONE production site («isProduction»: roasting draws green there,
--      packing draws materials and makes finished lots there; seeded on the plant) — partial unique indexes + a deferred
--      check; both are active; an inactive site holds no stock (trigger stock_location_guard). Never deleted while
--      anything references it (every reference is ON DELETE RESTRICT).
--   2. stock_location_current(): the "where" of the current transaction — the transaction-local setting
--      hiqbah.stock_location (set by the application's location-aware services, each restoring the previous value), or
--      the PRODUCTION site — never the receiving default, so changing where new receipts go moves no other writer. It is
--      the column default of every new location column: a writer that knows nothing of locations (an older code path, a
--      test fixture, raw SQL) books at the production site. Every application writer of a total names its site.
--   3. "StockBalance" (new): the quantity of a green lot / a material AT a location. The company-wide totals stay
--      where they are ("GreenBean"."quantityKg", "MaterialItem"."quantityOnHand") and every existing writer keeps
--      writing them. ONE place keeps the two equal: trigger stock_balance_sync on the two totals routes each change
--      of a total to the current location's balance (refusing, STOCK_LOCATION_SHORT, a decrease that location
--      cannot cover), and the deferred constraint trigger stock_balance_total_check refuses any commit where
--      Σ balances ≠ total (a transfer moves balances only; a deleted balance is checked too). Verifier check 43.
--      "StockBalance" is written ONLY by that trigger and by the transfer / location services: a BEFORE trigger refuses any
--      write without the transaction-local writer setting (hiqbah.stock_balance_writer = 'sync' | 'service'), so a direct
--      UPDATE (the runtime role included) cannot change a balance. The four new tables are in the accounting audit
--      (ledger_audit_row: who, when, before / after).
--   4. "SourceDocType" + 'STOCK_TRANSFER' (ADD VALUE IF NOT EXISTS; not used before COMMIT).
--   5. "StockTransfer" / "StockTransferLine" (new): the transfer document («تحويل مخزون»), one-step (POSTED) or
--      CANCELLED; its movements carry its id.
--   6. Location columns, NOT NULL with the constant default 'loc_roastery' while they are added (every existing row
--      — stock movements, finished lots, receipts, count sessions, deliveries — is the roasting plant's: a metadata-only
--      back-fill, no row rewritten, no trigger fired), then the default becomes stock_location_current():
--      "InventoryMovement"."locationId" (+ "counterpartLocationId", "transferId" for transfers),
--      "FinishedGoodsLot"."locationId", "PurchaseRecord"."locationId", "InventoryCountSession"."locationId",
--      "Delivery"."locationId"; and "SupplierInvoice"."receivingLocationId" (nullable: the invoice's «موقع الاستلام»).
--   7. Back-fill of the balances: every green lot / material with stock gets one balance at «مصنع التحميص» equal to its
--      total (idempotent: ON CONFLICT DO NOTHING). A negative total stops the migration with its ids (preflight 29).
--   8. The runtime role (flowcom_app), when it exists, is granted the new tables and functions
--      (scripts/release/grant-app-runtime.sql grants them again on every deploy).
-- Row counts touched: 3 "StockLocation" rows and one "StockBalance" row per green lot / material holding stock
-- inserted; no existing row is updated.
-- Rollback: docs/hr/migration-review/rollback-20261115090000_stock_locations.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "StockLocation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "type" TEXT NOT NULL,
    "address" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isProduction" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedBy" TEXT,
    "deactivationReason" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockLocation_type_check" CHECK ("type" IN ('ROASTERY', 'WAREHOUSE', 'CAFE', 'BRANCH', 'OTHER')),
    CONSTRAINT "StockLocation_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
    CONSTRAINT "StockLocation_nameAr_check" CHECK (char_length(btrim("nameAr")) BETWEEN 1 AND 80),
    CONSTRAINT "StockLocation_nameEn_check" CHECK ("nameEn" IS NULL OR char_length(btrim("nameEn")) BETWEEN 1 AND 80),
    CONSTRAINT "StockLocation_text_check" CHECK (("address" IS NULL OR char_length("address") <= 300) AND ("notes" IS NULL OR char_length("notes") <= 500)),
    -- Active ⇔ no deactivation stamp; an inactive site says who closed it and why; the default site is active.
    CONSTRAINT "StockLocation_active_check" CHECK (
      ("isActive" = ("deactivatedAt" IS NULL))
      AND ("isActive" OR ("deactivatedBy" IS NOT NULL AND char_length(btrim(coalesce("deactivationReason", ''))) >= 3))
      AND (NOT "isDefault" OR "isActive") AND (NOT "isProduction" OR "isActive"))
);
CREATE UNIQUE INDEX "StockLocation_code_key" ON "StockLocation"("code");
CREATE INDEX "StockLocation_isActive_sortOrder_idx" ON "StockLocation"("isActive", "sortOrder");
-- At most one default (the deferred check below makes it exactly one).
CREATE UNIQUE INDEX "StockLocation_one_default" ON "StockLocation" ("isDefault") WHERE "isDefault";
CREATE UNIQUE INDEX "StockLocation_one_production" ON "StockLocation" ("isProduction") WHERE "isProduction";

INSERT INTO "StockLocation" ("id", "code", "nameAr", "nameEn", "type", "isDefault", "isProduction", "sortOrder", "createdBy", "updatedBy") VALUES
  ('loc_roastery',  'RST',  'مصنع التحميص', 'Roasting plant', 'ROASTERY',  true,  true,  1, 'migration', 'migration'),
  ('loc_warehouse', 'WH',   'المستودع',     'Warehouse',      'WAREHOUSE', false, false, 2, 'migration', 'migration'),
  ('loc_cafe',      'CAFE', 'المقهى',       'Café',           'CAFE',      false, false, 3, 'migration', 'migration');

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION stock_location_current() RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE v text := nullif(current_setting('hiqbah.stock_location', true), '');
        d text;
BEGIN
  IF v IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "StockLocation" WHERE "id" = v) THEN
      RAISE EXCEPTION 'STOCK_LOCATION_UNKNOWN: the stock location % does not exist', v USING ERRCODE = 'P0001';
    END IF;
    RETURN v;
  END IF;
  -- The production site, never the receiving default (changing the default moves only where new receipts go).
  SELECT "id" INTO d FROM "StockLocation" WHERE "isProduction" LIMIT 1;
  IF d IS NULL THEN
    RAISE EXCEPTION 'STOCK_LOCATION_NO_PRODUCTION: no production stock location is set' USING ERRCODE = 'P0001';
  END IF;
  RETURN d;
END $$;

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "StockBalance" (
    "locationId" TEXT NOT NULL,
    "itemKind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("locationId", "itemKind", "entityId"),
    CONSTRAINT "StockBalance_itemKind_check" CHECK ("itemKind" IN ('GREEN_BEAN', 'MATERIAL')),
    CONSTRAINT "StockBalance_qty_check" CHECK ("qty" >= 0 AND "qty" < 'Infinity'::double precision)
);
CREATE INDEX "StockBalance_itemKind_entityId_idx" ON "StockBalance"("itemKind", "entityId");
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TYPE "SourceDocType" ADD VALUE IF NOT EXISTS 'STOCK_TRANSFER';

-- 5 ─────────────────────────────────────────────────────────────────────────────────────────────
-- "number" (TRF-…) comes from a sequence: a transfer refused or rolled back still used its number, so the series can have
-- gaps. A transfer is an internal stock document, not a fiscal one (no gap-free numbering rule applies).
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "transferDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "notes" TEXT,
    "requestKey" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdByName" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelledByName" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockTransfer_status_check" CHECK ("status" IN ('POSTED', 'CANCELLED')),
    CONSTRAINT "StockTransfer_sites_check" CHECK ("fromLocationId" <> "toLocationId"),
    CONSTRAINT "StockTransfer_cancel_check" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancelledBy" IS NOT NULL AND char_length(btrim(coalesce("cancelReason", ''))) >= 3)),
    CONSTRAINT "StockTransfer_notes_check" CHECK ("notes" IS NULL OR char_length("notes") <= 500)
);
CREATE UNIQUE INDEX "StockTransfer_number_key" ON "StockTransfer"("number");
CREATE UNIQUE INDEX "StockTransfer_requestKey_key" ON "StockTransfer"("requestKey");
CREATE INDEX "StockTransfer_transferDate_idx" ON "StockTransfer"("transferDate");
CREATE INDEX "StockTransfer_fromLocationId_idx" ON "StockTransfer"("fromLocationId");
CREATE INDEX "StockTransfer_toLocationId_idx" ON "StockTransfer"("toLocationId");
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StockTransferLine" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemKind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,

    CONSTRAINT "StockTransferLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockTransferLine_itemKind_check" CHECK ("itemKind" IN ('GREEN_BEAN', 'MATERIAL')),
    CONSTRAINT "StockTransferLine_qty_check" CHECK ("qty" > 0 AND "qty" < 'Infinity'::double precision)
);
CREATE UNIQUE INDEX "StockTransferLine_transferId_lineNo_key" ON "StockTransferLine"("transferId", "lineNo");
CREATE INDEX "StockTransferLine_itemKind_entityId_idx" ON "StockTransferLine"("itemKind", "entityId");
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "InventoryMovement" ADD COLUMN "locationId" TEXT NOT NULL DEFAULT 'loc_roastery';
ALTER TABLE "InventoryMovement" ALTER COLUMN "locationId" SET DEFAULT stock_location_current();
ALTER TABLE "InventoryMovement" ADD COLUMN "counterpartLocationId" TEXT;
ALTER TABLE "InventoryMovement" ADD COLUMN "transferId" TEXT;
CREATE INDEX "InventoryMovement_locationId_timestamp_idx" ON "InventoryMovement"("locationId", "timestamp");
CREATE INDEX "InventoryMovement_transferId_idx" ON "InventoryMovement"("transferId");
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_counterpartLocationId_fkey" FOREIGN KEY ("counterpartLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_transfer_check" CHECK (("transferId" IS NULL) = ("counterpartLocationId" IS NULL) AND ("counterpartLocationId" IS NULL OR "counterpartLocationId" <> "locationId"));

ALTER TABLE "FinishedGoodsLot" ADD COLUMN "locationId" TEXT NOT NULL DEFAULT 'loc_roastery';
ALTER TABLE "FinishedGoodsLot" ALTER COLUMN "locationId" SET DEFAULT stock_location_current();
CREATE INDEX "FinishedGoodsLot_locationId_idx" ON "FinishedGoodsLot"("locationId");
ALTER TABLE "FinishedGoodsLot" ADD CONSTRAINT "FinishedGoodsLot_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseRecord" ADD COLUMN "locationId" TEXT NOT NULL DEFAULT 'loc_roastery';
ALTER TABLE "PurchaseRecord" ALTER COLUMN "locationId" SET DEFAULT stock_location_current();
CREATE INDEX "PurchaseRecord_locationId_idx" ON "PurchaseRecord"("locationId");
ALTER TABLE "PurchaseRecord" ADD CONSTRAINT "PurchaseRecord_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryCountSession" ADD COLUMN "locationId" TEXT NOT NULL DEFAULT 'loc_roastery';
ALTER TABLE "InventoryCountSession" ALTER COLUMN "locationId" SET DEFAULT stock_location_current();
CREATE INDEX "InventoryCountSession_locationId_idx" ON "InventoryCountSession"("locationId");
ALTER TABLE "InventoryCountSession" ADD CONSTRAINT "InventoryCountSession_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Delivery" ADD COLUMN "locationId" TEXT NOT NULL DEFAULT 'loc_roastery';
ALTER TABLE "Delivery" ALTER COLUMN "locationId" SET DEFAULT stock_location_current();
CREATE INDEX "Delivery_locationId_idx" ON "Delivery"("locationId");
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierInvoice" ADD COLUMN "receivingLocationId" TEXT;
CREATE INDEX "SupplierInvoice_receivingLocationId_idx" ON "SupplierInvoice"("receivingLocationId");
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_receivingLocationId_fkey" FOREIGN KEY ("receivingLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(x, ', ') INTO bad FROM (
    SELECT 'GreenBean ' || "id" AS x FROM "GreenBean" WHERE NOT ("quantityKg" >= 0 AND "quantityKg" < 'Infinity'::double precision)
    UNION ALL SELECT 'MaterialItem ' || "id" FROM "MaterialItem" WHERE NOT ("quantityOnHand" >= 0 AND "quantityOnHand" < 'Infinity'::double precision)) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'negative or invalid stock totals: % — correct them with a count before applying 20261115090000_stock_locations', bad;
  END IF;
END $$;
-- (One atomic block: the balance writer setting and the audit actor live only inside it. The guards are created below,
-- so the setting is for a re-run of this block after them — idempotent either way.)
DO $$
BEGIN
  PERFORM set_config('hiqbah.stock_balance_writer', 'sync', true),
          set_config('hiqbah.actor_id', 'migration:20261115090000_stock_locations', true);
  INSERT INTO "StockBalance" ("locationId", "itemKind", "entityId", "qty")
    SELECT 'loc_roastery', 'GREEN_BEAN', "id", "quantityKg" FROM "GreenBean" WHERE "quantityKg" > 0
    ON CONFLICT DO NOTHING;
  INSERT INTO "StockBalance" ("locationId", "itemKind", "entityId", "qty")
    SELECT 'loc_roastery', 'MATERIAL', "id", "quantityOnHand" FROM "MaterialItem" WHERE "quantityOnHand" > 0
    ON CONFLICT DO NOTHING;
  PERFORM set_config('hiqbah.stock_balance_writer', '', true);
END $$;

-- 3 (the one place) ─────────────────────────────────────────────────────────────────────────────
-- A change of a company-wide total goes to the current location's balance. The new balance there is the new total
-- minus what the other locations hold (so a single-location item is always exactly its total); a decrease the location
-- cannot cover is refused with its figures (the application shows «الرصيد في هذا الموقع لا يكفي» and offers a transfer).
-- A lot / material deleted takes its balances with it (they have no foreign key: like the movements, entityId is untyped).
CREATE OR REPLACE FUNCTION stock_balance_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text := CASE TG_TABLE_NAME WHEN 'GreenBean' THEN 'GREEN_BEAN' ELSE 'MATERIAL' END;
        newq double precision; oldq double precision;
        loc text; others double precision; here double precision; target double precision;
        lname text;
        writer text := coalesce(current_setting('hiqbah.stock_balance_writer', true), '');
BEGIN
  -- This trigger is one of the two writers "StockBalance" accepts (stock_balance_guard); the setting before is restored.
  PERFORM set_config('hiqbah.stock_balance_writer', 'sync', true);
  IF TG_OP = 'DELETE' THEN
    DELETE FROM "StockBalance" WHERE "itemKind" = k AND "entityId" = OLD."id";
    PERFORM set_config('hiqbah.stock_balance_writer', writer, true);
    RETURN OLD;
  END IF;
  -- A new lot / material has no balance yet: anything left under its id (a row deleted with triggers off) goes.
  IF TG_OP = 'INSERT' THEN
    DELETE FROM "StockBalance" WHERE "itemKind" = k AND "entityId" = NEW."id";
  END IF;
  oldq := 0;
  IF k = 'GREEN_BEAN' THEN
    newq := NEW."quantityKg";
    IF TG_OP = 'UPDATE' THEN oldq := OLD."quantityKg"; END IF;
  ELSE
    newq := NEW."quantityOnHand";
    IF TG_OP = 'UPDATE' THEN oldq := OLD."quantityOnHand"; END IF;
  END IF;
  IF newq IS NOT DISTINCT FROM oldq THEN
    PERFORM set_config('hiqbah.stock_balance_writer', writer, true);
    RETURN NEW;
  END IF;
  loc := stock_location_current();
  -- Serialise with the location's deactivation (which takes FOR UPDATE: it waits for this, and this for it) — KEY SHARE
  -- so a rename or a reorder (no key change) never queues stock work; read the balances of this item under lock.
  SELECT "nameAr" INTO lname FROM "StockLocation" WHERE "id" = loc FOR KEY SHARE;
  PERFORM 1 FROM "StockBalance" WHERE "itemKind" = k AND "entityId" = NEW."id" FOR UPDATE;
  SELECT coalesce(sum("qty") FILTER (WHERE "locationId" <> loc), 0), coalesce(sum("qty") FILTER (WHERE "locationId" = loc), 0)
    INTO others, here FROM "StockBalance" WHERE "itemKind" = k AND "entityId" = NEW."id";
  target := newq - others;
  IF target < -0.0000005 THEN
    RAISE EXCEPTION 'STOCK_LOCATION_SHORT|%|%|%|%|%|%', loc, lname, here, here - target, k, NEW."id"
      USING ERRCODE = 'P0001', HINT = 'The stock is at another location: transfer it first.';
  END IF;
  IF target < 0 THEN target := 0; END IF;
  INSERT INTO "StockBalance" ("locationId", "itemKind", "entityId", "qty", "updatedAt") VALUES (loc, k, NEW."id", target, now())
    ON CONFLICT ("locationId", "itemKind", "entityId") DO UPDATE SET "qty" = EXCLUDED."qty", "updatedAt" = now();
  PERFORM set_config('hiqbah.stock_balance_writer', writer, true);
  RETURN NEW;
END $$;
CREATE TRIGGER stock_balance_sync AFTER INSERT OR UPDATE OF "quantityKg" OR DELETE ON "GreenBean" FOR EACH ROW EXECUTE FUNCTION stock_balance_sync();
CREATE TRIGGER stock_balance_sync AFTER INSERT OR UPDATE OF "quantityOnHand" OR DELETE ON "MaterialItem" FOR EACH ROW EXECUTE FUNCTION stock_balance_sync();

-- Only the two writers write a balance: stock_balance_sync ('sync') and the transfer / location services ('service',
-- src/lib/services/stock-locations.ts withBalanceWriter) — a direct INSERT / UPDATE / DELETE, the runtime role's
-- included, is refused. And a balance never rises at an inactive location (a closed site receives nothing).
CREATE OR REPLACE FUNCTION stock_balance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active boolean; lname text; before double precision := 0;
BEGIN
  IF coalesce(current_setting('hiqbah.stock_balance_writer', true), '') NOT IN ('sync', 'service') THEN
    RAISE EXCEPTION 'STOCK_BALANCE_DIRECT_WRITE: a location balance changes only with its total (stock_balance_sync) or by a transfer (%)', TG_OP USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' THEN before := OLD."qty"; END IF;
  IF NEW."qty" > before THEN
    SELECT "isActive", "nameAr" INTO active, lname FROM "StockLocation" WHERE "id" = NEW."locationId" FOR KEY SHARE;
    IF NOT coalesce(active, false) THEN
      RAISE EXCEPTION 'STOCK_LOCATION_INACTIVE|%|%', NEW."locationId", lname USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_balance_guard BEFORE INSERT OR UPDATE OR DELETE ON "StockBalance" FOR EACH ROW EXECUTE FUNCTION stock_balance_guard();

-- At commit: Σ balances of the item = its company-wide total (to a millionth). A transfer that moves stock between
-- two locations leaves the total as it is; anything else that changes a balance without its total is refused — an
-- INSERT, an UPDATE or a DELETE of a balance alike.
CREATE OR REPLACE FUNCTION stock_balance_total_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; e text; total double precision; s double precision;
BEGIN
  IF TG_OP = 'DELETE' THEN k := OLD."itemKind"; e := OLD."entityId"; ELSE k := NEW."itemKind"; e := NEW."entityId"; END IF;
  IF k = 'GREEN_BEAN' THEN SELECT "quantityKg" INTO total FROM "GreenBean" WHERE "id" = e;
  ELSE SELECT "quantityOnHand" INTO total FROM "MaterialItem" WHERE "id" = e; END IF;
  IF total IS NULL THEN RETURN NULL; END IF;  -- the item was deleted in this transaction (its balances with it)
  SELECT coalesce(sum("qty"), 0) INTO s FROM "StockBalance" WHERE "itemKind" = k AND "entityId" = e;
  IF abs(s - total) > 0.000001 THEN
    RAISE EXCEPTION 'STOCK_BALANCE_MISMATCH: % % — the locations hold %, the total is %', k, e, s, total USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER stock_balance_total_check AFTER INSERT OR UPDATE OR DELETE ON "StockBalance" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_balance_total_check();

-- 1 (guards) ─────────────────────────────────────────────────────────────────────────────────────
-- A location is deactivated only when it holds nothing (no green / material balance above the quantity tolerance, no
-- finished stock) and is neither the default receiving site nor the production site; neither of those is deleted; a
-- location's history keeps it (every reference is RESTRICT). A deactivation takes the row FOR UPDATE (here, whatever
-- the writer), which waits for — and is waited for by — the stock writers' KEY SHARE.
CREATE OR REPLACE FUNCTION stock_location_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    -- The strong row lock (FOR UPDATE conflicts with the stock writers' KEY SHARE; this UPDATE alone does not): wait for
    -- any stock change booked here to commit, and keep new ones out, before looking at what the site holds.
    PERFORM 1 FROM "StockLocation" WHERE "id" = OLD."id" FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "StockBalance" WHERE "locationId" = OLD."id" AND "qty" > 0.0000005)
       OR EXISTS (SELECT 1 FROM "FinishedGoodsLot" WHERE "locationId" = OLD."id" AND ("unitsAvailable" > 0 OR "unitsReserved" > 0 OR "availableQty" > 0 OR "reservedQty" > 0)) THEN
      RAISE EXCEPTION 'STOCK_LOCATION_HOLDS_STOCK|%|%', OLD."id", OLD."nameAr" USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_location_guard BEFORE UPDATE OR DELETE ON "StockLocation" FOR EACH ROW EXECUTE FUNCTION stock_location_guard();

-- At commit: exactly one default receiving location and exactly one production location (changing either is two
-- updates in one transaction).
CREATE OR REPLACE FUNCTION stock_location_default_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM "StockLocation" WHERE "isDefault") <> 1 THEN
    RAISE EXCEPTION 'STOCK_LOCATION_NO_DEFAULT: exactly one default stock location is required' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM "StockLocation" WHERE "isProduction") <> 1 THEN
    RAISE EXCEPTION 'STOCK_LOCATION_NO_PRODUCTION: exactly one production stock location is required' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER stock_location_default_check AFTER INSERT OR UPDATE OR DELETE ON "StockLocation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_location_default_check();

-- The accounting audit (who, when, before / after) of the four tables (ledger_audit_row, 20261102090000_accounting_core).
-- "StockBalance" has a composite key and no "id": its audit row names it «locationId:itemKind:entityId» (the same row
-- ledger_audit_row writes otherwise; that shared function is left as it is).
CREATE OR REPLACE FUNCTION stock_balance_audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b jsonb; a jsonb; r jsonb;
BEGIN
  b := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  a := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  r := coalesce(a, b);
  INSERT INTO "AccountingAuditLog" ("id", "tenantId", "at", "actorId", "action", "entityType", "entityId", "before", "after", "reason", "ip", "userAgent")
  VALUES (gen_random_uuid()::text, 'hiqbah', now(), coalesce(nullif(current_setting('hiqbah.actor_id', true), ''), 'system'),
          TG_OP, TG_TABLE_NAME, (r->>'locationId') || ':' || (r->>'itemKind') || ':' || (r->>'entityId'), b, a,
          nullif(current_setting('hiqbah.audit_reason', true), ''), nullif(current_setting('hiqbah.audit_ip', true), ''),
          nullif(current_setting('hiqbah.audit_ua', true), ''));
  RETURN NULL;
END $$;
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "StockLocation" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "StockBalance" FOR EACH ROW EXECUTE FUNCTION stock_balance_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "StockTransfer" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "StockTransferLine" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- 8 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "StockLocation", "StockBalance", "StockTransfer", "StockTransferLine" TO flowcom_app;
    GRANT USAGE, SELECT ON SEQUENCE "StockTransfer_number_seq" TO flowcom_app;
    GRANT EXECUTE ON FUNCTION stock_location_current(), stock_balance_sync(), stock_balance_guard(), stock_balance_total_check(),
      stock_location_guard(), stock_location_default_check(), stock_balance_audit_row() TO flowcom_app;
  END IF;
END $$;

COMMIT;
