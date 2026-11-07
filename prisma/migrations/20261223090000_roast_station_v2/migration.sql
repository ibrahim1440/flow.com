-- «محطة التحميص v2» — P0, the accounting and data core (owner-approved project ROASTING STATION v2; no station UI yet).
--
-- How the floor works: green is weighed in advance into numbered buckets and moved to «منطقة التحميص» (a real immediate
-- stock transfer). Each roast charges ONE bucket. Two consecutive roasts of the same coffee are mixed in the cooler and
-- weighed TOGETHER: one RoastingBatch (= lot) per weighed basket, with its roasts as children. A burnt roast is discarded.
--
--   1. "SourceDocType" + ROAST_RUN: the stock movement of a discarded roast (green out of staging). An ADD VALUE of its
--      own, before the transaction; nothing in this migration USES it (55P04 does not arise).
--   2. "StockLocation_type_check" WIDENED (DROP + ADD) by 'STAGING', and the system location «منطقة التحميص»
--      ("loc_roast_staging", code ROAST-STG, type STAGING) on the production site's branch. Every row the old CHECK
--      accepted, the new one accepts. Never default / production (CHECK).
--   3. "Roaster"."stationMode" V1 | V2 (NOT NULL DEFAULT 'V1': a constant default, metadata only). Every existing roaster
--      is V1 and records exactly as before; V2 is switched on per roaster.
--   4. "ScheduledSlot"."outcome" ROASTED | DISCARDED (NULL: every existing slot, and every V1 roast).
--   5. New tables:
--        "GreenPrepSession"      a weighing session (one operator, one source site → staging, one business day);
--        "GreenBucket"           a numbered bucket of green (barcode GB-000123 from a sequence, never reused; the number
--                                within its session for the label; planned / actual kg; status PREPARED | CHARGED |
--                                RETURNED | WRITTEN_OFF; a colour key per coffee);
--        "GreenBucketComponent"  the green lot(s) in a bucket — one lot per bucket in P0, a table from day one so a green
--                                blend needs no rewrite;
--        "RoastBasket"           the cooler: the roasts weighed together (OPEN | SEALED | RECORDED | CANCELLED), at most
--                                ONE OPEN per roaster (partial unique index);
--        "RoastRun"              one roast (serial R-YYYYMMDD-NN from "RoastRunCounter"): CHARGED | DROPPED | RECORDED |
--                                DISCARDED | UNDONE. At most one CHARGED per roaster (one roast in the drum) and each
--                                bucket charged once unless the run was UNDONE (partial unique indexes). No database
--                                guard on drops: a drop is never refused (the charge gate lives in the service);
--        "RoastRunCounter"       the serial's daily counter;
--        "RoastLotAllocation"    P2 (behind a flag): a lot split across order lines by green share. Created now, unused;
--        "RoastStationEvent"     «إبلاغ عن مشكلة» on a V2 roaster (PAUSE | MALFUNCTION, OPEN until resumed; one OPEN per roaster).
--   6. "RoastingBatch" + "lotKind" (SINGLE | PAIR; NULL for every V1 batch), "isMixedGreen" (NOT NULL DEFAULT false),
--      "basketId" (unique → "RoastBasket") and "correctsBatchId" (→ "RoastingBatch": a lot re-recorded after a correction);
--      "RoastingBatch_status_check" widened by 'Corrected' (the lot a correction replaced).
--   7. Role ROAST_DISCARD «تالف التحميص (محروق)»: a burnt roast's full green cost. When the chart is the default template
--      (its parent 5000 exists) the account 5415 is added when the code is free and the role mapped when it is not mapped
--      yet — never changing an account or a mapping that exists (the supplier-shortfall pattern). Otherwise the
--      accountant maps it («ربط الحسابات»; the readiness lists it).
--   8. The runtime role flowcom_app, when it exists, is granted the new tables and the sequence.
--
-- ADDITIVE: no existing row is rewritten. Rollback: docs/hr/migration-review/rollback-20261223090000_roast_station_v2.sql
-- (the enum value stays — PostgreSQL cannot drop it; accepted, as for every enum value before).

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TYPE "SourceDocType" ADD VALUE IF NOT EXISTS 'ROAST_RUN';

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "StockLocation" DROP CONSTRAINT "StockLocation_type_check";
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_type_check" CHECK ("type" IN ('ROASTERY', 'WAREHOUSE', 'CAFE', 'BRANCH', 'OTHER', 'TRANSIT', 'STAGING'));
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_staging_check" CHECK ("type" <> 'STAGING' OR (NOT "isDefault" AND NOT "isProduction"));
INSERT INTO "StockLocation" ("id", "code", "nameAr", "nameEn", "type", "isDefault", "isProduction", "sortOrder", "notes", "finBranchId", "createdBy", "updatedBy")
SELECT 'loc_roast_staging', 'ROAST-STG', 'منطقة التحميص', 'Roasting staging', 'STAGING', false, false, 998,
       'موقع النظام للبن الأخضر الموزون في سطول تنتظر التحميص (محطة التحميص v2).',
       (SELECT "finBranchId" FROM "StockLocation" WHERE "isProduction" LIMIT 1), 'migration', 'migration'
