-- Stage 5: fixed-asset register, depreciation runs, disposals, year-end close (STAGE_5_DESIGN.md).
-- Additive: new enums and tables; the journal-entry guard is replaced to admit a CLOSING entry into a
-- LOCKED period. No existing table changes.

-- CreateEnum
CREATE TYPE "FaMethod" AS ENUM ('STRAIGHT_LINE', 'DECLINING_BALANCE');

-- CreateEnum
CREATE TYPE "FaStartConvention" AS ENUM ('IN_SERVICE_MONTH', 'NEXT_MONTH');

-- CreateEnum
CREATE TYPE "FaDisposalConvention" AS ENUM ('NONE', 'FULL_MONTH');

-- CreateEnum
CREATE TYPE "FaPolicyStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

-- CreateEnum
CREATE TYPE "FaAssetStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CAPITALISED', 'DISPOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FaSourceKind" AS ENUM ('BILL_LINE', 'ACCOUNT', 'IN_LEDGER');

-- CreateEnum
CREATE TYPE "FaDocStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSAL_REQUESTED', 'REVERSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "FaClass" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "costAccountId" TEXT NOT NULL,
    "accumAccountId" TEXT NOT NULL,
    "expenseAccountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaClassPolicy" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "FaPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "method" "FaMethod" NOT NULL,
    "usefulLifeMonths" INTEGER NOT NULL,
    "residualPercent" DECIMAL(5,2) NOT NULL,
    "decliningFactor" DECIMAL(5,2),
    "startConvention" "FaStartConvention" NOT NULL,
    "disposalConvention" "FaDisposalConvention" NOT NULL,
    "capitalisationThreshold" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "preparedBy" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "FaClassPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaAsset" (
    "id" TEXT NOT NULL,
    "assetNo" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "classPolicyId" TEXT,
    "branchId" TEXT,
    "costCenterId" TEXT,
    "inServiceDate" DATE NOT NULL,
    "cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "residualValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "method" "FaMethod" NOT NULL,
    "usefulLifeMonths" INTEGER NOT NULL,
    "decliningFactor" DECIMAL(5,2),
    "startConvention" "FaStartConvention" NOT NULL,
    "disposalConvention" "FaDisposalConvention" NOT NULL,
    "deviationReason" TEXT,
    "openingAccumulated" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "openingMonths" INTEGER NOT NULL DEFAULT 0,
    "openingAccumCounterAccountId" TEXT,
    "status" "FaAssetStatus" NOT NULL DEFAULT 'DRAFT',
    "preparedBy" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "capitalisedAt" DATE,
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaAssetSource" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "kind" "FaSourceKind" NOT NULL,
    "billLineId" TEXT,
    "counterAccountId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "description" TEXT,

    CONSTRAINT "FaAssetSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaDepRun" (
    "id" TEXT NOT NULL,
    "runNo" SERIAL NOT NULL,
    "fiscalPeriodId" TEXT NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "FaDocStatus" NOT NULL DEFAULT 'DRAFT',
    "total" DECIMAL(18,2) NOT NULL,
    "preparedBy" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "reversalRequestedBy" TEXT,
    "reversalReason" TEXT,
    "reversedBy" TEXT,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "FaDepRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaDepLine" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "months" INTEGER NOT NULL,
    "accumulatedAfter" DECIMAL(18,2) NOT NULL,
    "nbvAfter" DECIMAL(18,2) NOT NULL,
    "note" TEXT,

    CONSTRAINT "FaDepLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaDisposal" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "disposalDate" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "proceeds" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "proceedsAccountId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "FaDocStatus" NOT NULL DEFAULT 'DRAFT',
    "cost" DECIMAL(18,2),
    "accumulated" DECIMAL(18,2),
    "nbv" DECIMAL(18,2),
    "gainLoss" DECIMAL(18,2),
    "preparedBy" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "reversalRequestedBy" TEXT,
    "reversalReason" TEXT,
    "reversedBy" TEXT,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "FaDisposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YearEndClose" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "FaDocStatus" NOT NULL DEFAULT 'DRAFT',
    "yearStart" DATE NOT NULL,
    "yearEnd" DATE NOT NULL,
    "snapshot" JSONB NOT NULL,
    "netIncome" DECIMAL(18,2) NOT NULL,
    "preparedBy" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "reversalRequestedBy" TEXT,
    "reversalReason" TEXT,
    "reversedBy" TEXT,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "YearEndClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FaClass_code_key" ON "FaClass"("code");

-- CreateIndex
CREATE UNIQUE INDEX "FaClassPolicy_classId_version_key" ON "FaClassPolicy"("classId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FaAsset_assetNo_key" ON "FaAsset"("assetNo");

-- CreateIndex
CREATE INDEX "FaAsset_status_idx" ON "FaAsset"("status");

-- CreateIndex
CREATE INDEX "FaAssetSource_billLineId_idx" ON "FaAssetSource"("billLineId");

-- CreateIndex
CREATE UNIQUE INDEX "FaAssetSource_assetId_lineNo_key" ON "FaAssetSource"("assetId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "FaDepRun_runNo_key" ON "FaDepRun"("runNo");

-- CreateIndex
CREATE INDEX "FaDepRun_fiscalPeriodId_idx" ON "FaDepRun"("fiscalPeriodId");

-- CreateIndex
CREATE INDEX "FaDepLine_assetId_idx" ON "FaDepLine"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "FaDepLine_runId_assetId_key" ON "FaDepLine"("runId", "assetId");

-- CreateIndex
CREATE INDEX "FaDisposal_assetId_idx" ON "FaDisposal"("assetId");

-- CreateIndex
CREATE INDEX "YearEndClose_year_idx" ON "YearEndClose"("year");

-- AddForeignKey
ALTER TABLE "FaClassPolicy" ADD CONSTRAINT "FaClassPolicy_classId_fkey" FOREIGN KEY ("classId") REFERENCES "FaClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaAsset" ADD CONSTRAINT "FaAsset_classId_fkey" FOREIGN KEY ("classId") REFERENCES "FaClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaAsset" ADD CONSTRAINT "FaAsset_classPolicyId_fkey" FOREIGN KEY ("classPolicyId") REFERENCES "FaClassPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaAssetSource" ADD CONSTRAINT "FaAssetSource_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaDepLine" ADD CONSTRAINT "FaDepLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FaDepRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaDepLine" ADD CONSTRAINT "FaDepLine_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaDisposal" ADD CONSTRAINT "FaDisposal_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══ Controls (stage 5) ═══════════════════════════════════════════════════════════════════════

-- One live depreciation run per fiscal period; one live disposal per asset; one live close per year.
CREATE UNIQUE INDEX "FaDepRun_one_live_per_period" ON "FaDepRun" ("fiscalPeriodId") WHERE "status" IN ('DRAFT', 'POSTED', 'REVERSAL_REQUESTED');
CREATE UNIQUE INDEX "FaDisposal_one_live_per_asset" ON "FaDisposal" ("assetId") WHERE "status" IN ('DRAFT', 'POSTED', 'REVERSAL_REQUESTED');
CREATE UNIQUE INDEX "YearEndClose_one_live_per_year" ON "YearEndClose" ("year") WHERE "status" IN ('DRAFT', 'POSTED', 'REVERSAL_REQUESTED');
-- A bill line funds at most one asset that is not cancelled (checked by trigger: the index cannot see the asset status).

-- Four-eyes and forward-only lifecycles.
CREATE OR REPLACE FUNCTION acc_fa_guard_doc() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION '% cannot be deleted once it has left draft', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION '% is created as a draft', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('POSTED', 'CANCELLED'))
    OR (OLD."status" = 'POSTED' AND NEW."status" = 'REVERSAL_REQUESTED')
    OR (OLD."status" = 'REVERSAL_REQUESTED' AND NEW."status" IN ('REVERSED', 'POSTED'))) THEN
    RAISE EXCEPTION '% cannot move from % to %', TG_TABLE_NAME, OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'POSTED' AND OLD."status" = 'DRAFT' AND (NEW."approvedBy" IS NULL OR NEW."approvedBy" = NEW."preparedBy") THEN
    RAISE EXCEPTION '% must be approved by someone other than its preparer', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'REVERSED' AND (NEW."reversedBy" IS NULL OR NEW."reversedBy" = NEW."reversalRequestedBy") THEN
    RAISE EXCEPTION 'A reversal of % must be approved by someone other than its requester', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Once posted, what was posted does not change.
  IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - 'status' - 'reversalRequestedBy' - 'reversalReason' - 'reversedBy' - 'reversedAt')
       IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'reversalRequestedBy' - 'reversalReason' - 'reversedBy' - 'reversedAt') THEN
    RAISE EXCEPTION 'A posted % cannot be changed; reverse it instead', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "FaDepRun_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FaDepRun" FOR EACH ROW EXECUTE FUNCTION acc_fa_guard_doc();
