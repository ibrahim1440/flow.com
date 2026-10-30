-- Sales samples issued from finished-goods stock (docs/sales/SAMPLES_INVENTORY.md). ADDITIVE ONLY, one transaction
-- (PostgreSQL 16 / 17). The two enum values are added IF NOT EXISTS and NOT USED before COMMIT — which is why the
-- movement guard that names 'SAMPLE' is its own migration (20261204090100_sample_inventory_guard), and why the CHECKs
-- below compare "status"::text rather than the enum literal.
--
--   1. "SampleStatus" + 'REQUESTED' (the rep's request, waiting for dispatch; moves no stock). The column default stays
--      PREPARING: a record-only sample (every existing row and caller) is created as before.
--   2. "SourceDocType" + 'SAMPLE' (an InventoryMovement OUT · FINISHED_GOODS whose sourceDocId is the sample's id).
--   3. "SampleShipment": "fromStock" (false on every existing row — they stay record-only, no stock ever moves for
--      them), "issuedAt" / "issuedById" (the issue), "movementIds" (its movements), "issueLots" (the lots drawn),
--      "costValue" (the issued units at lot cost, SAR — management reporting, never posted).
--      CHECK "SampleShipment_from_stock_shape": a stock sample is a SKU in whole positive units.
--      CHECK "SampleShipment_issued": a stock sample is SENT or FEEDBACK_RECEIVED exactly when it has been issued
--      ("issuedAt" set) — so an issued sample can never be cancelled, nor a stock sample sent without its issue — and
--      a record-only sample never carries an issue or a cost.
--      Index ("fromStock", "status"): the dispatch queue.
-- Row counts touched: none (new columns take their defaults; no existing row is rewritten).
-- Rollback (nothing reads the new columns once the code is reverted; the enum values stay, unused):
--   ALTER TABLE "SampleShipment" DROP CONSTRAINT "SampleShipment_issued", DROP CONSTRAINT "SampleShipment_from_stock_shape",
--     DROP COLUMN "costValue", DROP COLUMN "issueLots", DROP COLUMN "movementIds", DROP COLUMN "issuedById",
--     DROP COLUMN "issuedAt", DROP COLUMN "fromStock";
BEGIN;

-- 1 ───────────────────────────────────────────────────────────────────────────────────────────────
ALTER TYPE "SampleStatus" ADD VALUE IF NOT EXISTS 'REQUESTED' BEFORE 'PREPARING';

-- 2 ───────────────────────────────────────────────────────────────────────────────────────────────
ALTER TYPE "SourceDocType" ADD VALUE IF NOT EXISTS 'SAMPLE';

-- 3 ───────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SampleShipment"
  ADD COLUMN "fromStock"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "issuedAt"    TIMESTAMP(3),
  ADD COLUMN "issuedById"  TEXT,
  ADD COLUMN "movementIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "issueLots"   JSONB,
  ADD COLUMN "costValue"   DECIMAL(18,2);

ALTER TABLE "SampleShipment" ADD CONSTRAINT "SampleShipment_from_stock_shape" CHECK (
  NOT "fromStock"
  OR ("productSkuId" IS NOT NULL AND "unit" = 'UNIT' AND "quantity" > 0 AND "quantity" = trunc("quantity"))
);

ALTER TABLE "SampleShipment" ADD CONSTRAINT "SampleShipment_issued" CHECK (
  CASE WHEN "fromStock"
    THEN ("issuedAt" IS NOT NULL) = ("status"::text IN ('SENT', 'FEEDBACK_RECEIVED'))
    ELSE "issuedAt" IS NULL AND "costValue" IS NULL
  END
);

CREATE INDEX "SampleShipment_fromStock_status_idx" ON "SampleShipment"("fromStock", "status");

COMMIT;
