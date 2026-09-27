-- Accounting ledger core (additive). Generated DDL first, hand-written controls after.
-- Nothing existing is altered or dropped; the deployed build keeps working against this schema.
-- CreateEnum
CREATE TYPE "AccountControlKind" AS ENUM ('NONE', 'RECEIVABLE', 'PAYABLE', 'INVENTORY', 'TAX', 'COMMISSION_PAYABLE', 'CUSTOMER_ADVANCES', 'CASH', 'CLEARING');

-- CreateEnum
CREATE TYPE "AccountingPolicyStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

-- CreateEnum
CREATE TYPE "CommissionAccountingApproval" AS ENUM ('PROVISIONAL', 'APPROVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccountingEventStatus" ADD VALUE 'BLOCKED';
ALTER TYPE "AccountingEventStatus" ADD VALUE 'SKIPPED';

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "allowManualPosting" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "controlKind" "AccountControlKind" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "AccountingEvent" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "partyKey" TEXT;

-- AlterTable
ALTER TABLE "AccountingSettings" ADD COLUMN     "ledgerCutoverDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CommissionPlanVersion" ADD COLUMN     "accountingApproval" "CommissionAccountingApproval" NOT NULL DEFAULT 'PROVISIONAL',
ADD COLUMN     "accountingApprovedAt" TIMESTAMP(3),
ADD COLUMN     "accountingApprovedBy" TEXT;

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "isProvisional" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "originEventId" TEXT,
ADD COLUMN     "policyKey" TEXT,
ADD COLUMN     "policyVersion" INTEGER,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedBy" TEXT,
ADD COLUMN     "rejectionReason" TEXT;

-- AlterTable
ALTER TABLE "JournalEntryLine" ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "costCenterId" TEXT,
ADD COLUMN     "lineNo" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "partyId" TEXT,
ADD COLUMN     "partyType" TEXT;

-- CreateTable
CREATE TABLE "AccountMapping" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AccountMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingPolicy" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "AccountingPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "titleEn" TEXT NOT NULL,
    "titleAr" TEXT,
    "statement" TEXT NOT NULL,
    "parameters" JSONB,
    "preparedBy" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "retiredBy" TEXT,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountMapping_role_key" ON "AccountMapping"("role");

-- CreateIndex
CREATE INDEX "AccountingPolicy_key_status_idx" ON "AccountingPolicy"("key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingPolicy_key_version_key" ON "AccountingPolicy"("key", "version");

-- CreateIndex
CREATE INDEX "AccountingEvent_partyKey_occurredAt_idx" ON "AccountingEvent"("partyKey", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_originEventId_key" ON "JournalEntry"("originEventId");

-- CreateIndex
CREATE INDEX "JournalEntryLine_partyType_partyId_idx" ON "JournalEntryLine"("partyType", "partyId");

-- AddForeignKey
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "FinBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "FinCostCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════════
-- Hand-written database controls. The application checks the same rules first so users
-- get a clear message; these make the rules hold for any client, including a bug.
-- Errors use integrity_constraint_violation so the API layer maps them to 409.
-- ═══════════════════════════════════════════════════════════════════════════════

-- True only in a database created by scripts/finance/local-postgres.mjs (or the equivalent
-- test setup) and marked disposable. Provisional postings are refused everywhere else.
CREATE OR REPLACE FUNCTION acc_is_disposable_db() RETURNS boolean AS $$
  SELECT COALESCE(shobj_description(d.oid, 'pg_database') = 'hiqbah-finance-disposable', false)
    FROM pg_database d WHERE d.datname = current_database();
$$ LANGUAGE sql STABLE;

-- Journal types a person creates, as opposed to the posting engine.
CREATE OR REPLACE FUNCTION acc_is_manual_type(t text) RETURNS boolean AS $$
  SELECT t IN ('MANUAL', 'ADJUSTMENT', 'OPENING', 'REVERSAL');
$$ LANGUAGE sql IMMUTABLE;

-- 1. Journal entry header -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION acc_guard_journal_entry() RETURNS trigger AS $$
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
    IF p."status" <> 'OPEN' THEN
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
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JournalEntry_guard" BEFORE INSERT OR UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_journal_entry();

-- 2. Balance and account validity, checked at commit of the transaction that posts --------
CREATE OR REPLACE FUNCTION acc_check_posted_entry() RETURNS trigger AS $$
DECLARE
  d numeric; c numeric; n int; bad int; ctl int;
BEGIN
  IF NEW."status" <> 'POSTED' THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0), COUNT(*)
    INTO d, c, n FROM "JournalEntryLine" WHERE "journalEntryId" = NEW."id";
  IF n < 2 THEN
    RAISE EXCEPTION 'Journal entry % has fewer than two lines', NEW."entryNo" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF d <> c OR d <> NEW."totalDebit" OR c <> NEW."totalCredit" THEN
    RAISE EXCEPTION 'Journal entry % is not balanced (debit %, credit %, header % / %)', NEW."entryNo", d, c, NEW."totalDebit", NEW."totalCredit"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT COUNT(*) INTO bad FROM "JournalEntryLine" l JOIN "Account" a ON a."id" = l."accountId"
   WHERE l."journalEntryId" = NEW."id"
     AND (NOT a."isActive" OR NOT a."allowPosting" OR EXISTS (SELECT 1 FROM "Account" ch WHERE ch."parentId" = a."id"));
  IF bad > 0 THEN
    RAISE EXCEPTION 'Journal entry % posts to an inactive, non-posting or parent account', NEW."entryNo"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF acc_is_manual_type(NEW."type"::text) AND NEW."type" <> 'REVERSAL' THEN
    SELECT COUNT(*) INTO ctl FROM "JournalEntryLine" l JOIN "Account" a ON a."id" = l."accountId"
     WHERE l."journalEntryId" = NEW."id" AND a."controlKind" <> 'NONE' AND NOT a."allowManualPosting";
    IF ctl > 0 THEN
      RAISE EXCEPTION 'Journal entry % posts by hand to a control account', NEW."entryNo"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "JournalEntry_posted_check" AFTER INSERT OR UPDATE ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acc_check_posted_entry();

-- 3. Lines change only while their entry is a draft (or being built by the engine) -------
CREATE OR REPLACE FUNCTION acc_guard_journal_line() RETURNS trigger AS $$
DECLARE
  st text; ty text; eid text;
BEGIN
  eid := CASE WHEN TG_OP = 'DELETE' THEN OLD."journalEntryId" ELSE NEW."journalEntryId" END;
  SELECT "status"::text, "type"::text INTO st, ty FROM "JournalEntry" WHERE "id" = eid;
  IF st IS NULL THEN
    -- The entry itself is being deleted (cascade); the entry guard already allowed it.
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."journalEntryId" <> OLD."journalEntryId" THEN
    RAISE EXCEPTION 'A journal line cannot be moved to another entry' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF st = 'DRAFT' OR (st = 'APPROVED' AND NOT acc_is_manual_type(ty) AND TG_OP = 'INSERT') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'Lines of a % journal entry cannot be changed', st USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JournalEntryLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "JournalEntryLine"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_journal_line();

-- 4. Fiscal periods: forward-only status, dates fixed once anything is dated in them -----
CREATE OR REPLACE FUNCTION acc_guard_fiscal_period() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "JournalEntry" WHERE "fiscalPeriodId" = OLD."id") THEN
      RAISE EXCEPTION 'A fiscal period with journal entries cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."startDate" <> OLD."startDate" OR NEW."endDate" <> OLD."endDate")
     AND EXISTS (SELECT 1 FROM "JournalEntry" WHERE "fiscalPeriodId" = OLD."id") THEN
    RAISE EXCEPTION 'Dates of a fiscal period with journal entries cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'OPEN'   AND NEW."status" = 'LOCKED')
    OR (OLD."status" = 'LOCKED' AND NEW."status" IN ('CLOSED', 'OPEN'))
  ) THEN
    RAISE EXCEPTION 'Fiscal period cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FiscalPeriod_guard" BEFORE UPDATE OR DELETE ON "FiscalPeriod"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_fiscal_period();

