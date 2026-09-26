-- CreateEnum
CREATE TYPE "CashAccountType" AS ENUM ('BANK', 'CASH', 'GATEWAY_CLEARING');

-- CreateEnum
CREATE TYPE "BankTxnStatus" AS ENUM ('PENDING', 'CONFIRMED', 'VOID');

-- CreateEnum
CREATE TYPE "BankTxnSource" AS ENUM ('MANUAL', 'CSV_IMPORT', 'CONNECTOR');

-- CreateEnum
CREATE TYPE "BankTxnReview" AS ENUM ('NEEDS_REVIEW', 'REVIEWED');

-- CreateEnum
CREATE TYPE "BankTxnClass" AS ENUM ('UNCLASSIFIED', 'CUSTOMER_RECEIPT', 'POS_SETTLEMENT', 'GATEWAY_SETTLEMENT', 'OTHER_OPERATING_RECEIPT', 'INTERNAL_TRANSFER', 'LOAN_PROCEEDS', 'OWNER_CONTRIBUTION', 'REFUND_RECEIVED', 'SUPPLIER_PAYMENT', 'PAYROLL', 'RENT', 'UTILITIES_OPERATING', 'TAX_PAYMENT', 'LOAN_PRINCIPAL_REPAYMENT', 'LOAN_INTEREST', 'BANK_FEE', 'CUSTOMER_REFUND', 'OWNER_DRAWING', 'OTHER_OPERATING_PAYMENT');

