-- Production simplification, Phase A (docs/handoff/production-simplification, owner decisions D1–D4).
-- ADDITIVE ONLY: nullable columns with no default on "SystemConfig" and "RoastingBatch" (no existing row
-- is rewritten and nothing reads differently until somebody writes them), one new table, its index and
-- foreign key, and CHECK constraints that every existing row satisfies (the new columns are NULL there).
-- Nothing is dropped, renamed, retyped, made NOT NULL or back-filled.
--   SystemConfig.qcMinEvaluators (INTEGER, CHECK 1–10): Settings › Production & roasting › QC, the
--     minimum number of evaluators per batch (D1). NULL = the built-in 2 applies;
--   RoastingBatch.qcOverride / qcOverrideReason / qcOverrideById / qcOverrideAt / qcOverrideMin: the
--     exceptional approval with fewer evaluators than the minimum (D2), recorded on the batch. CHECK:
--     qcOverride = true needs a non-blank reason, the actor and the time;
--   QcInvite: guest evaluators invited by the QC manager (D4), present on the device or sent a link;
--     CASCADE from "RoastingBatch" (a deleted batch takes its invites, as it takes its QC records).
-- Atomic: the whole file runs in one transaction. ADD COLUMN without a default is metadata-only; the
-- CHECKs on the new columns validate against NULLs only.
-- Rollback: docs/hr/migration-review/rollback-20261023090000_production_qc_simplify.sql.
BEGIN;

-- AlterTable
ALTER TABLE "RoastingBatch" ADD COLUMN     "qcOverride" BOOLEAN,
ADD COLUMN     "qcOverrideAt" TIMESTAMP(3),
ADD COLUMN     "qcOverrideById" TEXT,
ADD COLUMN     "qcOverrideMin" INTEGER,
ADD COLUMN     "qcOverrideReason" TEXT;

ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_qcOverride_check"
  CHECK ("qcOverride" IS DISTINCT FROM true OR ("qcOverrideReason" IS NOT NULL AND length(btrim("qcOverrideReason")) > 0
    AND "qcOverrideById" IS NOT NULL AND "qcOverrideAt" IS NOT NULL));
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_qcOverrideMin_check"
  CHECK ("qcOverrideMin" IS NULL OR ("qcOverrideMin" >= 1 AND "qcOverrideMin" <= 10));

-- AlterTable
ALTER TABLE "SystemConfig" ADD COLUMN     "qcMinEvaluators" INTEGER;

ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_qcMinEvaluators_check"
  CHECK ("qcMinEvaluators" IS NULL OR ("qcMinEvaluators" >= 1 AND "qcMinEvaluators" <= 10));

-- CreateTable
CREATE TABLE "QcInvite" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "qcRecordId" TEXT,
    "messageId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "QcInvite_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QcInvite_channel_check" CHECK ("channel" IN ('PRESENT', 'LINK')),
    CONSTRAINT "QcInvite_status_check" CHECK ("status" IN ('PENDING', 'DONE', 'CANCELLED')),
    CONSTRAINT "QcInvite_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120)
);

-- CreateIndex
CREATE INDEX "QcInvite_batchId_status_idx" ON "QcInvite"("batchId", "status");

-- AddForeignKey
ALTER TABLE "QcInvite" ADD CONSTRAINT "QcInvite_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
