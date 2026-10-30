-- Pipeline alignment and qualification minimum (docs/sales/PIPELINE_STAGES.md) — additive and backward compatible.
--
--   1. "PipelineStagePurpose" gains SAMPLE_EVALUATION and NEGOTIATION. The unique index on "PipelineStage"."purpose"
--      is untouched: still at most one stage per purpose. No stage row is written here; aligning the configured
--      stages is an owner decision, made with scripts/sales/align-pipeline-stages.ts (dry run by default).
--   2. "LostReasonCode" and "Opportunity"."lostReasonCode" (nullable) — a coded loss reason beside the free text,
--      which stays required by the service.
--   3. Needs analysis on "Opportunity" and the same facts on "Lead" (all nullable): businessType (the Customer.segment
--      codes), needSummary, expectedMonthlyKg (≥ 0), agreedNextStep. Existing rows read as "not recorded".
--   4. "SystemConfig"."salesRequireQualificationMinimum" (default true): the new conversion rule is on for every
--      deployment; setting it false restores the legacy rule (any qualifying outcome converts).
--
-- Enum values added with ALTER TYPE … ADD VALUE are not used in this migration (PostgreSQL forbids using a value in
-- the transaction that adds it). Rollback: drop the added columns and the LostReasonCode type; enum values cannot be
-- dropped in place and are harmless when unused (no stage holds them until somebody assigns them).

ALTER TYPE "PipelineStagePurpose" ADD VALUE IF NOT EXISTS 'SAMPLE_EVALUATION';
ALTER TYPE "PipelineStagePurpose" ADD VALUE IF NOT EXISTS 'NEGOTIATION';

CREATE TYPE "LostReasonCode" AS ENUM ('PRICE', 'QUALITY', 'COMPETITOR', 'NO_NEED', 'NO_RESPONSE', 'OTHER');

ALTER TABLE "Opportunity"
  ADD COLUMN "lostReasonCode" "LostReasonCode",
  ADD COLUMN "businessType" TEXT,
  ADD COLUMN "needSummary" TEXT,
  ADD COLUMN "expectedMonthlyKg" DECIMAL(12,3),
  ADD COLUMN "agreedNextStep" TEXT;

ALTER TABLE "Opportunity"
  ADD CONSTRAINT "Opportunity_businessType_check"
    CHECK ("businessType" IS NULL OR "businessType" IN ('WHOLESALE', 'RETAIL', 'CAFE', 'DISTRIBUTOR', 'OTHER')),
  ADD CONSTRAINT "Opportunity_expectedMonthlyKg_check"
    CHECK ("expectedMonthlyKg" IS NULL OR "expectedMonthlyKg" >= 0);

ALTER TABLE "Lead"
  ADD COLUMN "businessType" TEXT,
  ADD COLUMN "needSummary" TEXT,
  ADD COLUMN "expectedMonthlyKg" DECIMAL(12,3),
  ADD COLUMN "agreedNextStep" TEXT;

ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_businessType_check"
    CHECK ("businessType" IS NULL OR "businessType" IN ('WHOLESALE', 'RETAIL', 'CAFE', 'DISTRIBUTOR', 'OTHER')),
  ADD CONSTRAINT "Lead_expectedMonthlyKg_check"
    CHECK ("expectedMonthlyKg" IS NULL OR "expectedMonthlyKg" >= 0);

ALTER TABLE "SystemConfig"
  ADD COLUMN "salesRequireQualificationMinimum" BOOLEAN NOT NULL DEFAULT true;