-- CreateEnum
CREATE TYPE "FinCategoryKind" AS ENUM ('RECEIPT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "FinMatchTarget" AS ENUM ('ORDER', 'OBLIGATION', 'PURCHASE_RECORD', 'SALES_COLLECTION');

-- CreateEnum
CREATE TYPE "FinReconStatus" AS ENUM ('DRAFT', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AllocFundingType" AS ENUM ('MONTHLY_TARGET', 'RESERVE_TARGET', 'OPEN');

-- CreateEnum
CREATE TYPE "AllocRollover" AS ENUM ('CARRY_FORWARD', 'SWEEP_TO_UNALLOCATED');

-- CreateEnum
CREATE TYPE "AllocRuleStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SUPERSEDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AllocMethod" AS ENUM ('PERCENT_OF_BASE', 'FILL_TARGET', 'FUND_OBLIGATIONS', 'RECEIPT_TAX_COMPONENT', 'WEIGHTED_REMAINDER', 'LEAVE_UNALLOCATED');

-- CreateEnum
CREATE TYPE "AllocEntryType" AS ENUM ('ALLOCATION', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "AllocSourceType" AS ENUM ('RECEIPT', 'OPENING_BALANCE', 'CATEGORY_TRANSFER', 'RECEIPT_REVERSAL', 'PAYMENT', 'MANUAL_ADJUSTMENT', 'PERIOD_SWEEP');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'EXECUTED', 'RELEASED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ObligationType" AS ENUM ('SUPPLIER_BILL', 'PURCHASE_ORDER', 'PAYROLL', 'RENT', 'TAX', 'LOAN_REPAYMENT', 'UTILITIES', 'OTHER');

-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ForecastItemKind" AS ENUM ('RECEIPT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "ForecastItemStatus" AS ENUM ('OPEN', 'REALIZED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BudgetStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "BudgetRevisionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BudgetBasis" AS ENUM ('CASH', 'ACCRUAL');

-- CreateEnum
CREATE TYPE "BudgetLineKind" AS ENUM ('RECEIPT', 'PAYMENT', 'SALES_MEMO');

-- CreateEnum
CREATE TYPE "PhasingMethod" AS ENUM ('DUE_DATE', 'CUSTOM_WEIGHTS', 'STRAIGHT_LINE');

-- CreateEnum
CREATE TYPE "FinApprovalType" AS ENUM ('BUDGET_APPROVAL', 'ALLOCATION_RULES', 'CATEGORY_TRANSFER', 'SPEND_OVERRIDE', 'PERIOD_REOPEN');

-- CreateEnum
CREATE TYPE "FinApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VarianceNoteStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "FinSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "baseCurrency" TEXT NOT NULL DEFAULT 'SAR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    "allowSelfApproval" BOOLEAN NOT NULL DEFAULT false,
    "reconciliationDueDays" INTEGER NOT NULL DEFAULT 7,
    "alertAmountThreshold" DECIMAL(18,2) NOT NULL DEFAULT 1000,
    "alertPercentThreshold" DECIMAL(7,2) NOT NULL DEFAULT 10,
    "alertThresholdMode" TEXT NOT NULL DEFAULT 'EITHER',
    "obligationAlertDays" INTEGER NOT NULL DEFAULT 7,
    "conservativeDelayWeeks" INTEGER NOT NULL DEFAULT 2,
    "conservativeCollectPct" INTEGER NOT NULL DEFAULT 80,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "FinSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinBranch" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "FinBranch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinBranchAccess" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "FinBranchAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinCostCenter" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT,
    "branchKey" TEXT NOT NULL DEFAULT 'COMPANY',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "FinCostCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT,
    "kind" "FinCategoryKind" NOT NULL,
    "isOperating" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "FinCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashAccount" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT,
    "type" "CashAccountType" NOT NULL DEFAULT 'BANK',
    "branchKey" TEXT NOT NULL DEFAULT 'COMPANY',
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "bankName" TEXT,
    "accountLast4" TEXT,
    "isRestricted" BOOLEAN NOT NULL DEFAULT false,
    "openingBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "openingBalanceDate" DATE NOT NULL,
    "glAccountId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "CashAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "cashAccountId" TEXT NOT NULL,
    "branchKey" TEXT NOT NULL,
    "txnDate" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "grossAmount" DECIMAL(18,2),
    "feeAmount" DECIMAL(18,2),
    "bankReference" TEXT,
    "description" TEXT,
    "counterparty" TEXT,
    "status" "BankTxnStatus" NOT NULL DEFAULT 'CONFIRMED',
    "source" "BankTxnSource" NOT NULL DEFAULT 'MANUAL',
    "classification" "BankTxnClass" NOT NULL DEFAULT 'UNCLASSIFIED',
    "reviewStatus" "BankTxnReview" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "reviewNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "sourceFingerprint" TEXT,
    "idempotencyKey" TEXT,
    "possibleDuplicateOfId" TEXT,
    "transferPeerId" TEXT,
    "importBatchId" TEXT,
    "reconciliationId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransactionSplit" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "finCategoryId" TEXT NOT NULL,
    "costCenterId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransactionSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransactionMatch" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "targetType" "FinMatchTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "BankTransactionMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankImportBatch" (
    "id" TEXT NOT NULL,
    "cashAccountId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "importedCount" INTEGER NOT NULL,
    "duplicateCount" INTEGER NOT NULL,
    "flaggedCount" INTEGER NOT NULL,
    "errorCount" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "BankImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankReconciliation" (
    "id" TEXT NOT NULL,
    "cashAccountId" TEXT NOT NULL,
    "statementDate" DATE NOT NULL,
    "statementBalance" DECIMAL(18,2) NOT NULL,
    "ledgerBalance" DECIMAL(18,2) NOT NULL,
    "pendingTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "difference" DECIMAL(18,2) NOT NULL,
    "status" "FinReconStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,

    CONSTRAINT "BankReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinAttachment" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "FinAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT,
    "branchKey" TEXT NOT NULL DEFAULT 'COMPANY',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "fundingType" "AllocFundingType" NOT NULL DEFAULT 'OPEN',
    "targetAmount" DECIMAL(18,2),
    "replenish" BOOLEAN NOT NULL DEFAULT false,
    "targetStartMonth" TEXT,
    "targetEndMonth" TEXT,
    "dueDay" INTEGER,
    "rollover" "AllocRollover" NOT NULL DEFAULT 'CARRY_FORWARD',
    "spendingLimit" DECIMAL(18,2),
    "approverEmployeeId" TEXT,
    "finCategoryId" TEXT,
    "costCenterId" TEXT,
    "isTaxReserve" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "AllocationCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationRuleVersion" (
    "id" TEXT NOT NULL,
    "branchKey" TEXT NOT NULL DEFAULT 'COMPANY',
    "versionNo" INTEGER NOT NULL,
    "status" "AllocRuleStatus" NOT NULL DEFAULT 'DRAFT',
    "baseClasses" "BankTxnClass"[],
    "autoExecute" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "AllocationRuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationRuleStep" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "method" "AllocMethod" NOT NULL,
    "categoryId" TEXT,
    "percent" DECIMAL(7,4),
    "weight" INTEGER,
    "capAmount" DECIMAL(18,2),

    CONSTRAINT "AllocationRuleStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationRun" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "sourceTxnId" TEXT NOT NULL,
    "baseAmount" DECIMAL(18,2) NOT NULL,
    "allocatedTotal" DECIMAL(18,2) NOT NULL,
    "leftUnallocated" DECIMAL(18,2) NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "AllocationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationEntry" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "branchKey" TEXT NOT NULL,
    "entryType" "AllocEntryType" NOT NULL,
    "sourceType" "AllocSourceType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "sourceTxnId" TEXT,
    "sourceCashAccountId" TEXT,
    "runId" TEXT,
    "ruleVersionId" TEXT,
    "stepSeq" INTEGER,
    "reservationId" TEXT,
    "approvalId" TEXT,
    "reversesEntryId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "AllocationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReservation" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "branchKey" TEXT NOT NULL,
    "obligationId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "payee" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "dueDate" DATE,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "requiresOverride" BOOLEAN NOT NULL DEFAULT false,
    "approvalId" TEXT,
    "executedTxnId" TEXT,
    "executedAt" TIMESTAMP(3),
    "executedBy" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "releaseReason" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "PaymentReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinObligation" (
    "id" TEXT NOT NULL,
    "branchKey" TEXT NOT NULL DEFAULT 'COMPANY',
    "type" "ObligationType" NOT NULL,
    "description" TEXT NOT NULL,
    "counterparty" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "dueDate" DATE NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'OPEN',
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "supersedesId" TEXT,
    "allocationCategoryId" TEXT,
    "finCategoryId" TEXT,
    "costCenterId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinForecastItem" (
    "id" TEXT NOT NULL,
    "branchKey" TEXT NOT NULL DEFAULT 'COMPANY',
    "kind" "ForecastItemKind" NOT NULL,
    "description" TEXT NOT NULL,
    "counterparty" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "expectedDate" DATE NOT NULL,
    "finCategoryId" TEXT,
    "status" "ForecastItemStatus" NOT NULL DEFAULT 'OPEN',
    "realizedTxnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinForecastItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinBudget" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "branchKey" TEXT NOT NULL DEFAULT 'COMPANY',
    "costCenterId" TEXT,
    "basis" "BudgetBasis" NOT NULL DEFAULT 'CASH',
    "status" "BudgetStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,

    CONSTRAINT "FinBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetRevision" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "revisionNo" INTEGER NOT NULL,
    "status" "BudgetRevisionStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decisionNote" TEXT,

    CONSTRAINT "BudgetRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetLine" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL,
    "finCategoryId" TEXT NOT NULL,
    "costCenterId" TEXT,
    "kind" "BudgetLineKind" NOT NULL,
    "plannedAmount" DECIMAL(18,2) NOT NULL,
    "ownerEmployeeId" TEXT,
    "assumptions" TEXT,
    "dueDate" DATE,
    "phasing" "PhasingMethod" NOT NULL DEFAULT 'DUE_DATE',
    "phasingWeights" JSONB,

    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinVarianceNote" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "correctiveAction" TEXT,
    "responsibleEmployeeId" TEXT,
    "followUpDate" DATE,
    "status" "VarianceNoteStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "FinVarianceNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinForecastSnapshot" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "branchKey" TEXT NOT NULL DEFAULT 'COMPANY',
    "budgetId" TEXT,
    "month" TEXT,
    "cutoffDate" DATE NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "FinForecastSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinApprovalRequest" (
    "id" TEXT NOT NULL,
    "type" "FinApprovalType" NOT NULL,
    "branchKey" TEXT NOT NULL DEFAULT 'COMPANY',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "requiredSub" TEXT NOT NULL,
    "assignedToId" TEXT,
    "status" "FinApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "FinApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinAuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "branchKey" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "refs" JSONB,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinBranch_code_key" ON "FinBranch"("code");

-- CreateIndex
CREATE INDEX "FinBranchAccess_employeeId_idx" ON "FinBranchAccess"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "FinBranchAccess_employeeId_branchId_key" ON "FinBranchAccess"("employeeId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "FinCostCenter_code_key" ON "FinCostCenter"("code");

-- CreateIndex
CREATE UNIQUE INDEX "FinCategory_code_key" ON "FinCategory"("code");

-- CreateIndex
CREATE UNIQUE INDEX "CashAccount_code_key" ON "CashAccount"("code");

-- CreateIndex
CREATE INDEX "CashAccount_branchKey_idx" ON "CashAccount"("branchKey");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_transferPeerId_key" ON "BankTransaction"("transferPeerId");

-- CreateIndex
CREATE INDEX "BankTransaction_branchKey_txnDate_idx" ON "BankTransaction"("branchKey", "txnDate");

-- CreateIndex
CREATE INDEX "BankTransaction_cashAccountId_txnDate_idx" ON "BankTransaction"("cashAccountId", "txnDate");

-- CreateIndex
CREATE INDEX "BankTransaction_reviewStatus_idx" ON "BankTransaction"("reviewStatus");

-- CreateIndex
CREATE INDEX "BankTransaction_classification_idx" ON "BankTransaction"("classification");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_cashAccountId_sourceFingerprint_key" ON "BankTransaction"("cashAccountId", "sourceFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_createdBy_idempotencyKey_key" ON "BankTransaction"("createdBy", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BankTransactionSplit_transactionId_idx" ON "BankTransactionSplit"("transactionId");

-- CreateIndex
CREATE INDEX "BankTransactionSplit_finCategoryId_idx" ON "BankTransactionSplit"("finCategoryId");

-- CreateIndex
CREATE INDEX "BankTransactionMatch_transactionId_idx" ON "BankTransactionMatch"("transactionId");

-- CreateIndex
CREATE INDEX "BankTransactionMatch_targetType_targetId_idx" ON "BankTransactionMatch"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "BankImportBatch_cashAccountId_createdAt_idx" ON "BankImportBatch"("cashAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "BankReconciliation_cashAccountId_statementDate_idx" ON "BankReconciliation"("cashAccountId", "statementDate");

-- CreateIndex
CREATE INDEX "FinAttachment_entityType_entityId_idx" ON "FinAttachment"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationCategory_code_key" ON "AllocationCategory"("code");

-- CreateIndex
CREATE INDEX "AllocationCategory_branchKey_idx" ON "AllocationCategory"("branchKey");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationRuleVersion_branchKey_versionNo_key" ON "AllocationRuleVersion"("branchKey", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationRuleStep_versionId_seq_key" ON "AllocationRuleStep"("versionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationRun_sourceTxnId_key" ON "AllocationRun"("sourceTxnId");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationEntry_reversesEntryId_key" ON "AllocationEntry"("reversesEntryId");

-- CreateIndex
CREATE INDEX "AllocationEntry_categoryId_periodMonth_idx" ON "AllocationEntry"("categoryId", "periodMonth");

-- CreateIndex
CREATE INDEX "AllocationEntry_sourceTxnId_idx" ON "AllocationEntry"("sourceTxnId");

-- CreateIndex
CREATE INDEX "AllocationEntry_branchKey_idx" ON "AllocationEntry"("branchKey");

-- CreateIndex
CREATE INDEX "PaymentReservation_categoryId_status_idx" ON "PaymentReservation"("categoryId", "status");

-- CreateIndex
CREATE INDEX "PaymentReservation_obligationId_idx" ON "PaymentReservation"("obligationId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReservation_createdBy_idempotencyKey_key" ON "PaymentReservation"("createdBy", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "FinObligation_supersedesId_key" ON "FinObligation"("supersedesId");

-- CreateIndex
CREATE INDEX "FinObligation_branchKey_dueDate_idx" ON "FinObligation"("branchKey", "dueDate");

-- CreateIndex
CREATE INDEX "FinObligation_status_idx" ON "FinObligation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FinObligation_sourceType_sourceId_key" ON "FinObligation"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "FinForecastItem_branchKey_expectedDate_idx" ON "FinForecastItem"("branchKey", "expectedDate");

-- CreateIndex
CREATE UNIQUE INDEX "FinBudget_month_branchKey_key" ON "FinBudget"("month", "branchKey");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetRevision_budgetId_revisionNo_key" ON "BudgetRevision"("budgetId", "revisionNo");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLine_revisionId_lineKey_key" ON "BudgetLine"("revisionId", "lineKey");

-- CreateIndex
CREATE INDEX "FinVarianceNote_budgetId_lineKey_idx" ON "FinVarianceNote"("budgetId", "lineKey");

-- CreateIndex
CREATE INDEX "FinForecastSnapshot_kind_branchKey_cutoffDate_idx" ON "FinForecastSnapshot"("kind", "branchKey", "cutoffDate");

-- CreateIndex
CREATE INDEX "FinApprovalRequest_status_requiredSub_idx" ON "FinApprovalRequest"("status", "requiredSub");

-- CreateIndex
CREATE INDEX "FinApprovalRequest_assignedToId_status_idx" ON "FinApprovalRequest"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "FinApprovalRequest_entityType_entityId_idx" ON "FinApprovalRequest"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "FinAuditLog_entityType_entityId_idx" ON "FinAuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "FinAuditLog_createdAt_idx" ON "FinAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "FinBranchAccess" ADD CONSTRAINT "FinBranchAccess_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "FinBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "BankImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "BankReconciliation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransactionSplit" ADD CONSTRAINT "BankTransactionSplit_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "BankTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransactionMatch" ADD CONSTRAINT "BankTransactionMatch_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankImportBatch" ADD CONSTRAINT "BankImportBatch_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReconciliation" ADD CONSTRAINT "BankReconciliation_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationRuleStep" ADD CONSTRAINT "AllocationRuleStep_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "AllocationRuleVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationRun" ADD CONSTRAINT "AllocationRun_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "AllocationRuleVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationEntry" ADD CONSTRAINT "AllocationEntry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "AllocationCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationEntry" ADD CONSTRAINT "AllocationEntry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AllocationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReservation" ADD CONSTRAINT "PaymentReservation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "AllocationCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetRevision" ADD CONSTRAINT "BudgetRevision_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "FinBudget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "BudgetRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Hand-written integrity rules (not expressible in schema.prisma) ─────────────────
-- Same precedent as the Accounting S0 debit/credit CHECKs: the database refuses shapes
-- the service layer must never produce, so a bug cannot silently corrupt balances.

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_amount_nonzero" CHECK ("amount" <> 0),
  ADD CONSTRAINT "BankTransaction_settlement_consistent" CHECK (
    ("grossAmount" IS NULL AND "feeAmount" IS NULL)
    OR ("grossAmount" IS NOT NULL AND "feeAmount" IS NOT NULL
        AND "feeAmount" >= 0 AND "grossAmount" - "feeAmount" = "amount")
  );

ALTER TABLE "BankTransactionMatch"
  ADD CONSTRAINT "BankTransactionMatch_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "BankTransactionMatch_tax_bounded" CHECK ("taxAmount" >= 0 AND "taxAmount" <= "amount");

-- One live link per bank line and document; removed links stay as history.
CREATE UNIQUE INDEX "BankTransactionMatch_active_unique"
  ON "BankTransactionMatch" ("transactionId", "targetType", "targetId") WHERE "active";

ALTER TABLE "AllocationEntry" ADD CONSTRAINT "AllocationEntry_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "PaymentReservation" ADD CONSTRAINT "PaymentReservation_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "FinObligation" ADD CONSTRAINT "FinObligation_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "FinForecastItem" ADD CONSTRAINT "FinForecastItem_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_planned_nonnegative" CHECK ("plannedAmount" >= 0);
ALTER TABLE "AllocationRuleStep" ADD CONSTRAINT "AllocationRuleStep_percent_range"
  CHECK ("percent" IS NULL OR ("percent" > 0 AND "percent" <= 100));
ALTER TABLE "AllocationRuleStep" ADD CONSTRAINT "AllocationRuleStep_weight_positive"
  CHECK ("weight" IS NULL OR "weight" > 0);

-- At most one ACTIVE allocation rule version per scope.
CREATE UNIQUE INDEX "AllocationRuleVersion_one_active"
  ON "AllocationRuleVersion" ("branchKey") WHERE "status" = 'ACTIVE';

-- At most one completed reconciliation per account and statement date.
CREATE UNIQUE INDEX "BankReconciliation_completed_unique"
  ON "BankReconciliation" ("cashAccountId", "statementDate") WHERE "status" = 'COMPLETED';

-- Append-only ledgers: corrections are new rows (reversals/adjustments), never edits.
CREATE OR REPLACE FUNCTION fin_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this is an append-only financial record', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AllocationEntry_append_only" BEFORE UPDATE OR DELETE ON "AllocationEntry"
  FOR EACH ROW EXECUTE FUNCTION fin_forbid_mutation();
CREATE TRIGGER "FinAuditLog_append_only" BEFORE UPDATE OR DELETE ON "FinAuditLog"
  FOR EACH ROW EXECUTE FUNCTION fin_forbid_mutation();
CREATE TRIGGER "AllocationRun_append_only" BEFORE UPDATE OR DELETE ON "AllocationRun"
  FOR EACH ROW EXECUTE FUNCTION fin_forbid_mutation();

-- Bank lines are voided, never deleted.
CREATE TRIGGER "BankTransaction_no_delete" BEFORE DELETE ON "BankTransaction"
  FOR EACH ROW EXECUTE FUNCTION fin_forbid_mutation();

-- An approved budget revision is the baseline: its lines can never change.
CREATE OR REPLACE FUNCTION fin_protect_approved_budget_line() RETURNS trigger AS $$
DECLARE rev_status text;
BEGIN
  SELECT "status" INTO rev_status FROM "BudgetRevision"
    WHERE "id" = COALESCE(OLD."revisionId", NEW."revisionId");
  IF rev_status IN ('APPROVED', 'SUBMITTED') THEN
    RAISE EXCEPTION 'Budget lines of a % revision cannot be changed; create a new revision', rev_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BudgetLine_protect_approved" BEFORE UPDATE OR DELETE ON "BudgetLine"
  FOR EACH ROW EXECUTE FUNCTION fin_protect_approved_budget_line();

-- Approved revisions themselves are immutable apart from nothing: status may not leave APPROVED.
CREATE OR REPLACE FUNCTION fin_protect_approved_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."status" = 'APPROVED' THEN
    RAISE EXCEPTION 'An approved budget revision cannot be deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'APPROVED' AND
     (NEW."status" <> 'APPROVED' OR NEW."revisionNo" <> OLD."revisionNo" OR NEW."budgetId" <> OLD."budgetId") THEN
    RAISE EXCEPTION 'An approved budget revision cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BudgetRevision_protect_approved" BEFORE UPDATE OR DELETE ON "BudgetRevision"
  FOR EACH ROW EXECUTE FUNCTION fin_protect_approved_revision();