CREATE TRIGGER "FaDisposal_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FaDisposal" FOR EACH ROW EXECUTE FUNCTION acc_fa_guard_doc();
CREATE TRIGGER "YearEndClose_guard" BEFORE INSERT OR UPDATE OR DELETE ON "YearEndClose" FOR EACH ROW EXECUTE FUNCTION acc_fa_guard_doc();

-- Depreciation lines change only while their run is a draft.
CREATE OR REPLACE FUNCTION acc_fa_guard_dep_line() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT "status"::text INTO st FROM "FaDepRun" WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."runId" ELSE NEW."runId" END;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of a posted depreciation run cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "FaDepLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FaDepLine" FOR EACH ROW EXECUTE FUNCTION acc_fa_guard_dep_line();

-- Class policy versions: approved by someone else; an approved version never changes (only retires).
CREATE OR REPLACE FUNCTION acc_fa_guard_class_policy() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'An approved depreciation policy cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN RAISE EXCEPTION 'A depreciation policy is created as a draft' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED' AND (NEW."approvedBy" IS NULL OR NEW."approvedBy" = NEW."preparedBy") THEN
    RAISE EXCEPTION 'A depreciation policy must be approved by someone other than its preparer' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED') OR (OLD."status" = 'APPROVED' AND NEW."status" = 'RETIRED')) THEN
    RAISE EXCEPTION 'A depreciation policy cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'An approved depreciation policy cannot change; prepare a new version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "FaClassPolicy_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FaClassPolicy" FOR EACH ROW EXECUTE FUNCTION acc_fa_guard_class_policy();

