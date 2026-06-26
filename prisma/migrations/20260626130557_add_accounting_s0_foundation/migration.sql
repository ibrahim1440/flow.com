-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "TaxCategoryType" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE');

-- CreateEnum
CREATE TYPE "FiscalPeriodStatus" AS ENUM ('OPEN', 'LOCKED', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalEntryType" AS ENUM ('MANUAL', 'AUTO', 'REVERSAL', 'ADJUSTMENT', 'OPENING', 'CLOSING');

-- CreateEnum
CREATE TYPE "JournalEntryStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "AccountingEventStatus" AS ENUM ('PENDING', 'TRANSLATED', 'FAILED');

-- CreateEnum
CREATE TYPE "QoyodExportStatus" AS ENUM ('NOT_EXPORTED', 'READY_FOR_EXPORT', 'EXPORTED', 'EXPORT_FAILED');

-- CreateTable
CREATE TABLE "AccountingSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "baseCurrency" TEXT NOT NULL DEFAULT 'SAR',
    "costingMethod" TEXT NOT NULL DEFAULT 'WeightedAverage',
    "cogsPolicy" TEXT NOT NULL DEFAULT 'OnShipping',
    "branchAccountingMode" TEXT NOT NULL DEFAULT 'CostCenterOnly',
    "exportToQoyod" BOOLEAN NOT NULL DEFAULT false,
    "setupComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AccountingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT,
    "nameEn" TEXT NOT NULL,
    "parentId" TEXT,
    "type" "AccountType" NOT NULL,
    "allowPosting" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "qoyodAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT,
    "nameEn" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "categoryType" "TaxCategoryType" NOT NULL DEFAULT 'STANDARD',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "requiresReason" BOOLEAN NOT NULL DEFAULT false,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "zatcaTaxCategoryCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "TaxCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalPeriod" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "periodNo" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "FiscalPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "entryNo" SERIAL NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "fiscalPeriodId" TEXT NOT NULL,
    "type" "JournalEntryType" NOT NULL DEFAULT 'MANUAL',
    "status" "JournalEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceModule" TEXT NOT NULL DEFAULT 'manual',
    "sourceDocumentId" TEXT,
    "description" TEXT,
    "reversesEntryId" TEXT,
    "totalDebit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalCredit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedBy" TEXT,
    "reversalReason" TEXT,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntryLine" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "taxCategorySnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntryLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "sourceModule" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "status" "AccountingEventStatus" NOT NULL DEFAULT 'PENDING',
    "journalEntryId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QoyodExportRecord" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "externalExportKey" TEXT NOT NULL,
    "status" "QoyodExportStatus" NOT NULL DEFAULT 'NOT_EXPORTED',
    "payloadSnapshot" JSONB,
    "responseSnapshot" JSONB,
    "qoyodReferenceId" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "exportedAt" TIMESTAMP(3),
    "exportedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QoyodExportRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_code_key" ON "Account"("code");

-- CreateIndex
CREATE INDEX "Account_type_idx" ON "Account"("type");

-- CreateIndex
CREATE INDEX "Account_parentId_idx" ON "Account"("parentId");

-- CreateIndex
CREATE INDEX "Account_isActive_idx" ON "Account"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TaxCategory_code_key" ON "TaxCategory"("code");

-- CreateIndex
CREATE INDEX "TaxCategory_isActive_idx" ON "TaxCategory"("isActive");

-- CreateIndex
CREATE INDEX "TaxCategory_categoryType_idx" ON "TaxCategory"("categoryType");

-- CreateIndex
CREATE INDEX "FiscalPeriod_status_idx" ON "FiscalPeriod"("status");

-- CreateIndex
CREATE INDEX "FiscalPeriod_startDate_endDate_idx" ON "FiscalPeriod"("startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalPeriod_year_periodNo_key" ON "FiscalPeriod"("year", "periodNo");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_entryNo_key" ON "JournalEntry"("entryNo");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversesEntryId_key" ON "JournalEntry"("reversesEntryId");

-- CreateIndex
CREATE INDEX "JournalEntry_status_idx" ON "JournalEntry"("status");

-- CreateIndex
CREATE INDEX "JournalEntry_fiscalPeriodId_idx" ON "JournalEntry"("fiscalPeriodId");

-- CreateIndex
CREATE INDEX "JournalEntry_entryDate_idx" ON "JournalEntry"("entryDate");

-- CreateIndex
CREATE INDEX "JournalEntry_sourceModule_sourceDocumentId_idx" ON "JournalEntry"("sourceModule", "sourceDocumentId");

-- CreateIndex
CREATE INDEX "JournalEntryLine_journalEntryId_idx" ON "JournalEntryLine"("journalEntryId");

-- CreateIndex
CREATE INDEX "JournalEntryLine_accountId_idx" ON "JournalEntryLine"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingEvent_idempotencyKey_key" ON "AccountingEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AccountingEvent_sourceModule_sourceDocumentId_idx" ON "AccountingEvent"("sourceModule", "sourceDocumentId");

-- CreateIndex
CREATE INDEX "AccountingEvent_status_idx" ON "AccountingEvent"("status");

-- CreateIndex
CREATE INDEX "AccountingEvent_eventType_idx" ON "AccountingEvent"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "QoyodExportRecord_externalExportKey_key" ON "QoyodExportRecord"("externalExportKey");

-- CreateIndex
CREATE INDEX "QoyodExportRecord_status_idx" ON "QoyodExportRecord"("status");

-- CreateIndex
CREATE INDEX "QoyodExportRecord_journalEntryId_idx" ON "QoyodExportRecord"("journalEntryId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "FiscalPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingEvent" ADD CONSTRAINT "AccountingEvent_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QoyodExportRecord" ADD CONSTRAINT "QoyodExportRecord_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Manual CHECK constraints (Prisma's schema language has no @check/@@check attribute — same
-- precedent as the five P0 constraints documented in docs/migration-drift-and-db-constraints.md
-- for GreenBean/RoastingBatch/FinishedGoodsLot). These must be reviewed if this migration is
-- ever regenerated, since `prisma migrate dev` will not detect or preserve them.

-- JournalEntryLine: debit and credit must both be non-negative, and exactly one of the two
-- must be greater than zero while the other is exactly zero (covers all four S0 rules:
-- debit >= 0, credit >= 0, not-both-positive, not-both-zero, in a single constraint).
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_debit_credit_exclusive_positive"
  CHECK (("debit" > 0 AND "credit" = 0) OR ("debit" = 0 AND "credit" > 0));

-- FiscalPeriod: startDate must be on or before endDate.
ALTER TABLE "FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_startDate_before_endDate"
  CHECK ("startDate" <= "endDate");