-- No two periods may overlap: a date must belong to exactly one period.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_no_overlap"
  EXCLUDE USING gist (tsrange("startDate", "endDate", '[]') WITH &&);

-- 5. Accounts: the meaning of an account with postings cannot be changed ------------------
CREATE OR REPLACE FUNCTION acc_guard_account() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."type" <> OLD."type"
     AND EXISTS (SELECT 1 FROM "JournalEntryLine" WHERE "accountId" = OLD."id") THEN
    RAISE EXCEPTION 'Account % has journal lines; its type cannot change', OLD."code" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."parentId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."parentId" IS DISTINCT FROM OLD."parentId")
     AND EXISTS (SELECT 1 FROM "JournalEntryLine" WHERE "accountId" = NEW."parentId") THEN
    RAISE EXCEPTION 'An account with journal lines cannot become a parent' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Account_guard" BEFORE INSERT OR UPDATE ON "Account"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_account();

-- 6. Accounting events: no deletion; a translated event is final ---------------------------
CREATE OR REPLACE FUNCTION acc_guard_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Accounting events cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" IN ('TRANSLATED', 'SKIPPED') AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'A % accounting event is final', OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."idempotencyKey" <> OLD."idempotencyKey" OR NEW."payload" IS DISTINCT FROM OLD."payload"
     OR NEW."occurredAt" <> OLD."occurredAt" OR NEW."eventType" <> OLD."eventType" THEN
    RAISE EXCEPTION 'What an accounting event says cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AccountingEvent_guard" BEFORE UPDATE OR DELETE ON "AccountingEvent"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_event();