-- Assets: capitalised by someone other than the preparer; once capitalised, what defines the
-- depreciation does not change; sources change only in draft.
CREATE OR REPLACE FUNCTION acc_fa_guard_asset() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'Only a draft asset can be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN RAISE EXCEPTION 'An asset is registered as a draft' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" = 'SUBMITTED')
    OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('DRAFT', 'CAPITALISED'))
    OR (OLD."status" = 'CAPITALISED' AND NEW."status" IN ('DISPOSED', 'CANCELLED'))
    OR (OLD."status" = 'DISPOSED' AND NEW."status" = 'CAPITALISED')) THEN
    RAISE EXCEPTION 'An asset cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'CAPITALISED' AND OLD."status" = 'SUBMITTED' AND (NEW."approvedBy" IS NULL OR NEW."approvedBy" = NEW."preparedBy") THEN
    RAISE EXCEPTION 'An asset must be capitalised by someone other than its preparer' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" IN ('CAPITALISED', 'DISPOSED', 'CANCELLED')
     AND (to_jsonb(NEW) - 'status' - 'cancelledBy' - 'cancelledAt' - 'cancelReason' - 'updatedAt')
         IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'cancelledBy' - 'cancelledAt' - 'cancelReason' - 'updatedAt') THEN
    RAISE EXCEPTION 'A capitalised asset cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "FaAsset_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FaAsset" FOR EACH ROW EXECUTE FUNCTION acc_fa_guard_asset();