ON CONFLICT DO NOTHING;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "StockLocation" WHERE "id" = 'loc_roast_staging' AND "type" = 'STAGING') THEN
    RAISE EXCEPTION 'loc_roast_staging (type STAGING) is missing: a location already uses the id loc_roast_staging or the code ROAST-STG — rename it, then apply again';
  END IF;
END $$;

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Roaster" ADD COLUMN "stationMode" TEXT NOT NULL DEFAULT 'V1';
ALTER TABLE "Roaster" ADD CONSTRAINT "Roaster_stationMode_check" CHECK ("stationMode" IN ('V1', 'V2'));

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "ScheduledSlot" ADD COLUMN "outcome" TEXT;
ALTER TABLE "ScheduledSlot" ADD CONSTRAINT "ScheduledSlot_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('ROASTED', 'DISCARDED'));

-- 5 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "GreenPrepSession" (
  "id"                TEXT NOT NULL,
  "businessDay"       DATE NOT NULL,
  "operatorId"        TEXT NOT NULL,
  "operatorName"      TEXT,
  "sourceLocationId"  TEXT NOT NULL,
  "stagingLocationId" TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'OPEN',
  "note"              TEXT,
  "closedAt"          TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GreenPrepSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GreenPrepSession_status_check" CHECK ("status" IN ('OPEN', 'CLOSED')),
  CONSTRAINT "GreenPrepSession_sites_check" CHECK ("sourceLocationId" <> "stagingLocationId")
);
ALTER TABLE "GreenPrepSession" ADD CONSTRAINT "GreenPrepSession_sourceLocationId_fkey" FOREIGN KEY ("sourceLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GreenPrepSession" ADD CONSTRAINT "GreenPrepSession_stagingLocationId_fkey" FOREIGN KEY ("stagingLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "GreenPrepSession_day_idx" ON "GreenPrepSession"("businessDay", "status");

CREATE SEQUENCE "GreenBucket_barcode_seq" AS integer MINVALUE 1 MAXVALUE 999999 NO CYCLE;
CREATE TABLE "GreenBucket" (
  "id"               TEXT NOT NULL,
  "barcode"          TEXT NOT NULL DEFAULT ('GB-'::text || lpad((nextval('"GreenBucket_barcode_seq"'::regclass))::text, 6, '0'::text)),
  "sessionId"        TEXT NOT NULL,
  "seqNo"            INTEGER NOT NULL,
  "greenBeanId"      TEXT NOT NULL,
  "productId"        TEXT,
  "colorKey"         TEXT,
  "plannedKg"        DECIMAL(10,3),
  "actualKg"         DECIMAL(10,3) NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'PREPARED',
  "locationId"       TEXT NOT NULL,
  "transferId"       TEXT,
  "returnTransferId" TEXT,
  "labelPrintedAt"   TIMESTAMP(3),
  "requestKey"       TEXT,
  "createdById"      TEXT NOT NULL,
  "createdByName"    TEXT,
  "returnedAt"       TIMESTAMP(3),
  "writtenOffAt"     TIMESTAMP(3),
  "statusReason"     TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GreenBucket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GreenBucket_barcode_check" CHECK ("barcode" ~ '^GB-[0-9]{6}$'),
  CONSTRAINT "GreenBucket_status_check" CHECK ("status" IN ('PREPARED', 'CHARGED', 'RETURNED', 'WRITTEN_OFF')),
  CONSTRAINT "GreenBucket_kg_check" CHECK ("actualKg" > 0 AND ("plannedKg" IS NULL OR "plannedKg" > 0)),
  CONSTRAINT "GreenBucket_seqNo_check" CHECK ("seqNo" > 0)
);
ALTER SEQUENCE "GreenBucket_barcode_seq" OWNED BY "GreenBucket"."barcode";
CREATE UNIQUE INDEX "GreenBucket_barcode_key" ON "GreenBucket"("barcode");
CREATE UNIQUE INDEX "GreenBucket_requestKey_key" ON "GreenBucket"("requestKey");
CREATE UNIQUE INDEX "GreenBucket_session_seq_key" ON "GreenBucket"("sessionId", "seqNo");
CREATE INDEX "GreenBucket_status_idx" ON "GreenBucket"("status", "createdAt");
CREATE INDEX "GreenBucket_greenBeanId_idx" ON "GreenBucket"("greenBeanId");
ALTER TABLE "GreenBucket" ADD CONSTRAINT "GreenBucket_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GreenPrepSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GreenBucket" ADD CONSTRAINT "GreenBucket_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GreenBucket" ADD CONSTRAINT "GreenBucket_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GreenBucket" ADD CONSTRAINT "GreenBucket_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GreenBucket" ADD CONSTRAINT "GreenBucket_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GreenBucket" ADD CONSTRAINT "GreenBucket_returnTransferId_fkey" FOREIGN KEY ("returnTransferId") REFERENCES "StockTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "GreenBucketComponent" (
  "id"          TEXT NOT NULL,
  "bucketId"    TEXT NOT NULL,
  "greenBeanId" TEXT NOT NULL,
  "kg"          DECIMAL(10,3) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GreenBucketComponent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GreenBucketComponent_kg_check" CHECK ("kg" > 0)
);
CREATE UNIQUE INDEX "GreenBucketComponent_bucket_bean_key" ON "GreenBucketComponent"("bucketId", "greenBeanId");
CREATE INDEX "GreenBucketComponent_greenBeanId_idx" ON "GreenBucketComponent"("greenBeanId");
ALTER TABLE "GreenBucketComponent" ADD CONSTRAINT "GreenBucketComponent_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "GreenBucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GreenBucketComponent" ADD CONSTRAINT "GreenBucketComponent_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RoastBasket" (
  "id"         TEXT NOT NULL,
  "roasterId"  TEXT NOT NULL,
  "coffeeKey"  TEXT NOT NULL,
  "productId"  TEXT,
  "status"     TEXT NOT NULL DEFAULT 'OPEN',
  "single"     BOOLEAN NOT NULL DEFAULT false,
  "sealedAt"   TIMESTAMP(3),
  "recordedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoastBasket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RoastBasket_status_check" CHECK ("status" IN ('OPEN', 'SEALED', 'RECORDED', 'CANCELLED'))
);
CREATE UNIQUE INDEX "RoastBasket_one_open" ON "RoastBasket"("roasterId") WHERE "status" = 'OPEN';
CREATE INDEX "RoastBasket_roaster_status_idx" ON "RoastBasket"("roasterId", "status");
ALTER TABLE "RoastBasket" ADD CONSTRAINT "RoastBasket_roasterId_fkey" FOREIGN KEY ("roasterId") REFERENCES "Roaster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoastBasket" ADD CONSTRAINT "RoastBasket_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RoastRunCounter" (
  "day"  DATE NOT NULL,
  "last" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "RoastRunCounter_pkey" PRIMARY KEY ("day")
);

