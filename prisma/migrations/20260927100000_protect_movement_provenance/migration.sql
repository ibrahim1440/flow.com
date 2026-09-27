-- DropForeignKey
ALTER TABLE "CommissionLedgerEntry" DROP CONSTRAINT "CommissionLedgerEntry_accrualId_fkey";

-- DropForeignKey
ALTER TABLE "CommissionLedgerEntry" DROP CONSTRAINT "CommissionLedgerEntry_collectionEventId_fkey";

-- DropForeignKey
ALTER TABLE "CommissionLedgerEntry" DROP CONSTRAINT "CommissionLedgerEntry_planVersionId_fkey";

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_accrualId_fkey" FOREIGN KEY ("accrualId") REFERENCES "CommissionAccrual"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_collectionEventId_fkey" FOREIGN KEY ("collectionEventId") REFERENCES "CollectionEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "CommissionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
