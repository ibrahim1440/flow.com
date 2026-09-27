-- CreateEnum
CREATE TYPE "ActivityOutcome" AS ENUM ('NO_ANSWER', 'LEFT_MESSAGE', 'INTERESTED', 'MEETING_SCHEDULED', 'VISIT_SCHEDULED', 'MEETING_COMPLETED', 'VISIT_COMPLETED', 'FOLLOW_UP_REQUIRED', 'NOT_INTERESTED', 'NOTE_ONLY');

-- CreateEnum
CREATE TYPE "SalesCollectionMethod" AS ENUM ('BANK_TRANSFER', 'CASH', 'CHEQUE', 'POS_CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "SalesCollectionStatus" AS ENUM ('PENDING_VERIFICATION', 'APPROVED', 'REJECTED', 'REVERSED');

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "outcome" "ActivityOutcome";

-- CreateTable
CREATE TABLE "SalesCollection" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "quoteId" TEXT,
    "orderId" TEXT,
    "customerId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "amountGross" DECIMAL(18,2) NOT NULL,
    "amountTax" DECIMAL(18,2) NOT NULL,
    "amountNet" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "paymentMethod" "SalesCollectionMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "status" "SalesCollectionStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "submittedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "collectionEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionEvidence" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesCollection_collectionEventId_key" ON "SalesCollection"("collectionEventId");

-- CreateIndex
CREATE INDEX "SalesCollection_opportunityId_status_idx" ON "SalesCollection"("opportunityId", "status");

-- CreateIndex
CREATE INDEX "SalesCollection_status_submittedAt_idx" ON "SalesCollection"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "SalesCollection_submittedById_submittedAt_idx" ON "SalesCollection"("submittedById", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesCollection_submittedById_idempotencyKey_key" ON "SalesCollection"("submittedById", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CollectionEvidence_collectionId_idx" ON "CollectionEvidence"("collectionId");

-- AddForeignKey
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_collectionEventId_fkey" FOREIGN KEY ("collectionEventId") REFERENCES "CollectionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionEvidence" ADD CONSTRAINT "CollectionEvidence_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "SalesCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionEvidence" ADD CONSTRAINT "CollectionEvidence_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariants Prisma cannot express, put where they cannot be bypassed.
--
-- Every one of these is something a service could enforce and a later refactor could
-- quietly stop enforcing. What they protect is somebody's pay, so they live in the
-- database as well as in the code.
-- ─────────────────────────────────────────────────────────────────────────────

-- A collection is the claim that money arrived. Zero or negative is not a receipt.
ALTER TABLE "SalesCollection"
  ADD CONSTRAINT "SalesCollection_amounts_positive"
  CHECK ("amountGross" > 0 AND "amountTax" >= 0 AND "amountNet" > 0);

-- Net is what commission is computed on, and it is gross less tax by definition. All three
-- are stored on purpose — the figures a decision was made against must survive a later
-- revision of the quotation — and this is what stops them drifting apart.
ALTER TABLE "SalesCollection"
  ADD CONSTRAINT "SalesCollection_net_reconciles"
  CHECK ("amountNet" = "amountGross" - "amountTax");

-- The invariant the whole commission guarantee rests on: an approved (or later reversed)
-- collection names the commission event it produced, and a pending or rejected one has
-- produced nothing at all.
ALTER TABLE "SalesCollection"
  ADD CONSTRAINT "SalesCollection_event_matches_status"
  CHECK (
    ("status" IN ('APPROVED', 'REVERSED') AND "collectionEventId" IS NOT NULL)
    OR ("status" IN ('PENDING_VERIFICATION', 'REJECTED') AND "collectionEventId" IS NULL)
  );

-- A refusal and a reversal each have to say why. A blank reason is the same as no reason.
ALTER TABLE "SalesCollection"
  ADD CONSTRAINT "SalesCollection_rejection_has_reason"
  CHECK ("status" <> 'REJECTED' OR ("decisionReason" IS NOT NULL AND length(btrim("decisionReason")) > 0));

ALTER TABLE "SalesCollection"
  ADD CONSTRAINT "SalesCollection_reversal_has_reason"
  CHECK ("status" <> 'REVERSED' OR ("reversalReason" IS NOT NULL AND length(btrim("reversalReason")) > 0));

-- Evidence is a receipt photo, not a file store. Five megabytes, enforced here too.
ALTER TABLE "CollectionEvidence"
  ADD CONSTRAINT "CollectionEvidence_size_sane"
  CHECK ("byteSize" > 0 AND "byteSize" <= 5242880);
