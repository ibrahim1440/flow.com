-- AlterTable
ALTER TABLE "CommissionLedgerEntry" ADD COLUMN     "collectionEventId" TEXT,
ADD COLUMN     "effectiveRatePercent" DECIMAL(9,6),
ADD COLUMN     "planVersionId" TEXT,
ADD COLUMN     "qualifyingBase" DECIMAL(18,2),
ADD COLUMN     "sharePercent" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "CommissionLedgerCorrection" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "correctsEntryId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionLedgerCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionLedgerCorrection_correctsEntryId_idx" ON "CommissionLedgerCorrection"("correctsEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionLedgerCorrection_entryId_correctsEntryId_key" ON "CommissionLedgerCorrection"("entryId", "correctsEntryId");

-- CreateIndex
CREATE INDEX "CommissionLedgerEntry_collectionEventId_idx" ON "CommissionLedgerEntry"("collectionEventId");

-- CreateIndex
CREATE INDEX "CommissionLedgerEntry_accrualId_idx" ON "CommissionLedgerEntry"("accrualId");

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_collectionEventId_fkey" FOREIGN KEY ("collectionEventId") REFERENCES "CollectionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "CommissionPlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerCorrection" ADD CONSTRAINT "CommissionLedgerCorrection_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "CommissionLedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerCorrection" ADD CONSTRAINT "CommissionLedgerCorrection_correctsEntryId_fkey" FOREIGN KEY ("correctsEntryId") REFERENCES "CommissionLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
