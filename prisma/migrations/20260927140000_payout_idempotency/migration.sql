-- AlterTable
ALTER TABLE "CommissionLedgerEntry" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CommissionLedgerEntry_employeeId_periodStart_idempotencyKey_key" ON "CommissionLedgerEntry"("employeeId", "periodStart", "idempotencyKey");
