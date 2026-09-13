-- Packaging operation idempotency (R2.2B).
--
-- Purely additive: one enum, one table, its constraints and indexes. Nothing existing is
-- dropped, altered or rewritten.
--
-- The batch foreign key is RESTRICT on purpose. This table records stock that physically
-- moved, so a cascade would erase the audit at the moment it matters most. Deleting a batch
-- that has packaging history is refused; the DELETE route carries a matching domain guard so
-- an operator sees a 409 rather than a database error.
--
-- The SKU and lot links are SET NULL: they are descriptive pointers, and losing one should
-- degrade the record rather than block catalog or lot maintenance. This matches
-- FinishedGoodsLot.productSkuId, which is already SET NULL.

-- CreateEnum
CREATE TYPE "PackagingMethod" AS ENUM ('KG', 'UNIT');

-- CreateTable
CREATE TABLE "PackagingOperation" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "method" "PackagingMethod" NOT NULL,
    "quantityKg" DOUBLE PRECISION,
    "quantityUnits" INTEGER,
    "productSkuId" TEXT,
    "finishedGoodsLotId" TEXT,
    "responseStatus" INTEGER NOT NULL,
    "responseJson" JSONB NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackagingOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Idempotency is scoped to one submit against one batch, never globally: a key is only
-- meaningful against the batch it was sent for.
CREATE UNIQUE INDEX "PackagingOperation_batchId_requestKey_key" ON "PackagingOperation"("batchId", "requestKey");

-- CreateIndex
CREATE INDEX "PackagingOperation_batchId_createdAt_idx" ON "PackagingOperation"("batchId", "createdAt");

-- AddForeignKey
ALTER TABLE "PackagingOperation" ADD CONSTRAINT "PackagingOperation_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagingOperation" ADD CONSTRAINT "PackagingOperation_productSkuId_fkey"
    FOREIGN KEY ("productSkuId") REFERENCES "ProductSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagingOperation" ADD CONSTRAINT "PackagingOperation_finishedGoodsLotId_fkey"
    FOREIGN KEY ("finishedGoodsLotId") REFERENCES "FinishedGoodsLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
