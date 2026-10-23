-- Workstations W3 — the QC station (feat/station-w3-qc): roast-profile-based QC specifications,
-- inspection, hold, exception and disposition. Owner decisions of 23 Oct 2026 (QC requirements:
-- per-profile-version colour reference, «المواصفة قيد المعايرة», hold instead of rejection, exception
-- by another person, no commercial exception for foreign objects, re-inspection / conversion / blend
-- / destruction of a held batch). Figma page 630:2 (Q1–Q6, QX-01…06).
--
-- ADDITIVE ONLY:
--   new tables  "RoastProfile", "RoastProfileVersion" (DRAFT → APPROVED → RETIRED; one APPROVED per
--               profile; the spec of a non-DRAFT version is frozen by a trigger), "RoastProfileTrial"
--               (trial readings during development), "QcException" (QEX-…, SoD CHECKs: the decider is
--               never the requester nor the inspector), "QcDisposition" (QDP-…: CONVERT / BLEND /
--               DESTROY, the same SoD CHECKs), "StationDeviceStation" (a device that also serves other
--               stations — the same iPad at the roaster and in QC);
--   new NULLABLE columns on "QcRecord" (the inspection: spec snapshot, readings with device and
--               scale, server verdicts, defects, sensory, optional cupping / moisture / density, loss
--               for reference, outcome, hold reasons, re-inspection link, Idempotency-Key UNIQUE) and
--               on "RoastingBatch" (profileVersionId → the version used at roasting; the hold, the
--               approved exception and permitted use, the product it was converted from);
--   a new status value "QC Hold" («محجوزة»): "RoastingBatch_status_check" lists every status the
--               application writes, added NOT VALID — existing rows are not checked, new writes are.
-- Every existing row keeps its meaning: the new columns are NULL, so every existing QC record is a
-- panel record and every existing batch has no profile version (its QC is «قيد المعايرة»). Nothing
-- is altered, dropped, renamed or back-filled. The previous application version never reads the new
-- tables or columns, and never writes "QC Hold".
-- Atomic: the whole file runs in one transaction. Rollback:
-- docs/hr/migration-review/rollback-20261031090000_station_w3_qc.sql.
BEGIN;

-- AlterTable
ALTER TABLE "QcRecord" ADD COLUMN     "cleaningNote" TEXT,
ADD COLUMN     "cuppingScore" DOUBLE PRECISION,
ADD COLUMN     "defectForeign" BOOLEAN,
ADD COLUMN     "defectPale" BOOLEAN,
ADD COLUMN     "defectScorched" BOOLEAN,
ADD COLUMN     "defectUneven" BOOLEAN,
ADD COLUMN     "densityGL" DOUBLE PRECISION,
ADD COLUMN     "groundDevice" TEXT,
ADD COLUMN     "groundScale" TEXT,
ADD COLUMN     "groundVerdict" TEXT,
ADD COLUMN     "holdReasons" JSONB,
ADD COLUMN     "intentHash" TEXT,
ADD COLUMN     "kind" TEXT,
ADD COLUMN     "lossPct" DOUBLE PRECISION,
ADD COLUMN     "manualDecision" TEXT,
ADD COLUMN     "manualNote" TEXT,
ADD COLUMN     "moisturePct" DOUBLE PRECISION,
ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "profileVersionId" TEXT,
ADD COLUMN     "reinspectionOfId" TEXT,
ADD COLUMN     "requestKey" TEXT,
ADD COLUMN     "sensoryNotes" TEXT,
ADD COLUMN     "sensoryRequired" BOOLEAN,
ADD COLUMN     "sensoryRequiredWhy" TEXT,
ADD COLUMN     "sensoryResult" TEXT,
ADD COLUMN     "specSnapshot" JSONB,
ADD COLUMN     "stationId" TEXT,
ADD COLUMN     "wholeDevice" TEXT,
ADD COLUMN     "wholeScale" TEXT,
ADD COLUMN     "wholeVerdict" TEXT;

