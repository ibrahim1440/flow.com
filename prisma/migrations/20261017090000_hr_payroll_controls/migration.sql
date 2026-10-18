-- P-2 payroll controls (owner decision F2; P2-ACCOUNTANT-DECISIONS §E E-1, E-3, E-4; findings 1, 5,
-- 9, 10). Engineering CONTROLS only: no compensation formula, rate or policy value changes here.
--
-- ADDITIVE:
--   · two new "HrConfigChangeKind" values (a leave type's proposal mark confirmed by a second
--     person; a second-person payroll control attestation);
--   · two nullable columns: "HrJournalLink"."postedLines" (what each HR journal posted, per posting
--     key and account, frozen with its link) and "HrPayrollPayment"."idempotencyKey" with a unique
--     index per run;
--   · one append-only table "HrPayrollReconNote" (explanations of reconciliation differences);
--   · guard functions and triggers (all named hr_*), none of which replaces an existing one.
-- No existing column is changed or dropped and no existing row is touched: every new guard fires
-- only on new INSERTs or on later UPDATE/DELETE statements. Atomic: one transaction.
-- Rollback: docs/hr/migration-review/rollback-20261017090000_hr_payroll_controls.sql.
BEGIN;

-- ── 1 · new config-change kinds (unused until the application requests them) ─────────────────
ALTER TYPE "HrConfigChangeKind" ADD VALUE IF NOT EXISTS 'LEAVE_TYPE_CONFIRM';
ALTER TYPE "HrConfigChangeKind" ADD VALUE IF NOT EXISTS 'PAYROLL_CONTROL_ATTEST';

-- ── 2 · journal integrity: what was posted, frozen with the link ─────────────────────────────
ALTER TABLE "HrJournalLink" ADD COLUMN "postedLines" JSONB;

-- A link is only ever written for a POSTED journal of the HR module about the same source.
CREATE OR REPLACE FUNCTION hr_journal_link_guard() RETURNS trigger AS $$
DECLARE e RECORD;
BEGIN
  SELECT "status", "sourceModule", "sourceDocumentId" INTO e FROM "JournalEntry" WHERE "id" = NEW."journalEntryId";
  IF NOT FOUND OR e."status" <> 'POSTED' OR e."sourceModule" <> 'hr' OR e."sourceDocumentId" IS DISTINCT FROM NEW."sourceId" THEN
    RAISE EXCEPTION 'HR: a journal link names a POSTED HR journal of the same source'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_journal_link_guard BEFORE INSERT ON "HrJournalLink"
  FOR EACH ROW EXECUTE FUNCTION hr_journal_link_guard();

-- A journal HR posted never changes and is never deleted. Its only allowed change is
-- POSTED → REVERSED, and that only when an HR-linked reversal exists (checked at commit below).
CREATE OR REPLACE FUNCTION hr_linked_journal_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "HrJournalLink" WHERE "journalEntryId" = OLD."id") THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: a journal posted by HR is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."entryDate" <> OLD."entryDate" OR NEW."fiscalPeriodId" <> OLD."fiscalPeriodId" OR NEW."type" <> OLD."type"
     OR NEW."sourceModule" <> OLD."sourceModule" OR NEW."sourceDocumentId" IS DISTINCT FROM OLD."sourceDocumentId"
     OR NEW."totalDebit" <> OLD."totalDebit" OR NEW."totalCredit" <> OLD."totalCredit" OR NEW."currency" <> OLD."currency"
     OR NEW."reversesEntryId" IS DISTINCT FROM OLD."reversesEntryId" THEN
    RAISE EXCEPTION 'HR: a journal posted by HR never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED') THEN
    RAISE EXCEPTION 'HR: a journal posted by HR only goes from POSTED to REVERSED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_linked_journal_guard BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION hr_linked_journal_guard();

CREATE OR REPLACE FUNCTION hr_linked_journal_line_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "HrJournalLink" WHERE "journalEntryId" = COALESCE(NEW."journalEntryId", OLD."journalEntryId"))
     OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM "HrJournalLink" WHERE "journalEntryId" = OLD."journalEntryId")) THEN
    RAISE EXCEPTION 'HR: the lines of a journal posted by HR never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_linked_journal_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "JournalEntryLine"
  FOR EACH ROW EXECUTE FUNCTION hr_linked_journal_line_guard();

