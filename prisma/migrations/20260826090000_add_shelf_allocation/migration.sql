-- Shelf allocation: make "reserved on the shelf" a real, enforceable balance.
--
-- Additive only. Every existing FinishedGoodsLot gets reservedQty = 0, which is the
-- correct historical value: before this migration nothing could reserve stock, so no
-- kilogram was ever promised without being shipped in the same transaction.

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');

-- AlterTable
ALTER TABLE "FinishedGoodsLot" ADD COLUMN "reservedQty" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "StockAllocation" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "finishedGoodsLotId" TEXT NOT NULL,
    "quantityKg" DOUBLE PRECISION NOT NULL,
    "status" "AllocationStatus" NOT NULL DEFAULT 'RESERVED',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockAllocation_orderItemId_status_idx" ON "StockAllocation"("orderItemId", "status");

-- CreateIndex
CREATE INDEX "StockAllocation_finishedGoodsLotId_status_idx" ON "StockAllocation"("finishedGoodsLotId", "status");

-- AddForeignKey
ALTER TABLE "StockAllocation" ADD CONSTRAINT "StockAllocation_orderItemId_fkey"
    FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAllocation" ADD CONSTRAINT "StockAllocation_finishedGoodsLotId_fkey"
    FOREIGN KEY ("finishedGoodsLotId") REFERENCES "FinishedGoodsLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Invariants ──────────────────────────────────────────────────────────────
-- These follow the precedent set by the five P0 non-negative CHECK constraints
-- documented in docs/migration-drift-and-db-constraints.md: the balance rules that
-- must never be violated are enforced by the database, not only by route code.

-- A lot can never promise more than it holds, and neither balance can go negative.
ALTER TABLE "FinishedGoodsLot"
    ADD CONSTRAINT "FinishedGoodsLot_reservedQty_within_available"
    CHECK ("reservedQty" >= 0 AND "reservedQty" <= "availableQty");

-- An allocation is always for a positive quantity.
ALTER TABLE "StockAllocation"
    ADD CONSTRAINT "StockAllocation_quantityKg_positive"
    CHECK ("quantityKg" > 0);