-- AlterTable
ALTER TABLE "RoastingBatch" ADD COLUMN     "convertedFromProductId" TEXT,
ADD COLUMN     "profileVersionId" TEXT,
ADD COLUMN     "qcExceptionId" TEXT,
ADD COLUMN     "qcHoldAt" TIMESTAMP(3),
ADD COLUMN     "qcHoldForeignObject" BOOLEAN,
ADD COLUMN     "qcHoldRecordId" TEXT,
ADD COLUMN     "qcPermittedUse" TEXT;

-- CreateTable
CREATE TABLE "StationDeviceStation" (
    "id" TEXT NOT NULL,
    "stationDeviceId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationDeviceStation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoastProfile" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "greenBeanId" TEXT,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoastProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoastProfileVersion" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "wholeTarget" DOUBLE PRECISION,
    "wholeTol" DOUBLE PRECISION,
    "groundTarget" DOUBLE PRECISION,
    "groundTol" DOUBLE PRECISION,
    "device" TEXT,
    "scale" TEXT,
    "sensoryRequirements" TEXT,
    "notes" TEXT,
    "approvalSensory" TEXT,
    "approvalSensoryNotes" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "retiredAt" TIMESTAMP(3),
    "retiredById" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoastProfileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoastProfileTrial" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "batchId" TEXT,
    "colorWhole" DOUBLE PRECISION NOT NULL,
    "colorGround" DOUBLE PRECISION NOT NULL,
    "device" TEXT NOT NULL,
    "scale" TEXT NOT NULL,
    "sensoryResult" TEXT,
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,
    "recordedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoastProfileTrial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QcException" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "qcRecordId" TEXT NOT NULL,
    "inspectorId" TEXT,
    "inspectorName" TEXT,
    "reason" TEXT NOT NULL,
    "reasonNote" TEXT,
    "quantityKg" DOUBLE PRECISION NOT NULL,
    "permittedUse" TEXT NOT NULL,
    "permittedUseNote" TEXT,
    "measurementsSnapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "stationId" TEXT,
    "requestKey" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QcException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QcDisposition" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "qcRecordId" TEXT,
    "inspectorId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "quantityKg" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "targetProductId" TEXT,
    "targetVersionId" TEXT,
    "conformity" JSONB,
    "recipe" JSONB,
    "blendBatchId" TEXT,
    "movementId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "executedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QcDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StationDeviceStation_stationId_idx" ON "StationDeviceStation"("stationId");

-- CreateIndex
CREATE UNIQUE INDEX "StationDeviceStation_stationDeviceId_stationId_key" ON "StationDeviceStation"("stationDeviceId", "stationId");

-- CreateIndex
CREATE INDEX "RoastProfile_productId_status_idx" ON "RoastProfile"("productId", "status");

-- CreateIndex
CREATE INDEX "RoastProfileVersion_status_idx" ON "RoastProfileVersion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RoastProfileVersion_profileId_version_key" ON "RoastProfileVersion"("profileId", "version");

-- CreateIndex
CREATE INDEX "RoastProfileTrial_versionId_createdAt_idx" ON "RoastProfileTrial"("versionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "QcException_number_key" ON "QcException"("number");

-- CreateIndex
CREATE UNIQUE INDEX "QcException_requestKey_key" ON "QcException"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "QcException_decisionKey_key" ON "QcException"("decisionKey");

-- CreateIndex
CREATE INDEX "QcException_status_createdAt_idx" ON "QcException"("status", "createdAt");

-- CreateIndex
CREATE INDEX "QcException_batchId_idx" ON "QcException"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "QcDisposition_number_key" ON "QcDisposition"("number");

-- CreateIndex
CREATE UNIQUE INDEX "QcDisposition_requestKey_key" ON "QcDisposition"("requestKey");

-- CreateIndex
CREATE INDEX "QcDisposition_status_createdAt_idx" ON "QcDisposition"("status", "createdAt");

-- CreateIndex
CREATE INDEX "QcDisposition_batchId_idx" ON "QcDisposition"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "QcRecord_requestKey_key" ON "QcRecord"("requestKey");

-- CreateIndex
CREATE INDEX "QcRecord_kind_createdAt_idx" ON "QcRecord"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "QcRecord_profileVersionId_idx" ON "QcRecord"("profileVersionId");

-- CreateIndex
CREATE INDEX "RoastingBatch_profileVersionId_idx" ON "RoastingBatch"("profileVersionId");

-- AddForeignKey
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_profileVersionId_fkey" FOREIGN KEY ("profileVersionId") REFERENCES "RoastProfileVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationDeviceStation" ADD CONSTRAINT "StationDeviceStation_stationDeviceId_fkey" FOREIGN KEY ("stationDeviceId") REFERENCES "StationDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationDeviceStation" ADD CONSTRAINT "StationDeviceStation_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastProfile" ADD CONSTRAINT "RoastProfile_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastProfile" ADD CONSTRAINT "RoastProfile_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastProfileVersion" ADD CONSTRAINT "RoastProfileVersion_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "RoastProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastProfileTrial" ADD CONSTRAINT "RoastProfileTrial_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "RoastProfileVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastProfileTrial" ADD CONSTRAINT "RoastProfileTrial_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QcException" ADD CONSTRAINT "QcException_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QcDisposition" ADD CONSTRAINT "QcDisposition_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── CHECKs on the new rows (and the new status value) ──────────────────────────────────────────
ALTER TABLE "RoastProfile" ADD CONSTRAINT "RoastProfile_status_check" CHECK ("status" IN ('ACTIVE', 'ARCHIVED'));
ALTER TABLE "RoastProfile" ADD CONSTRAINT "RoastProfile_name_check" CHECK (length(btrim("name")) > 0);
-- One profile per product and green coffee (NULL green = every lot of the product).
CREATE UNIQUE INDEX "RoastProfile_product_green_key" ON "RoastProfile"("productId", COALESCE("greenBeanId", ''));

ALTER TABLE "RoastProfileVersion" ADD CONSTRAINT "RoastProfileVersion_status_check" CHECK ("status" IN ('DRAFT', 'APPROVED', 'RETIRED'));
ALTER TABLE "RoastProfileVersion" ADD CONSTRAINT "RoastProfileVersion_version_check" CHECK ("version" >= 1);
ALTER TABLE "RoastProfileVersion" ADD CONSTRAINT "RoastProfileVersion_tol_check" CHECK (("wholeTol" IS NULL OR "wholeTol" >= 0) AND ("groundTol" IS NULL OR "groundTol" >= 0));
ALTER TABLE "RoastProfileVersion" ADD CONSTRAINT "RoastProfileVersion_targets_check" CHECK (("wholeTarget" IS NULL OR ("wholeTarget" > 0 AND "wholeTarget" <= 200)) AND ("groundTarget" IS NULL OR ("groundTarget" > 0 AND "groundTarget" <= 200)));
-- An approved (or retired) version carries a complete spec and its sensory approval.
ALTER TABLE "RoastProfileVersion" ADD CONSTRAINT "RoastProfileVersion_approved_check" CHECK (
  "status" = 'DRAFT' OR (
    "wholeTarget" IS NOT NULL AND "wholeTol" IS NOT NULL AND "groundTarget" IS NOT NULL AND "groundTol" IS NOT NULL
    AND "device" IS NOT NULL AND "scale" IS NOT NULL AND "approvalSensory" = 'CONFORMING'
    AND "approvedAt" IS NOT NULL AND "approvedById" IS NOT NULL));
ALTER TABLE "RoastProfileVersion" ADD CONSTRAINT "RoastProfileVersion_retired_check" CHECK (("status" = 'RETIRED') = ("retiredAt" IS NOT NULL));
-- At most one APPROVED version per profile.
CREATE UNIQUE INDEX "RoastProfileVersion_one_approved_key" ON "RoastProfileVersion"("profileId") WHERE "status" = 'APPROVED';

-- The spec of an approved or retired version never changes (a new version is approved instead), and a
-- version never goes back to DRAFT.
CREATE OR REPLACE FUNCTION "roast_profile_version_frozen"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."wholeTarget" IS DISTINCT FROM OLD."wholeTarget" OR NEW."wholeTol" IS DISTINCT FROM OLD."wholeTol"
       OR NEW."groundTarget" IS DISTINCT FROM OLD."groundTarget" OR NEW."groundTol" IS DISTINCT FROM OLD."groundTol"
       OR NEW."device" IS DISTINCT FROM OLD."device" OR NEW."scale" IS DISTINCT FROM OLD."scale"
       OR NEW."sensoryRequirements" IS DISTINCT FROM OLD."sensoryRequirements"
       OR NEW."approvalSensory" IS DISTINCT FROM OLD."approvalSensory" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."profileId" IS DISTINCT FROM OLD."profileId"
       OR NEW."version" IS DISTINCT FROM OLD."version" OR NEW."status" = 'DRAFT'
       OR (OLD."status" = 'RETIRED' AND NEW."status" <> 'RETIRED') THEN
      RAISE EXCEPTION 'roast profile version % is %: its specification is frozen', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER "RoastProfileVersion_frozen" BEFORE UPDATE ON "RoastProfileVersion" FOR EACH ROW EXECUTE FUNCTION "roast_profile_version_frozen"();

ALTER TABLE "RoastProfileTrial" ADD CONSTRAINT "RoastProfileTrial_colors_check" CHECK ("colorWhole" > 0 AND "colorWhole" <= 200 AND "colorGround" > 0 AND "colorGround" <= 200);
ALTER TABLE "RoastProfileTrial" ADD CONSTRAINT "RoastProfileTrial_sensory_check" CHECK ("sensoryResult" IS NULL OR "sensoryResult" IN ('CONFORMING', 'NON_CONFORMING', 'NEEDS_REVIEW'));

ALTER TABLE "QcRecord" ADD CONSTRAINT "QcRecord_kind_check" CHECK ("kind" IS NULL OR "kind" = 'INSPECTION');
ALTER TABLE "QcRecord" ADD CONSTRAINT "QcRecord_verdicts_check" CHECK (("wholeVerdict" IS NULL OR "wholeVerdict" IN ('LIGHTER', 'ON_TARGET', 'DARKER')) AND ("groundVerdict" IS NULL OR "groundVerdict" IN ('LIGHTER', 'ON_TARGET', 'DARKER')));
ALTER TABLE "QcRecord" ADD CONSTRAINT "QcRecord_sensory_check" CHECK ("sensoryResult" IS NULL OR "sensoryResult" IN ('CONFORMING', 'NON_CONFORMING', 'NEEDS_REVIEW'));
ALTER TABLE "QcRecord" ADD CONSTRAINT "QcRecord_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('RELEASED', 'HELD', 'AWAITING_EVALUATORS'));
ALTER TABLE "QcRecord" ADD CONSTRAINT "QcRecord_manual_check" CHECK ("manualDecision" IS NULL OR ("manualDecision" IN ('ACCEPT', 'HOLD') AND "manualNote" IS NOT NULL));
ALTER TABLE "QcRecord" ADD CONSTRAINT "QcRecord_inspection_check" CHECK ("kind" IS NULL OR ("specSnapshot" IS NOT NULL AND "outcome" IS NOT NULL AND "employeeId" IS NOT NULL));
ALTER TABLE "QcRecord" ADD CONSTRAINT "QcRecord_optional_check" CHECK (("cuppingScore" IS NULL OR ("cuppingScore" >= 0 AND "cuppingScore" <= 100)) AND ("moisturePct" IS NULL OR ("moisturePct" >= 0 AND "moisturePct" <= 100)) AND ("densityGL" IS NULL OR ("densityGL" > 0 AND "densityGL" <= 2000)));

ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_status_check" CHECK ("status" IN ('Pending QC', 'Passed', 'Rejected', 'Blended', 'Partially Packaged', 'Packaged', 'QC Hold')) NOT VALID;
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_qcHold_check" CHECK ("status" <> 'QC Hold' OR ("qcHoldAt" IS NOT NULL AND "qcHoldRecordId" IS NOT NULL));
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_qcPermittedUse_check" CHECK ("qcPermittedUse" IS NULL OR "qcPermittedUse" IN ('GENERAL', 'CUSTOMER', 'INTERNAL'));

ALTER TABLE "QcException" ADD CONSTRAINT "QcException_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'));
ALTER TABLE "QcException" ADD CONSTRAINT "QcException_reason_check" CHECK ("reason" IN ('TASTE_ACCEPTED', 'BLEND_SUITABLE', 'CUSTOMER_APPROVAL', 'OTHER') AND ("reason" <> 'OTHER' OR length(btrim(coalesce("reasonNote", ''))) > 0));
ALTER TABLE "QcException" ADD CONSTRAINT "QcException_use_check" CHECK ("permittedUse" IN ('GENERAL', 'CUSTOMER', 'INTERNAL'));
ALTER TABLE "QcException" ADD CONSTRAINT "QcException_quantity_check" CHECK ("quantityKg" > 0);
ALTER TABLE "QcException" ADD CONSTRAINT "QcException_decided_check" CHECK (
  ("status" IN ('APPROVED', 'REJECTED')) = ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND length(btrim(coalesce("decisionReason", ''))) > 0)
  OR ("status" = 'WITHDRAWN' AND "decidedAt" IS NOT NULL));
-- Separation of duties (owner decision 4): never the requester, never the inspector of the inspection.
ALTER TABLE "QcException" ADD CONSTRAINT "QcException_sod_check" CHECK ("decidedById" IS NULL OR "status" = 'WITHDRAWN' OR ("decidedById" <> "requestedById" AND "decidedById" IS DISTINCT FROM "inspectorId"));
-- One open request per batch.
CREATE UNIQUE INDEX "QcException_one_pending_key" ON "QcException"("batchId") WHERE "status" = 'PENDING';

ALTER TABLE "QcDisposition" ADD CONSTRAINT "QcDisposition_kind_check" CHECK ("kind" IN ('CONVERT', 'BLEND', 'DESTROY'));
ALTER TABLE "QcDisposition" ADD CONSTRAINT "QcDisposition_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'WITHDRAWN'));
ALTER TABLE "QcDisposition" ADD CONSTRAINT "QcDisposition_quantity_check" CHECK ("quantityKg" > 0);
ALTER TABLE "QcDisposition" ADD CONSTRAINT "QcDisposition_reason_check" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "QcDisposition" ADD CONSTRAINT "QcDisposition_target_check" CHECK ("kind" <> 'CONVERT' OR ("targetProductId" IS NOT NULL AND "targetVersionId" IS NOT NULL AND "conformity" IS NOT NULL));
ALTER TABLE "QcDisposition" ADD CONSTRAINT "QcDisposition_recipe_check" CHECK ("kind" <> 'BLEND' OR "recipe" IS NOT NULL);
ALTER TABLE "QcDisposition" ADD CONSTRAINT "QcDisposition_decided_check" CHECK ("status" IN ('PENDING', 'WITHDRAWN') OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND length(btrim(coalesce("decisionReason", ''))) > 0));
ALTER TABLE "QcDisposition" ADD CONSTRAINT "QcDisposition_executed_check" CHECK (("status" = 'EXECUTED') = ("executedAt" IS NOT NULL));
ALTER TABLE "QcDisposition" ADD CONSTRAINT "QcDisposition_sod_check" CHECK ("decidedById" IS NULL OR ("decidedById" <> "requestedById" AND "decidedById" IS DISTINCT FROM "inspectorId"));
CREATE UNIQUE INDEX "QcDisposition_one_pending_key" ON "QcDisposition"("batchId") WHERE "status" IN ('PENDING', 'APPROVED');

COMMIT;
