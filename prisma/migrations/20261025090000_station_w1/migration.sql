-- Workstations W0+W1 (roasting station, personal sign-in; owner approval 22 Oct 2026).
--
-- Additive only: three nullable columns and one index on "RoastingBatch", and one new append-only
-- table "RoasterControlLog". No rename, no drop, no data change, no change to batch numbering (D8).
-- The previous application version never reads or writes any of it and runs unchanged on the result.
--
--   RoastingBatch.roasterId   the roaster a batch was roasted on (NULL = none chosen, as before)
--   RoastingBatch.requestKey  Idempotency-Key of the roast POST (UNIQUE; NULL for keyless callers)
--   RoastingBatch.intentHash  SHA-256 of the normalized roast intent (same key + other intent = 422)
--   RoasterControlLog         capacity acknowledgements (min–max) and admin operator bypasses (D5)
--
-- WorkItemClaim and WorkstationActionLog are adopted as they are (D10): no change here.

-- AlterTable
ALTER TABLE "RoastingBatch" ADD COLUMN     "intentHash" TEXT,
ADD COLUMN     "requestKey" TEXT,
ADD COLUMN     "roasterId" TEXT;

-- CreateTable
CREATE TABLE "RoasterControlLog" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "roasterId" TEXT NOT NULL,
    "roasterName" TEXT NOT NULL,
    "batchId" TEXT,
    "batchNumber" TEXT,
    "requestKey" TEXT,
    "employeeId" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "employeeRole" TEXT NOT NULL,
    "greenKg" DECIMAL(10,3) NOT NULL,
    "nominalKg" DECIMAL(10,3) NOT NULL,
    "minKg" DECIMAL(10,3) NOT NULL,
    "maxKg" DECIMAL(10,3) NOT NULL,
    "direction" TEXT,
    "sourceInterface" TEXT NOT NULL DEFAULT 'WEB',
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoasterControlLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoasterControlLog_roasterId_createdAt_idx" ON "RoasterControlLog"("roasterId", "createdAt");

-- CreateIndex
CREATE INDEX "RoasterControlLog_batchId_idx" ON "RoasterControlLog"("batchId");

-- CreateIndex
CREATE INDEX "RoasterControlLog_kind_createdAt_idx" ON "RoasterControlLog"("kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoastingBatch_requestKey_key" ON "RoastingBatch"("requestKey");

-- CreateIndex
CREATE INDEX "RoastingBatch_roasterId_createdAt_idx" ON "RoastingBatch"("roasterId", "createdAt");


-- CHECKs (the application writes only these values).
ALTER TABLE "RoasterControlLog" ADD CONSTRAINT "RoasterControlLog_kind_check" CHECK ("kind" IN ('CAPACITY_ACK', 'OPERATOR_ADMIN_BYPASS'));
ALTER TABLE "RoasterControlLog" ADD CONSTRAINT "RoasterControlLog_direction_check" CHECK ("direction" IS NULL OR "direction" IN ('BELOW_MIN', 'ABOVE_MAX'));
ALTER TABLE "RoasterControlLog" ADD CONSTRAINT "RoasterControlLog_source_check" CHECK ("sourceInterface" IN ('WEB', 'STATION'));
ALTER TABLE "RoasterControlLog" ADD CONSTRAINT "RoasterControlLog_ack_direction_check" CHECK ("kind" <> 'CAPACITY_ACK' OR "direction" IS NOT NULL);