CREATE OR REPLACE FUNCTION acc_fa_guard_source() RETURNS trigger AS $$
DECLARE st text; aid text; bl text; used int;
BEGIN
  aid := CASE WHEN TG_OP = 'DELETE' THEN OLD."assetId" ELSE NEW."assetId" END;
  SELECT "status"::text INTO st FROM "FaAsset" WHERE "id" = aid;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'The cost sources of a submitted or capitalised asset cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."billLineId" IS NOT NULL THEN
    SELECT COUNT(*) INTO used FROM "FaAssetSource" s JOIN "FaAsset" a ON a."id" = s."assetId"
     WHERE s."billLineId" = NEW."billLineId" AND s."id" <> NEW."id" AND a."status" <> 'CANCELLED';
    IF used > 0 THEN
      RAISE EXCEPTION 'That supplier-bill line already funds another asset' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "FaAssetSource_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FaAssetSource" FOR EACH ROW EXECUTE FUNCTION acc_fa_guard_source();

-- Journal entries: a CLOSING entry may post into a LOCKED period (year-end close); nothing else may.
CREATE OR REPLACE FUNCTION public.acc_guard_journal_entry()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  p RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only a draft journal entry can be deleted (entry % is %)', OLD."entryNo", OLD."status"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."isProvisional" AND NOT acc_is_disposable_db() THEN
    RAISE EXCEPTION 'Provisional postings are only allowed in an isolated test database'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('DRAFT', 'APPROVED') THEN
      RAISE EXCEPTION 'A journal entry is created as a draft (or approved, by the posting engine)'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" = 'APPROVED' AND acc_is_manual_type(NEW."type"::text) THEN
      RAISE EXCEPTION 'A % entry must start as a draft and be approved by a second person', NEW."type"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD."status" IN ('POSTED', 'REVERSED') THEN
    IF (to_jsonb(NEW) - 'status' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updatedAt') THEN
      RAISE EXCEPTION 'Posted journal entry % cannot be changed; reverse it instead', OLD."entryNo"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" <> OLD."status" THEN
      IF NOT (OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED') THEN
        RAISE EXCEPTION 'Journal entry % cannot move from % to %', OLD."entryNo", OLD."status", NEW."status"
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM "JournalEntry" r WHERE r."reversesEntryId" = OLD."id" AND r."status" = 'POSTED') THEN
        RAISE EXCEPTION 'Journal entry % can only be marked reversed by a posted reversal', OLD."entryNo"
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;

  -- Allowed transitions.
  IF NOT (
       (OLD."status" = 'DRAFT'     AND NEW."status" = 'SUBMITTED')
    OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('APPROVED', 'DRAFT'))
    OR (OLD."status" = 'APPROVED'  AND NEW."status" IN ('POSTED', 'DRAFT'))
  ) THEN
    RAISE EXCEPTION 'Journal entry % cannot move from % to %', OLD."entryNo", OLD."status", NEW."status"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW."status" = 'APPROVED' AND acc_is_manual_type(NEW."type"::text) THEN
    IF NEW."approvedBy" IS NULL
       OR NEW."approvedBy" = NEW."createdBy"
       OR NEW."approvedBy" = COALESCE(NEW."submittedBy", NEW."createdBy") THEN
      RAISE EXCEPTION 'Journal entry % must be approved by someone other than its preparer', NEW."entryNo"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  IF NEW."status" = 'POSTED' THEN
    SELECT * INTO p FROM "FiscalPeriod" WHERE "id" = NEW."fiscalPeriodId";
    -- A year-end CLOSING entry posts into the year's last period while it is LOCKED (so nothing
    -- else can post there); every other entry needs an OPEN period.
    IF NEW."type" = 'CLOSING' THEN
      IF p."status" <> 'LOCKED' THEN
        RAISE EXCEPTION 'A closing entry posts only into a locked period (fiscal period %-% is %)', p."year", p."periodNo", p."status"
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    ELSIF p."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'Fiscal period %-% is %; nothing can post to it', p."year", p."periodNo", p."status"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."entryDate" < p."startDate" OR NEW."entryDate" > p."endDate" THEN
      RAISE EXCEPTION 'Entry date is outside fiscal period %-%', p."year", p."periodNo"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."postedAt" IS NULL OR NEW."postedBy" IS NULL THEN
      RAISE EXCEPTION 'A posted entry records who posted it and when' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