-- At commit: an HR journal is reversed only by a reversal that HR itself links (cancellation of
-- the run, an approved treatment) — never by an unlinked reversal from elsewhere — and is marked
-- REVERSED only when that linked reversal exists. Deferred, because HR writes the reversal entry
-- first and its link second, in the same transaction.
CREATE OR REPLACE FUNCTION hr_journal_reversal_check() RETURNS trigger AS $$
BEGIN
  IF NEW."reversesEntryId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "HrJournalLink" WHERE "journalEntryId" = NEW."reversesEntryId")
     AND NOT EXISTS (SELECT 1 FROM "HrJournalLink" WHERE "journalEntryId" = NEW."id") THEN
    RAISE EXCEPTION 'HR: a journal posted by HR is reversed only through HR (a linked reversal)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'REVERSED'
     AND EXISTS (SELECT 1 FROM "HrJournalLink" WHERE "journalEntryId" = NEW."id")
     AND NOT EXISTS (SELECT 1 FROM "JournalEntry" r JOIN "HrJournalLink" l ON l."journalEntryId" = r."id" WHERE r."reversesEntryId" = NEW."id") THEN
    RAISE EXCEPTION 'HR: a journal posted by HR is marked REVERSED only with its linked reversal' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER hr_journal_reversal_check AFTER INSERT OR UPDATE ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hr_journal_reversal_check();

-- ── 3 · payments: idempotent, never above the net, only against a booked approved run ────────
ALTER TABLE "HrPayrollPayment" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "HrPayrollPayment" ADD CONSTRAINT "HrPayrollPayment_idempotency_key"
  CHECK ("idempotencyKey" IS NULL OR length("idempotencyKey") BETWEEN 8 AND 80);
CREATE UNIQUE INDEX "HrPayrollPayment_runId_idempotencyKey_key" ON "HrPayrollPayment"("runId", "idempotencyKey");

-- Optional per-employee settlement: a payment may name the line (payslip) it pays. A run is paid
-- EITHER per line (each line never above its own net) OR as a whole — never mixed, so the amount
-- still due per employee is always known.
ALTER TABLE "HrPayrollPayment" ADD COLUMN "lineId" TEXT;
CREATE INDEX "HrPayrollPayment_lineId_idx" ON "HrPayrollPayment"("lineId");
ALTER TABLE "HrPayrollPayment" ADD CONSTRAINT "HrPayrollPayment_lineId_fkey"
  FOREIGN KEY ("lineId") REFERENCES "HrPayrollLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION hr_payroll_payment_guard() RETURNS trigger AS $$
DECLARE r RECORD; paid numeric; line_net numeric; line_run text; line_paid numeric;
BEGIN
  -- The run row is locked, so concurrent payments of one run are counted one after the other.
  SELECT "status", "totalNet" INTO r FROM "HrPayrollRun" WHERE "id" = NEW."runId" FOR UPDATE;
  IF NOT FOUND OR r."status" <> 'APPROVED' THEN
    RAISE EXCEPTION 'HR: a payment is recorded against an APPROVED payroll run only' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum("amount"), 0) INTO paid FROM "HrPayrollPayment" WHERE "runId" = NEW."runId";
  IF paid + NEW."amount" > r."totalNet" THEN
    RAISE EXCEPTION 'HR: the payments of a payroll run never exceed its net' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "HrPayrollPayment" WHERE "runId" = NEW."runId" AND ("lineId" IS NULL) <> (NEW."lineId" IS NULL)) THEN
    RAISE EXCEPTION 'HR: a payroll run is paid either per line or as a whole, never both' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lineId" IS NOT NULL THEN
    SELECT "runId", "net" INTO line_run, line_net FROM "HrPayrollLine" WHERE "id" = NEW."lineId";
    IF line_run IS DISTINCT FROM NEW."runId" THEN
      RAISE EXCEPTION 'HR: a line payment names a line of the same run' USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(sum("amount"), 0) INTO line_paid FROM "HrPayrollPayment" WHERE "lineId" = NEW."lineId";
    IF line_paid + NEW."amount" > line_net THEN
      RAISE EXCEPTION 'HR: the payments of a payslip line never exceed its net' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "HrJournalLink" WHERE "sourceType" = 'PAYROLL_RUN' AND "sourceId" = NEW."runId" AND "purpose" = 'ACCRUAL') THEN
    RAISE EXCEPTION 'HR: no payment is recorded without the run''s posted accrual journal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_payment_guard BEFORE INSERT ON "HrPayrollPayment"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_payment_guard();

