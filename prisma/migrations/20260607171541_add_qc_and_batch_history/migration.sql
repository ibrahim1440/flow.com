-- CreateTable
CREATE TABLE "QcCorrectionHistory" (
    "id" TEXT NOT NULL,
    "qcRecordId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "correctionReason" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "changedByName" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QcCorrectionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QcCorrectionFieldChange" (
    "id" TEXT NOT NULL,
    "correctionId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,

    CONSTRAINT "QcCorrectionFieldChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchSerialHistory" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "greenBeanId" TEXT,
    "oldBatchNumber" TEXT NOT NULL,
    "newBatchNumber" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "changedByName" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchSerialHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QcCorrectionHistory_qcRecordId_idx" ON "QcCorrectionHistory"("qcRecordId");

-- CreateIndex
CREATE INDEX "QcCorrectionHistory_batchId_idx" ON "QcCorrectionHistory"("batchId");

-- CreateIndex
CREATE INDEX "QcCorrectionHistory_changedAt_idx" ON "QcCorrectionHistory"("changedAt");

-- CreateIndex
CREATE INDEX "QcCorrectionFieldChange_correctionId_idx" ON "QcCorrectionFieldChange"("correctionId");

-- CreateIndex
CREATE INDEX "BatchSerialHistory_batchId_idx" ON "BatchSerialHistory"("batchId");

-- CreateIndex
CREATE INDEX "BatchSerialHistory_oldBatchNumber_idx" ON "BatchSerialHistory"("oldBatchNumber");

-- AddForeignKey
ALTER TABLE "QcCorrectionHistory" ADD CONSTRAINT "QcCorrectionHistory_qcRecordId_fkey" FOREIGN KEY ("qcRecordId") REFERENCES "QcRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QcCorrectionFieldChange" ADD CONSTRAINT "QcCorrectionFieldChange_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "QcCorrectionHistory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchSerialHistory" ADD CONSTRAINT "BatchSerialHistory_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