CREATE TABLE "RoastRun" (
  "id"              TEXT NOT NULL,
  "serial"          TEXT NOT NULL,
  "bucketId"        TEXT NOT NULL,
  "roasterId"       TEXT NOT NULL,
  "productId"       TEXT NOT NULL,
  "operatorId"      TEXT NOT NULL,
  "operatorName"    TEXT,
  "greenKg"         DECIMAL(10,3) NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'CHARGED',
  "chargedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "droppedAt"       TIMESTAMP(3),
  "coolerPosition"  INTEGER,
  "basketId"        TEXT,
  "scheduledSlotId" TEXT,
  "profile"         TEXT,
  "capacityAck"     TEXT,
  "adminBypass"     BOOLEAN NOT NULL DEFAULT false,
  "chargeKey"       TEXT,
  "dropKey"         TEXT,
  "discardKey"      TEXT,
  "undoKey"         TEXT,
  "undoneAt"        TIMESTAMP(3),
  "undoneById"      TEXT,
  "discardedAt"     TIMESTAMP(3),
  "discardedById"   TEXT,
  "discardReason"   TEXT,
  "discardValue"    DECIMAL(18,2),
  "reviewedAt"      TIMESTAMP(3),
  "reviewedById"    TEXT,
  "reviewNote"      TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoastRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RoastRun_serial_check" CHECK ("serial" ~ '^R-[0-9]{8}-[0-9]{2,}$'),
  CONSTRAINT "RoastRun_status_check" CHECK ("status" IN ('CHARGED', 'DROPPED', 'RECORDED', 'DISCARDED', 'UNDONE')),
  CONSTRAINT "RoastRun_greenKg_check" CHECK ("greenKg" > 0),
  CONSTRAINT "RoastRun_capacityAck_check" CHECK ("capacityAck" IS NULL OR "capacityAck" IN ('BELOW_MIN', 'ABOVE_MAX')),
  CONSTRAINT "RoastRun_dropped_check" CHECK ("status" NOT IN ('DROPPED', 'RECORDED') OR "droppedAt" IS NOT NULL),
  CONSTRAINT "RoastRun_discard_check" CHECK ("status" <> 'DISCARDED' OR ("discardedAt" IS NOT NULL AND "discardedById" IS NOT NULL AND "discardReason" IS NOT NULL)),
  CONSTRAINT "RoastRun_review_check" CHECK ("reviewedAt" IS NULL OR ("status" = 'DISCARDED' AND "reviewedById" IS NOT NULL AND "reviewedById" <> "discardedById"))
);
CREATE UNIQUE INDEX "RoastRun_serial_key" ON "RoastRun"("serial");
CREATE UNIQUE INDEX "RoastRun_scheduledSlotId_key" ON "RoastRun"("scheduledSlotId");
CREATE UNIQUE INDEX "RoastRun_chargeKey_key" ON "RoastRun"("chargeKey");
CREATE UNIQUE INDEX "RoastRun_dropKey_key" ON "RoastRun"("dropKey");
CREATE UNIQUE INDEX "RoastRun_discardKey_key" ON "RoastRun"("discardKey");
CREATE UNIQUE INDEX "RoastRun_undoKey_key" ON "RoastRun"("undoKey");
-- One roast in the drum per roaster; each bucket charged once (an UNDONE run frees it).
CREATE UNIQUE INDEX "RoastRun_one_in_drum" ON "RoastRun"("roasterId") WHERE "status" = 'CHARGED';
CREATE UNIQUE INDEX "RoastRun_bucket_once" ON "RoastRun"("bucketId") WHERE "status" <> 'UNDONE';
CREATE INDEX "RoastRun_roaster_status_idx" ON "RoastRun"("roasterId", "status");
CREATE INDEX "RoastRun_basketId_idx" ON "RoastRun"("basketId");
CREATE INDEX "RoastRun_discard_review_idx" ON "RoastRun"("status", "reviewedAt");
ALTER TABLE "RoastRun" ADD CONSTRAINT "RoastRun_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "GreenBucket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoastRun" ADD CONSTRAINT "RoastRun_roasterId_fkey" FOREIGN KEY ("roasterId") REFERENCES "Roaster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoastRun" ADD CONSTRAINT "RoastRun_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoastRun" ADD CONSTRAINT "RoastRun_basketId_fkey" FOREIGN KEY ("basketId") REFERENCES "RoastBasket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RoastRun" ADD CONSTRAINT "RoastRun_scheduledSlotId_fkey" FOREIGN KEY ("scheduledSlotId") REFERENCES "ScheduledSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5b «إبلاغ عن مشكلة» on a V2 roaster (V1 R7 semantics without claims): a PAUSE or a MALFUNCTION, OPEN until resumed. No stock
-- moves and the roaster's status is not changed (D13). At most one OPEN problem per roaster; a charge is refused while open.
CREATE TABLE "RoastStationEvent" (
  "id"             TEXT NOT NULL,
  "roasterId"      TEXT NOT NULL,
  "kind"           TEXT NOT NULL,
  "reason"         TEXT NOT NULL,
  "note"           TEXT,
  "runId"          TEXT,
  "roasterState"   JSONB,
  "status"         TEXT NOT NULL DEFAULT 'OPEN',
  "reportedById"   TEXT NOT NULL,
  "reportedByName" TEXT,
  "reportedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reportKey"      TEXT NOT NULL,
  "resolvedAt"     TIMESTAMP(3),
  "resolvedById"   TEXT,
  "resolveKey"     TEXT,
  "resolveNote"    TEXT,
  CONSTRAINT "RoastStationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RoastStationEvent_kind_check" CHECK ("kind" IN ('PAUSE', 'MALFUNCTION')),
  CONSTRAINT "RoastStationEvent_reason_check" CHECK ("reason" IN ('BURNER_STOPPED', 'IRREGULAR_HEAT', 'COOLING_PROBLEM', 'OTHER')),
  CONSTRAINT "RoastStationEvent_status_check" CHECK ("status" IN ('OPEN', 'RESOLVED')),
  CONSTRAINT "RoastStationEvent_resolved_check" CHECK ("status" = 'OPEN' OR ("resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL))
);
CREATE UNIQUE INDEX "RoastStationEvent_reportKey_key" ON "RoastStationEvent"("reportKey");
CREATE UNIQUE INDEX "RoastStationEvent_resolveKey_key" ON "RoastStationEvent"("resolveKey");
CREATE UNIQUE INDEX "RoastStationEvent_one_open" ON "RoastStationEvent"("roasterId") WHERE "status" = 'OPEN';
CREATE INDEX "RoastStationEvent_roaster_idx" ON "RoastStationEvent"("roasterId", "reportedAt");
ALTER TABLE "RoastStationEvent" ADD CONSTRAINT "RoastStationEvent_roasterId_fkey" FOREIGN KEY ("roasterId") REFERENCES "Roaster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoastStationEvent" ADD CONSTRAINT "RoastStationEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RoastRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "RoastingBatch" ADD COLUMN "lotKind" TEXT;
ALTER TABLE "RoastingBatch" ADD COLUMN "isMixedGreen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RoastingBatch" ADD COLUMN "basketId" TEXT;
ALTER TABLE "RoastingBatch" ADD COLUMN "correctsBatchId" TEXT;
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_lotKind_check" CHECK ("lotKind" IS NULL OR "lotKind" IN ('SINGLE', 'PAIR'));
-- "RoastingBatch_status_check" WIDENED (DROP + ADD, NOT VALID as before) by 'Corrected': a v2 lot a supervisor corrected
-- (reversed per component, re-recorded as a new lot with correctsBatchId). Every row the old CHECK accepted, the new one accepts.
ALTER TABLE "RoastingBatch" DROP CONSTRAINT "RoastingBatch_status_check";
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_status_check" CHECK ("status" IN ('Pending QC', 'Passed', 'Rejected', 'Blended', 'Partially Packaged', 'Packaged', 'QC Hold', 'Corrected')) NOT VALID;
-- A v2 lot names its basket and its kind; a corrected v2 lot (status Corrected) keeps its kind and frees its basket.
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_v2_lot_check" CHECK ("basketId" IS NULL OR "lotKind" IS NOT NULL);
CREATE UNIQUE INDEX "RoastingBatch_basketId_key" ON "RoastingBatch"("basketId");
CREATE INDEX "RoastingBatch_correctsBatchId_idx" ON "RoastingBatch"("correctsBatchId");
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_basketId_fkey" FOREIGN KEY ("basketId") REFERENCES "RoastBasket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_correctsBatchId_fkey" FOREIGN KEY ("correctsBatchId") REFERENCES "RoastingBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RoastLotAllocation" (
  "id"                TEXT NOT NULL,
  "batchId"           TEXT NOT NULL,
  "orderItemId"       TEXT,
  "productionOrderId" TEXT,
  "greenKg"           DECIMAL(10,3) NOT NULL,
  "roastedKg"         DECIMAL(10,3) NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoastLotAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RoastLotAllocation_kg_check" CHECK ("greenKg" > 0 AND "roastedKg" > 0 AND "roastedKg" <= "greenKg")
);
CREATE INDEX "RoastLotAllocation_batchId_idx" ON "RoastLotAllocation"("batchId");
CREATE INDEX "RoastLotAllocation_orderItemId_idx" ON "RoastLotAllocation"("orderItemId");
ALTER TABLE "RoastLotAllocation" ADD CONSTRAINT "RoastLotAllocation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoastLotAllocation" ADD CONSTRAINT "RoastLotAllocation_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RoastLotAllocation" ADD CONSTRAINT "RoastLotAllocation_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 7 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE p text; a text;
BEGIN
  -- ROAST_DISCARD → 5415 under 5000 (cost of sales), beside 5410 abnormal roast loss; fed by the station (no manual journal).
  IF NOT EXISTS (SELECT 1 FROM "AccountRole" WHERE "tenantId" = 'hiqbah' AND "role" = 'ROAST_DISCARD') THEN
    SELECT "id" INTO p FROM "Account" WHERE "code" = '5000';
    IF p IS NOT NULL THEN
      SELECT "id" INTO a FROM "Account" WHERE "code" = '5415' AND "type"::text = 'EXPENSE' AND "allowPosting" AND "isActive";
      IF a IS NULL AND NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '5415') THEN
        a := 'acc_' || replace(gen_random_uuid()::text, '-', '');
        INSERT INTO "Account" ("id", "code", "nameAr", "nameEn", "parentId", "type", "normalBalance", "allowPosting", "isActive", "allowManualJournal", "createdBy", "updatedBy", "updatedAt")
        VALUES (a, '5415', 'تالف التحميص (محروق)', 'Roast discard (burnt)', p, 'EXPENSE', 'DEBIT', true, true, false, 'migration', 'migration', now());
      END IF;
      IF a IS NOT NULL THEN
        INSERT INTO "AccountRole" ("id", "tenantId", "role", "accountId", "updatedBy", "updatedAt") VALUES ('ar_' || replace(gen_random_uuid()::text, '-', ''), 'hiqbah', 'ROAST_DISCARD', a, 'migration', now());
      END IF;
    END IF;
  END IF;
END $$;

-- 8 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "GreenPrepSession", "GreenBucket", "GreenBucketComponent", "RoastBasket", "RoastRun", "RoastRunCounter", "RoastLotAllocation", "RoastStationEvent" TO flowcom_app;
    GRANT USAGE, SELECT ON SEQUENCE "GreenBucket_barcode_seq" TO flowcom_app;
  END IF;
END $$;

COMMIT;
