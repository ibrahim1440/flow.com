-- Unified packaging: partial packages, actual fill weights and multi-roast lineage.
--
-- Expand-only. Every statement below adds something; nothing is dropped, narrowed or
-- rewritten, and no existing row is touched. That is deliberate — this migration is applied
-- to a live database while the previous application build is still serving traffic, and that
-- build must keep working afterwards. It does: it selects the columns its own client knows
-- about, and three new nullable columns plus a new table are invisible to it.
--
-- Legacy packaging rows are not converted. A pre-existing kilogram lot holding 8.45 kg
-- against a 1 KG SKU is not a whole number of bags, so there is no honest mapping to unit
-- inventory; those rows keep serving the legacy bean-based order lines exactly as before.
-- Backfilling them would either invent stock or destroy history, and this migration does
-- neither.
--
-- LotStatus.PARTIAL is the whole safety mechanism for under-filled packages. Allocation,
-- reservation, dispatch, fulfilment options and the shelf allocator every one already
-- require status = AVAILABLE, so a PARTIAL lot cannot be promised or shipped without a
-- single change to any of those paths. Adding the value here is what makes that true.
--
-- ALTER TYPE ... ADD VALUE is safe inside this migration's transaction on PostgreSQL 12+
-- because the new value is only declared here, never used by a statement in the same
-- transaction. The first row to carry it is written by the application, later.

-- AlterEnum
ALTER TYPE "LotStatus" ADD VALUE 'PARTIAL';

-- AlterEnum
-- PackagingMethod keeps KG and UNIT so historical operations keep saying what they were.
-- Every new operation is PACK.
ALTER TYPE "PackagingMethod" ADD VALUE 'PACK';

-- AlterTable
ALTER TABLE "FinishedGoodsLot" ADD COLUMN     "actualContentGrams" INTEGER,
ADD COLUMN     "materialsConsumed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nominalContentGrams" INTEGER;

-- CreateTable
CREATE TABLE "PackagingSource" (
    "id" TEXT NOT NULL,
    "finishedGoodsLotId" TEXT NOT NULL,
    "roastingBatchId" TEXT NOT NULL,
    "gramsContributed" INTEGER NOT NULL,
    "packagingOperationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackagingSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PackagingSource_finishedGoodsLotId_idx" ON "PackagingSource"("finishedGoodsLotId");

-- CreateIndex
CREATE INDEX "PackagingSource_roastingBatchId_idx" ON "PackagingSource"("roastingBatchId");

-- CreateIndex
CREATE INDEX "PackagingSource_packagingOperationId_idx" ON "PackagingSource"("packagingOperationId");

-- AddForeignKey
ALTER TABLE "PackagingSource" ADD CONSTRAINT "PackagingSource_finishedGoodsLotId_fkey" FOREIGN KEY ("finishedGoodsLotId") REFERENCES "FinishedGoodsLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagingSource" ADD CONSTRAINT "PackagingSource_roastingBatchId_fkey" FOREIGN KEY ("roastingBatchId") REFERENCES "RoastingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