-- ── 4 · run lifecycle: approved figures frozen; approval needs the accrual; PAID needs settlement ──
-- A separate trigger: the frozen hr_payroll_run_guard (20261008120000) is not replaced.
CREATE OR REPLACE FUNCTION hr_payroll_run_controls_guard() RETURNS trigger AS $$
DECLARE paid numeric; unbooked int; proposal boolean;
BEGIN
  IF OLD."status" IN ('APPROVED', 'PAID') AND (
       NEW."totalGross" <> OLD."totalGross" OR NEW."totalDeductions" <> OLD."totalDeductions" OR NEW."totalNet" <> OLD."totalNet"
    OR NEW."totalEmployer" <> OLD."totalEmployer" OR NEW."policyId" <> OLD."policyId" OR NEW."accountingSkipped" <> OLD."accountingSkipped"
    OR NEW."periodMonth" <> OLD."periodMonth" OR NEW."periodStart" <> OLD."periodStart" OR NEW."periodEnd" <> OLD."periodEnd"
    OR NEW."kind" <> OLD."kind" OR NEW."branchKey" <> OLD."branchKey" OR NEW."correctsRunId" IS DISTINCT FROM OLD."correctsRunId"
    OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" OR NEW."preparedBy" <> OLD."preparedBy" OR NEW."submittedBy" IS DISTINCT FROM OLD."submittedBy") THEN
    RAISE EXCEPTION 'HR: the approved figures of a payroll run never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'APPROVED' AND OLD."status" <> 'APPROVED' THEN
    IF NEW."accountingSkipped" THEN
      RAISE EXCEPTION 'HR: a payroll run is approved only with its accrual journal posted' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "HrJournalLink" WHERE "sourceType" = 'PAYROLL_RUN' AND "sourceId" = NEW."id" AND "purpose" = 'ACCRUAL') THEN
      RAISE EXCEPTION 'HR: a payroll run is approved only with its accrual journal posted' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "isProposal" INTO proposal FROM "HrPayrollPolicy" WHERE "id" = NEW."policyId";
    IF proposal AND NEW."kind" <> 'CORRECTION' THEN
      RAISE EXCEPTION 'HR: a regular payroll run is never approved under a proposal policy' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'PAID' AND OLD."status" <> 'PAID' THEN
    SELECT COALESCE(sum("amount"), 0) INTO paid FROM "HrPayrollPayment" WHERE "runId" = NEW."id";
    IF paid <> NEW."totalNet" THEN
      RAISE EXCEPTION 'HR: a payroll run is PAID only when its payments equal its net' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO unbooked FROM "HrPayrollPayment" p WHERE p."runId" = NEW."id"
      AND NOT EXISTS (SELECT 1 FROM "HrJournalLink" l WHERE l."sourceType" = 'PAYROLL_RUN' AND l."sourceId" = NEW."id" AND l."purpose" = 'PAYMENT:' || p."id");
    IF unbooked > 0 THEN
      RAISE EXCEPTION 'HR: a payroll run is PAID only when every payment has its posted journal' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_run_controls_guard BEFORE UPDATE ON "HrPayrollRun"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_run_controls_guard();

-- ── 5 · a payroll policy marked as a proposal never becomes ACTIVE ───────────────────────────
CREATE OR REPLACE FUNCTION hr_policy_proposal_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'ACTIVE' AND NEW."isProposal" AND (TG_OP = 'INSERT' OR OLD."status" <> 'ACTIVE') THEN
    RAISE EXCEPTION 'HR: a payroll policy marked as a proposal never becomes ACTIVE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_policy_proposal_guard BEFORE INSERT OR UPDATE ON "HrPayrollPolicy"
  FOR EACH ROW EXECUTE FUNCTION hr_policy_proposal_guard();

-- ── 6 · reconciliation differences are explained, never hidden (append-only) ─────────────────
CREATE TABLE "HrPayrollReconNote" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "lineId" TEXT,
    "check" TEXT NOT NULL,
    "differenceHalalas" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HrPayrollReconNote_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HrPayrollReconNote_explanation" CHECK (length(btrim("explanation")) >= 10),
    CONSTRAINT "HrPayrollReconNote_check" CHECK (length(btrim("check")) >= 3)
);
CREATE INDEX "HrPayrollReconNote_runId_idx" ON "HrPayrollReconNote"("runId");
ALTER TABLE "HrPayrollReconNote" ADD CONSTRAINT "HrPayrollReconNote_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "HrPayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "HrPayrollReconNote_append_only" BEFORE UPDATE OR DELETE ON "HrPayrollReconNote"
  FOR EACH ROW EXECUTE FUNCTION hr_forbid_mutation();

COMMIT;
