-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'Waiting Approval';

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "availableQuantity" DOUBLE PRECISION,
ADD COLUMN     "preparationDecision" TEXT,
ADD COLUMN     "productionRequiredQuantity" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "OrderActivity" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "department" TEXT,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderActivity_orderId_createdAt_idx" ON "OrderActivity"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_ownerId_idx" ON "Order"("ownerId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderActivity" ADD CONSTRAINT "OrderActivity_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
