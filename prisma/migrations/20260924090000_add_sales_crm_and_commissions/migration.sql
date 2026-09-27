-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WALK_IN', 'REFERRAL', 'PHONE', 'SOCIAL', 'EXHIBITION', 'WEBSITE', 'OTHER');

-- CreateEnum
CREATE TYPE "OpportunityOutcome" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "SampleStatus" AS ENUM ('PREPARING', 'SENT', 'FEEDBACK_RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('CALL', 'VISIT', 'MEETING', 'NOTE', 'TASK', 'SAMPLE_FOLLOW_UP');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'ISSUED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "CommissionBasis" AS ENUM ('NET_COLLECTION');

-- CreateEnum
CREATE TYPE "CommissionTierMode" AS ENUM ('INCREMENTAL', 'RETROACTIVE');

-- CreateEnum
CREATE TYPE "CollectionEventStatus" AS ENUM ('RECORDED', 'REVERSED');

-- CreateEnum
CREATE TYPE "AccrualStatus" AS ENUM ('PREVIEW', 'ACCRUED', 'APPROVED', 'PAID', 'REVERSED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('ACCRUAL', 'ADJUSTMENT', 'REVERSAL', 'PAYOUT');

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "companyNameAr" TEXT,
    "contactName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "city" TEXT,
    "address" TEXT,
    "source" "LeadSource" NOT NULL DEFAULT 'OTHER',
    "sourceNote" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "ownerId" TEXT NOT NULL,
    "nextFollowUpAt" TIMESTAMP(3),
    "notes" TEXT,
    "normalizedCompany" TEXT,
    "normalizedPhone" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadConversion" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "customerCreated" BOOLEAN NOT NULL DEFAULT false,
    "convertedById" TEXT,
    "convertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "probability" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "customerId" TEXT,
    "stageId" TEXT NOT NULL,
    "outcome" "OpportunityOutcome" NOT NULL DEFAULT 'OPEN',
    "lostReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "probability" INTEGER NOT NULL DEFAULT 0,
    "expectedCloseAt" TIMESTAMP(3),
    "nextFollowUpAt" TIMESTAMP(3),
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityOwner" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "sharePercent" DECIMAL(5,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityStageEvent" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "fromStageId" TEXT,
    "toStageId" TEXT,
    "fromOutcome" "OpportunityOutcome",
    "toOutcome" "OpportunityOutcome",
    "reason" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityStageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SampleShipment" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "productSkuId" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'KG',
    "status" "SampleStatus" NOT NULL DEFAULT 'PREPARING',
    "sentAt" TIMESTAMP(3),
    "feedbackAt" TIMESTAMP(3),
    "feedbackScore" INTEGER,
    "feedbackNotes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SampleShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT,
    "leadId" TEXT,
    "opportunityId" TEXT,
    "customerId" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "quoteNumber" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "opportunityId" TEXT NOT NULL,
    "customerId" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "validUntil" TIMESTAMP(3),
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "issuedSnapshot" JSONB,
    "issuedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionNote" TEXT,
    "discountApprovedById" TEXT,
    "discountApprovedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "productSkuId" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'KG',
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "lineSubtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lineTax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityOrder" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "quoteId" TEXT,
    "orderId" TEXT NOT NULL,
    "isFirstOrder" BOOLEAN NOT NULL DEFAULT false,
    "requestKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionPlanVersion" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "basis" "CommissionBasis" NOT NULL DEFAULT 'NET_COLLECTION',
    "tierMode" "CommissionTierMode" NOT NULL DEFAULT 'INCREMENTAL',
    "baseRatePercent" DECIMAL(9,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionPlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionTier" (
    "id" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "fromAmount" DECIMAL(18,2) NOT NULL,
    "toAmount" DECIMAL(18,2),
    "ratePercent" DECIMAL(9,6) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CommissionTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionAssignment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionEvent" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL DEFAULT 'SANDBOX',
    "externalRef" TEXT NOT NULL,
    "status" "CollectionEventStatus" NOT NULL DEFAULT 'RECORDED',
    "customerId" TEXT,
    "opportunityId" TEXT,
    "orderId" TEXT,
    "amountGross" DECIMAL(18,2) NOT NULL,
    "amountTax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amountNonQualifying" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversalOfId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionAccrual" (
    "id" TEXT NOT NULL,
    "collectionEventId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "qualifyingBase" DECIMAL(18,2) NOT NULL,
    "sharePercent" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "effectiveRatePercent" DECIMAL(9,6) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "status" "AccrualStatus" NOT NULL DEFAULT 'ACCRUED',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionAccrual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionLedgerEntry" (
    "id" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "employeeId" TEXT NOT NULL,
    "accrualId" TEXT,
    "correctsId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "reason" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesTarget" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "targetAmount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "bonusAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lead_ownerId_status_idx" ON "Lead"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Lead_status_nextFollowUpAt_idx" ON "Lead"("status", "nextFollowUpAt");

-- CreateIndex
CREATE INDEX "Lead_normalizedCompany_idx" ON "Lead"("normalizedCompany");

-- CreateIndex
CREATE INDEX "Lead_normalizedPhone_idx" ON "Lead"("normalizedPhone");

-- CreateIndex
CREATE UNIQUE INDEX "LeadConversion_leadId_key" ON "LeadConversion"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadConversion_opportunityId_key" ON "LeadConversion"("opportunityId");

-- CreateIndex
CREATE INDEX "LeadConversion_customerId_idx" ON "LeadConversion"("customerId");

-- CreateIndex
CREATE INDEX "LeadConversion_convertedAt_idx" ON "LeadConversion"("convertedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_code_key" ON "PipelineStage"("code");

-- CreateIndex
CREATE INDEX "PipelineStage_position_idx" ON "PipelineStage"("position");

-- CreateIndex
CREATE INDEX "Opportunity_ownerId_outcome_idx" ON "Opportunity"("ownerId", "outcome");

-- CreateIndex
CREATE INDEX "Opportunity_stageId_outcome_idx" ON "Opportunity"("stageId", "outcome");

-- CreateIndex
CREATE INDEX "Opportunity_outcome_closedAt_idx" ON "Opportunity"("outcome", "closedAt");

-- CreateIndex
CREATE INDEX "Opportunity_nextFollowUpAt_idx" ON "Opportunity"("nextFollowUpAt");

-- CreateIndex
CREATE INDEX "OpportunityOwner_employeeId_idx" ON "OpportunityOwner"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityOwner_opportunityId_employeeId_key" ON "OpportunityOwner"("opportunityId", "employeeId");

-- CreateIndex
CREATE INDEX "OpportunityStageEvent_opportunityId_createdAt_idx" ON "OpportunityStageEvent"("opportunityId", "createdAt");

-- CreateIndex
CREATE INDEX "SampleShipment_opportunityId_status_idx" ON "SampleShipment"("opportunityId", "status");

-- CreateIndex
CREATE INDEX "Activity_ownerId_completedAt_dueAt_idx" ON "Activity"("ownerId", "completedAt", "dueAt");

-- CreateIndex
CREATE INDEX "Activity_leadId_idx" ON "Activity"("leadId");

-- CreateIndex
CREATE INDEX "Activity_opportunityId_idx" ON "Activity"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_quoteNumber_key" ON "Quote"("quoteNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_supersedesId_key" ON "Quote"("supersedesId");

-- CreateIndex
CREATE INDEX "Quote_opportunityId_status_idx" ON "Quote"("opportunityId", "status");

-- CreateIndex
CREATE INDEX "Quote_customerId_idx" ON "Quote"("customerId");

-- CreateIndex
CREATE INDEX "QuoteLine_quoteId_position_idx" ON "QuoteLine"("quoteId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityOrder_requestKey_key" ON "OpportunityOrder"("requestKey");

-- CreateIndex
CREATE INDEX "OpportunityOrder_opportunityId_idx" ON "OpportunityOrder"("opportunityId");

-- CreateIndex
CREATE INDEX "OpportunityOrder_orderId_idx" ON "OpportunityOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityOrder_quoteId_orderId_key" ON "OpportunityOrder"("quoteId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionPlan_code_key" ON "CommissionPlan"("code");

-- CreateIndex
CREATE INDEX "CommissionPlanVersion_effectiveFrom_idx" ON "CommissionPlanVersion"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionPlanVersion_planId_version_key" ON "CommissionPlanVersion"("planId", "version");

-- CreateIndex
CREATE INDEX "CommissionTier_planVersionId_position_idx" ON "CommissionTier"("planVersionId", "position");

-- CreateIndex
CREATE INDEX "CommissionAssignment_employeeId_effectiveFrom_idx" ON "CommissionAssignment"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "CollectionEvent_customerId_collectedAt_idx" ON "CollectionEvent"("customerId", "collectedAt");

-- CreateIndex
CREATE INDEX "CollectionEvent_collectedAt_idx" ON "CollectionEvent"("collectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionEvent_sourceSystem_externalRef_key" ON "CollectionEvent"("sourceSystem", "externalRef");

-- CreateIndex
CREATE INDEX "CommissionAccrual_employeeId_periodStart_idx" ON "CommissionAccrual"("employeeId", "periodStart");

-- CreateIndex
CREATE INDEX "CommissionAccrual_status_periodStart_idx" ON "CommissionAccrual"("status", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionAccrual_collectionEventId_employeeId_planVersionI_key" ON "CommissionAccrual"("collectionEventId", "employeeId", "planVersionId");

-- CreateIndex
CREATE INDEX "CommissionLedgerEntry_employeeId_periodStart_idx" ON "CommissionLedgerEntry"("employeeId", "periodStart");

-- CreateIndex
CREATE INDEX "CommissionLedgerEntry_type_createdAt_idx" ON "CommissionLedgerEntry"("type", "createdAt");

-- CreateIndex
CREATE INDEX "SalesTarget_periodStart_idx" ON "SalesTarget"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "SalesTarget_employeeId_periodStart_key" ON "SalesTarget"("employeeId", "periodStart");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadConversion" ADD CONSTRAINT "LeadConversion_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadConversion" ADD CONSTRAINT "LeadConversion_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadConversion" ADD CONSTRAINT "LeadConversion_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityOwner" ADD CONSTRAINT "OpportunityOwner_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityOwner" ADD CONSTRAINT "OpportunityOwner_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityStageEvent" ADD CONSTRAINT "OpportunityStageEvent_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityStageEvent" ADD CONSTRAINT "OpportunityStageEvent_toStageId_fkey" FOREIGN KEY ("toStageId") REFERENCES "PipelineStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SampleShipment" ADD CONSTRAINT "SampleShipment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SampleShipment" ADD CONSTRAINT "SampleShipment_productSkuId_fkey" FOREIGN KEY ("productSkuId") REFERENCES "ProductSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_productSkuId_fkey" FOREIGN KEY ("productSkuId") REFERENCES "ProductSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityOrder" ADD CONSTRAINT "OpportunityOrder_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityOrder" ADD CONSTRAINT "OpportunityOrder_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityOrder" ADD CONSTRAINT "OpportunityOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPlanVersion" ADD CONSTRAINT "CommissionPlanVersion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CommissionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionTier" ADD CONSTRAINT "CommissionTier_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "CommissionPlanVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAssignment" ADD CONSTRAINT "CommissionAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAssignment" ADD CONSTRAINT "CommissionAssignment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CommissionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAssignment" ADD CONSTRAINT "CommissionAssignment_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "CommissionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionEvent" ADD CONSTRAINT "CollectionEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionEvent" ADD CONSTRAINT "CollectionEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAccrual" ADD CONSTRAINT "CommissionAccrual_collectionEventId_fkey" FOREIGN KEY ("collectionEventId") REFERENCES "CollectionEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAccrual" ADD CONSTRAINT "CommissionAccrual_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAccrual" ADD CONSTRAINT "CommissionAccrual_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "CommissionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionLedgerEntry" ADD CONSTRAINT "CommissionLedgerEntry_accrualId_fkey" FOREIGN KEY ("accrualId") REFERENCES "CommissionAccrual"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesTarget" ADD CONSTRAINT "SalesTarget_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