-- 7. Policies: four-eyes approval; an approved version is immutable except retirement -----
CREATE OR REPLACE FUNCTION acc_guard_policy() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only a draft policy can be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."approvedBy" IS NOT NULL THEN
      RAISE EXCEPTION 'A policy is created as a draft' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'A retired policy cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'APPROVED' THEN
    IF NEW."status" <> 'RETIRED'
       OR (to_jsonb(NEW) - 'status' - 'retiredBy' - 'retiredAt' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'retiredBy' - 'retiredAt' - 'updatedAt') THEN
      RAISE EXCEPTION 'An approved policy cannot be edited; retire it and approve a new version' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'APPROVED' THEN
    IF NEW."approvedBy" IS NULL OR NEW."approvedBy" = NEW."preparedBy" THEN
      RAISE EXCEPTION 'A policy must be approved by someone other than its preparer' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AccountingPolicy_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AccountingPolicy"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_policy();

-- At most one approved version per policy key.
CREATE UNIQUE INDEX "AccountingPolicy_one_approved_per_key" ON "AccountingPolicy"("key") WHERE "status" = 'APPROVED';

-- 8. Commission plan versions: accounting approval is four-eyes and one-way ---------------
CREATE OR REPLACE FUNCTION acc_guard_commission_plan_approval() RETURNS trigger AS $$
BEGIN
  IF NEW."accountingApproval" IS DISTINCT FROM OLD."accountingApproval"
     OR NEW."accountingApprovedBy" IS DISTINCT FROM OLD."accountingApprovedBy"
     OR NEW."accountingApprovedAt" IS DISTINCT FROM OLD."accountingApprovedAt" THEN
    IF OLD."accountingApproval" = 'APPROVED' THEN
      RAISE EXCEPTION 'An accounting-approved plan version cannot be changed back' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."accountingApproval" = 'APPROVED' AND (NEW."accountingApprovedBy" IS NULL
       OR NEW."accountingApprovedBy" = NEW."createdById" OR NEW."accountingApprovedAt" IS NULL) THEN
      RAISE EXCEPTION 'A plan version must be approved for accounting by someone other than its author' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CommissionPlanVersion_accounting_guard" BEFORE UPDATE ON "CommissionPlanVersion"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_commission_plan_approval();

-- 9. Outbox: every commission movement becomes exactly one accounting event, in the same
--    transaction, whichever code path wrote it (engine, manual adjustment, payout).
CREATE OR REPLACE FUNCTION acc_emit_commission_event() RETURNS trigger AS $$
DECLARE
  et text := 'commission.' || lower(NEW."type"::text);
BEGIN
  INSERT INTO "AccountingEvent" ("id", "eventType", "sourceModule", "sourceDocumentId", "sourceEventId",
    "idempotencyKey", "occurredAt", "payload", "status", "partyKey", "createdAt", "updatedAt")
  VALUES ('ae_' || replace(gen_random_uuid()::text, '-', ''), et, 'commissions', NEW."id", NEW."id",
    'commissions:' || NEW."id" || ':' || et || ':' || NEW."id", NEW."createdAt",
    jsonb_build_object(
      'ledgerEntryId', NEW."id", 'type', NEW."type"::text, 'employeeId', NEW."employeeId",
      'amount', NEW."amount"::text, 'currency', NEW."currency", 'periodStart', NEW."periodStart",
      'planVersionId', NEW."planVersionId", 'collectionEventId', NEW."collectionEventId",
      'accrualId', NEW."accrualId", 'reason', NEW."reason", 'actorId', NEW."actorId"),
    'PENDING', 'EMPLOYEE:' || NEW."employeeId", now(), now())
  ON CONFLICT ("idempotencyKey") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CommissionLedgerEntry_accounting_outbox" AFTER INSERT ON "CommissionLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION acc_emit_commission_event();
