-- P-2 settlements (findings 2, 3, 4, 8; §E E-4, E-7). Engineering controls only: no
-- compensation formula, cap value, priority or statutory rate is set here. Every new policy
-- value is NULL / empty until the accountant decides it; payroll refuses to run meanwhile.
--
-- ADDITIVE: new nullable / defaulted columns on HrPayrollPolicy, HrPayrollItem and
-- HrAdvanceInstallment; seven new tables; their CHECKs, partial unique indexes and guard
-- triggers. No existing row is changed. One existing constraint is WIDENED (never narrowed):
-- "HrAdvanceInstallment_status" also admits RESCHEDULED and HELD (a new guard governs them).
-- Atomic: the whole file runs in one transaction. Rollback:
-- docs/hr/migration-review/rollback-20261017100000_hr_p2_settlements.sql
BEGIN;

-- AlterTable
ALTER TABLE "HrAdvanceInstallment" ADD COLUMN     "recoveryRequestId" TEXT;

-- AlterTable
ALTER TABLE "HrPayrollItem" ADD COLUMN     "applyOrder" INTEGER,
ADD COLUMN     "category" TEXT;

-- AlterTable
ALTER TABLE "HrPayrollPolicy" ADD COLUMN     "advanceDeferralEscalateAfter" INTEGER,
ADD COLUMN     "capBaseIncludesVariable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deductionCapAction" TEXT,
ADD COLUMN     "deductionCapLoanPercent" DECIMAL(5,2),
ADD COLUMN     "deductionCapOtherPercent" DECIMAL(5,2),
ADD COLUMN     "deductionCapStatutoryPercent" DECIMAL(5,2),
ADD COLUMN     "deductionCapUnearnedPercent" DECIMAL(5,2),
ADD COLUMN     "deductionOverallCovers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "deductionPriority" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "HrAdvanceRecoveryRequest" (
    "id" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "before" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "HrAdvanceRecoveryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrAdvanceReviewItem" (
    "id" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "deferralCount" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "outstanding" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "recoveryRequestId" TEXT,

    CONSTRAINT "HrAdvanceReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrGosiInvoice" (
    "id" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "totalEmployee" DECIMAL(18,2) NOT NULL,
    "totalEmployer" DECIMAL(18,2) NOT NULL,
    "notes" TEXT,
    "enteredBy" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedBy" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,

    CONSTRAINT "HrGosiInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrGosiInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "share" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "contributoryWage" DECIMAL(18,2),
    "sourceRow" INTEGER,

    CONSTRAINT "HrGosiInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrGosiSettlement" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "share" TEXT NOT NULL,
    "invoiceAmount" DECIMAL(18,2) NOT NULL,
    "payrollAmount" DECIMAL(18,2) NOT NULL,
    "priorAdjustments" DECIMAL(18,2) NOT NULL,
    "difference" DECIMAL(18,2) NOT NULL,
    "explanation" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "proposedBy" TEXT NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "HrGosiSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrGosiAdjustment" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "share" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "action" TEXT NOT NULL,
    "journalEntryId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrGosiAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrFinalSettlement" (
    "id" TEXT NOT NULL,
    "settlementNo" TEXT NOT NULL,
    "separationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "preparedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eosAmount" DECIMAL(18,2),
    "leaveEncashmentDays" DECIMAL(6,2),
    "leaveEncashmentAmount" DECIMAL(18,2),
    "totalAmount" DECIMAL(18,2),
    "calcInputs" JSONB,
    "calcMethodNote" TEXT,
    "calcReference" TEXT,
    "calcDocumentId" TEXT,
    "eosProvisionAmount" DECIMAL(18,2),
    "leaveProvisionAmount" DECIMAL(18,2),
    "provisionReference" TEXT,
    "calculatedBy" TEXT,
    "calculatedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewAttestation" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalNote" TEXT,
    "postingMode" TEXT,
    "journalEntryId" TEXT,
    "postedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "paidAmount" DECIMAL(18,2),
    "paidOn" DATE,
    "paymentReference" TEXT,
    "paymentProofDocumentId" TEXT,
    "paymentJournalEntryId" TEXT,
    "paidBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closingNote" TEXT,
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "HrFinalSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HrAdvanceRecoveryRequest_advanceId_status_idx" ON "HrAdvanceRecoveryRequest"("advanceId", "status");

-- CreateIndex
CREATE INDEX "HrAdvanceReviewItem_advanceId_status_idx" ON "HrAdvanceReviewItem"("advanceId", "status");

-- CreateIndex
CREATE INDEX "HrGosiInvoice_periodMonth_status_idx" ON "HrGosiInvoice"("periodMonth", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HrGosiInvoiceLine_invoiceId_employeeId_share_key" ON "HrGosiInvoiceLine"("invoiceId", "employeeId", "share");

-- CreateIndex
CREATE INDEX "HrGosiSettlement_periodMonth_employeeId_share_idx" ON "HrGosiSettlement"("periodMonth", "employeeId", "share");

-- CreateIndex
CREATE UNIQUE INDEX "HrGosiAdjustment_settlementId_key" ON "HrGosiAdjustment"("settlementId");

-- CreateIndex
CREATE INDEX "HrGosiAdjustment_periodMonth_employeeId_idx" ON "HrGosiAdjustment"("periodMonth", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "HrFinalSettlement_settlementNo_key" ON "HrFinalSettlement"("settlementNo");

-- CreateIndex
CREATE UNIQUE INDEX "HrFinalSettlement_journalEntryId_key" ON "HrFinalSettlement"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "HrFinalSettlement_paymentJournalEntryId_key" ON "HrFinalSettlement"("paymentJournalEntryId");

-- CreateIndex
CREATE INDEX "HrFinalSettlement_employeeId_status_idx" ON "HrFinalSettlement"("employeeId", "status");

-- CreateIndex
CREATE INDEX "HrFinalSettlement_separationId_idx" ON "HrFinalSettlement"("separationId");

-- AddForeignKey
ALTER TABLE "HrAdvanceRecoveryRequest" ADD CONSTRAINT "HrAdvanceRecoveryRequest_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "HrAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrAdvanceReviewItem" ADD CONSTRAINT "HrAdvanceReviewItem_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "HrAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrGosiInvoiceLine" ADD CONSTRAINT "HrGosiInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "HrGosiInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrGosiInvoiceLine" ADD CONSTRAINT "HrGosiInvoiceLine_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrGosiSettlement" ADD CONSTRAINT "HrGosiSettlement_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "HrGosiInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrGosiSettlement" ADD CONSTRAINT "HrGosiSettlement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrGosiAdjustment" ADD CONSTRAINT "HrGosiAdjustment_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "HrGosiSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrGosiAdjustment" ADD CONSTRAINT "HrGosiAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrFinalSettlement" ADD CONSTRAINT "HrFinalSettlement_separationId_fkey" FOREIGN KEY ("separationId") REFERENCES "HrSeparation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrFinalSettlement" ADD CONSTRAINT "HrFinalSettlement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrFinalSettlement" ADD CONSTRAINT "HrFinalSettlement_calcDocumentId_fkey" FOREIGN KEY ("calcDocumentId") REFERENCES "HrDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrFinalSettlement" ADD CONSTRAINT "HrFinalSettlement_paymentProofDocumentId_fkey" FOREIGN KEY ("paymentProofDocumentId") REFERENCES "HrDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════════════
--  Hand-written integrity (not expressible in the Prisma schema). The services enforce the
--  same rules first; these are the backstop for any other writer.
-- ═══════════════════════════════════════════════════════════════════════════════════

-- A jsonb object of the named columns of a row (used by the guards below to freeze evidence).
CREATE OR REPLACE FUNCTION hr_p2_cols(r jsonb, cols text[]) RETURNS jsonb AS $$
  SELECT coalesce(jsonb_object_agg(k, r -> k), '{}'::jsonb) FROM unnest(cols) AS k
$$ LANGUAGE sql IMMUTABLE;

-- ── 1 · Deduction policy (findings 2/3): values are optional, but never out of range ──────
ALTER TABLE "HrPayrollPolicy"
  ADD CONSTRAINT "HrPayrollPolicy_deduction_caps" CHECK (
        ("deductionCapUnearnedPercent"  IS NULL OR "deductionCapUnearnedPercent"  BETWEEN 0 AND 100)
    AND ("deductionCapLoanPercent"      IS NULL OR "deductionCapLoanPercent"      BETWEEN 0 AND 100)
    AND ("deductionCapStatutoryPercent" IS NULL OR "deductionCapStatutoryPercent" BETWEEN 0 AND 100)
    AND ("deductionCapOtherPercent"     IS NULL OR "deductionCapOtherPercent"     BETWEEN 0 AND 100)),
  ADD CONSTRAINT "HrPayrollPolicy_deduction_categories" CHECK (
        ("deductionOverallCovers" IS NULL OR "deductionOverallCovers" <@ ARRAY['UNEARNED_PAY','LOAN_RECOVERY','STATUTORY','OTHER']::text[])
    AND ("deductionPriority" IS NULL OR cardinality("deductionPriority") = 0
         OR (cardinality("deductionPriority") = 4 AND "deductionPriority" @> ARRAY['UNEARNED_PAY','LOAN_RECOVERY','STATUTORY','OTHER']::text[]))),
  ADD CONSTRAINT "HrPayrollPolicy_deduction_action" CHECK ("deductionCapAction" IS NULL OR "deductionCapAction" IN ('WARN','BLOCK')),
  ADD CONSTRAINT "HrPayrollPolicy_deferral_escalation" CHECK ("advanceDeferralEscalateAfter" IS NULL OR "advanceDeferralEscalateAfter" BETWEEN 1 AND 24);

-- Each deduction line records its category and the order it was applied in.
ALTER TABLE "HrPayrollItem"
  ADD CONSTRAINT "HrPayrollItem_deduction_category" CHECK (
    "category" IS NULL OR ("kind" = 'DEDUCTION' AND "category" IN ('UNEARNED_PAY','LOAN_RECOVERY','STATUTORY','OTHER'))),
  ADD CONSTRAINT "HrPayrollItem_apply_order" CHECK ("applyOrder" IS NULL OR "applyOrder" > 0);

-- ── 2 · Advance recovery (finding 2): reschedule / collection, never a write-off ──────────
-- WIDENED (not narrowed): two more installment states.
ALTER TABLE "HrAdvanceInstallment" DROP CONSTRAINT "HrAdvanceInstallment_status";
ALTER TABLE "HrAdvanceInstallment"
  ADD CONSTRAINT "HrAdvanceInstallment_status" CHECK ("status" IN ('SCHEDULED','RESERVED','SETTLED','COVERED','RESCHEDULED','HELD'));

-- Only a SCHEDULED installment is rescheduled or held, and only by an approved request. A
-- RESCHEDULED row is history; a HELD row stays owed until a repayment COVERS it.
CREATE OR REPLACE FUNCTION hr_installment_recovery_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" IN ('RESCHEDULED','HELD') THEN
      RAISE EXCEPTION 'HR: an installment is created SCHEDULED' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'RESCHEDULED' THEN
    RAISE EXCEPTION 'HR: a rescheduled installment is history and never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'HELD' AND NEW."status" NOT IN ('HELD','COVERED') THEN
    RAISE EXCEPTION 'HR: a held installment is only covered by a repayment' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('RESCHEDULED','HELD') AND NEW."status" <> OLD."status" THEN
    IF OLD."status" <> 'SCHEDULED' OR NEW."recoveryRequestId" IS NULL THEN
      RAISE EXCEPTION 'HR: only a scheduled installment is rescheduled or held, by an approved recovery request' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER hr_installment_recovery_guard BEFORE INSERT OR UPDATE ON "HrAdvanceInstallment"
  FOR EACH ROW EXECUTE FUNCTION hr_installment_recovery_guard();

ALTER TABLE "HrAdvanceRecoveryRequest"
  ADD CONSTRAINT "HrAdvanceRecoveryRequest_kind" CHECK ("kind" IN ('RESCHEDULE','COLLECTION')),
  ADD CONSTRAINT "HrAdvanceRecoveryRequest_status" CHECK ("status" IN ('PENDING','APPLIED','REJECTED','WITHDRAWN')),
  ADD CONSTRAINT "HrAdvanceRecoveryRequest_four_eyes" CHECK ("decidedBy" IS NULL OR "decidedBy" <> "requestedBy"),
  ADD CONSTRAINT "HrAdvanceRecoveryRequest_decider" CHECK (("status" IN ('APPLIED','REJECTED')) = ("decidedBy" IS NOT NULL)),
  ADD CONSTRAINT "HrAdvanceRecoveryRequest_decided_at" CHECK (("status" <> 'PENDING') = ("decidedAt" IS NOT NULL)),
  ADD CONSTRAINT "HrAdvanceRecoveryRequest_reason" CHECK (length(btrim("reason")) >= 5);
CREATE UNIQUE INDEX "HrAdvanceRecoveryRequest_one_pending" ON "HrAdvanceRecoveryRequest"("advanceId") WHERE "status" = 'PENDING';

-- Same contract as HrConfigChange: content immutable, decided never changes, never deleted.
CREATE OR REPLACE FUNCTION hr_p2_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: a % row is never deleted', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'HR: a decided % row never changes', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','decidedBy','decidedAt','decisionNote']) <> (to_jsonb(OLD) - ARRAY['status','decidedBy','decidedAt','decisionNote']) THEN
    RAISE EXCEPTION 'HR: the content of a % request never changes', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER hr_advance_recovery_request_guard BEFORE UPDATE OR DELETE ON "HrAdvanceRecoveryRequest"
  FOR EACH ROW EXECUTE FUNCTION hr_p2_request_guard();

ALTER TABLE "HrAdvanceReviewItem"
  ADD CONSTRAINT "HrAdvanceReviewItem_reason" CHECK ("reason" IN ('DEFERRAL_ESCALATION')),
  ADD CONSTRAINT "HrAdvanceReviewItem_status" CHECK ("status" IN ('OPEN','RESOLVED')),
  ADD CONSTRAINT "HrAdvanceReviewItem_counts" CHECK ("threshold" >= 1 AND "deferralCount" >= "threshold" AND "outstanding" >= 0),
  ADD CONSTRAINT "HrAdvanceReviewItem_resolution" CHECK (
    ("status" = 'RESOLVED') = ("resolvedBy" IS NOT NULL AND "resolvedAt" IS NOT NULL AND length(btrim(coalesce("resolutionNote", ''))) >= 5));
CREATE UNIQUE INDEX "HrAdvanceReviewItem_one_open" ON "HrAdvanceReviewItem"("advanceId") WHERE "status" = 'OPEN';

CREATE OR REPLACE FUNCTION hr_advance_review_item_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: an advance review item is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'HR: a resolved advance review item never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','resolvedBy','resolvedAt','resolutionNote','recoveryRequestId']) <> (to_jsonb(OLD) - ARRAY['status','resolvedBy','resolvedAt','resolutionNote','recoveryRequestId']) THEN
    RAISE EXCEPTION 'HR: an advance review item only records its resolution' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER hr_advance_review_item_guard BEFORE UPDATE OR DELETE ON "HrAdvanceReviewItem"
  FOR EACH ROW EXECUTE FUNCTION hr_advance_review_item_guard();

-- ── 3 · GOSI invoice reconciliation (finding 4, E-4) ──────────────────────────────────────
ALTER TABLE "HrGosiInvoice"
  ADD CONSTRAINT "HrGosiInvoice_month_format" CHECK ("periodMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT "HrGosiInvoice_source" CHECK ("source" IN ('MANUAL','CSV')),
  ADD CONSTRAINT "HrGosiInvoice_status" CHECK ("status" IN ('ACTIVE','VOID')),
  ADD CONSTRAINT "HrGosiInvoice_totals" CHECK ("totalEmployee" >= 0 AND "totalEmployer" >= 0),
  ADD CONSTRAINT "HrGosiInvoice_reference" CHECK (length(btrim("reference")) >= 1),
  ADD CONSTRAINT "HrGosiInvoice_void" CHECK (("status" = 'VOID') = ("voidedBy" IS NOT NULL AND "voidedAt" IS NOT NULL AND length(btrim(coalesce("voidReason", ''))) >= 5));
CREATE UNIQUE INDEX "HrGosiInvoice_one_active_per_month" ON "HrGosiInvoice"("periodMonth") WHERE "status" = 'ACTIVE';

CREATE OR REPLACE FUNCTION hr_gosi_invoice_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: a GOSI invoice is never deleted (void it)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'HR: a void GOSI invoice never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','voidedBy','voidedAt','voidReason']) <> (to_jsonb(OLD) - ARRAY['status','voidedBy','voidedAt','voidReason']) THEN
    RAISE EXCEPTION 'HR: a GOSI invoice is never edited (void it and enter it again)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER hr_gosi_invoice_guard BEFORE UPDATE OR DELETE ON "HrGosiInvoice"
  FOR EACH ROW EXECUTE FUNCTION hr_gosi_invoice_guard();

ALTER TABLE "HrGosiInvoiceLine"
  ADD CONSTRAINT "HrGosiInvoiceLine_share" CHECK ("share" IN ('EMPLOYEE','EMPLOYER')),
  ADD CONSTRAINT "HrGosiInvoiceLine_amounts" CHECK ("amount" >= 0 AND ("contributoryWage" IS NULL OR "contributoryWage" >= 0));
CREATE TRIGGER "HrGosiInvoiceLine_append_only" BEFORE UPDATE OR DELETE ON "HrGosiInvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION hr_forbid_mutation();

ALTER TABLE "HrGosiSettlement"
  ADD CONSTRAINT "HrGosiSettlement_share" CHECK ("share" IN ('EMPLOYEE','EMPLOYER')),
  ADD CONSTRAINT "HrGosiSettlement_action" CHECK ("action" IN ('EMPLOYER_EXPENSE','PAYROLL_CORRECTION','INVOICE_DISPUTE','NO_ADJUSTMENT')),
  ADD CONSTRAINT "HrGosiSettlement_status" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  ADD CONSTRAINT "HrGosiSettlement_difference" CHECK ("difference" <> 0 AND "difference" = "invoiceAmount" - "payrollAmount" - "priorAdjustments"),
  ADD CONSTRAINT "HrGosiSettlement_explanation" CHECK (length(btrim("explanation")) >= 10),
  ADD CONSTRAINT "HrGosiSettlement_four_eyes" CHECK ("decidedBy" IS NULL OR "decidedBy" <> "proposedBy"),
  ADD CONSTRAINT "HrGosiSettlement_decider" CHECK (("status" IN ('APPROVED','REJECTED')) = ("decidedBy" IS NOT NULL)),
  ADD CONSTRAINT "HrGosiSettlement_decided_at" CHECK (("status" <> 'PENDING') = ("decidedAt" IS NOT NULL));
CREATE UNIQUE INDEX "HrGosiSettlement_one_pending" ON "HrGosiSettlement"("invoiceId", "employeeId", "share") WHERE "status" = 'PENDING';
CREATE TRIGGER hr_gosi_settlement_guard BEFORE UPDATE OR DELETE ON "HrGosiSettlement"
  FOR EACH ROW EXECUTE FUNCTION hr_p2_request_guard();

ALTER TABLE "HrGosiAdjustment"
  ADD CONSTRAINT "HrGosiAdjustment_share" CHECK ("share" IN ('EMPLOYEE','EMPLOYER')),
  ADD CONSTRAINT "HrGosiAdjustment_action" CHECK ("action" IN ('EMPLOYER_EXPENSE','PAYROLL_CORRECTION','INVOICE_DISPUTE','NO_ADJUSTMENT')),
  ADD CONSTRAINT "HrGosiAdjustment_amount" CHECK ("amount" <> 0);
CREATE TRIGGER "HrGosiAdjustment_append_only" BEFORE UPDATE OR DELETE ON "HrGosiAdjustment"
  FOR EACH ROW EXECUTE FUNCTION hr_forbid_mutation();

-- ── 4 · Final settlement (finding 8, E-7): evidence per status ────────────────────────────
ALTER TABLE "HrFinalSettlement"
  ADD CONSTRAINT "HrFinalSettlement_status" CHECK ("status" IN ('DRAFT','CALCULATED','REVIEWED','APPROVED','POSTED','PAID','CLOSED','CANCELLED')),
  ADD CONSTRAINT "HrFinalSettlement_amounts" CHECK (
        coalesce("eosAmount", 0) >= 0 AND coalesce("leaveEncashmentAmount", 0) >= 0 AND coalesce("leaveEncashmentDays", 0) >= 0
    AND coalesce("eosProvisionAmount", 0) >= 0 AND coalesce("leaveProvisionAmount", 0) >= 0),
  -- CALCULATED and later: the manual calculation, its inputs, method and attached worksheet.
  ADD CONSTRAINT "HrFinalSettlement_calculated" CHECK ("status" IN ('DRAFT','CANCELLED') OR (
        "eosAmount" IS NOT NULL AND "leaveEncashmentAmount" IS NOT NULL AND "leaveEncashmentDays" IS NOT NULL
    AND "totalAmount" IS NOT NULL AND "totalAmount" > 0 AND "totalAmount" = "eosAmount" + "leaveEncashmentAmount"
    AND "calcInputs" IS NOT NULL AND length(btrim(coalesce("calcMethodNote", ''))) >= 10
    AND length(btrim(coalesce("calcReference", ''))) >= 3 AND "calcDocumentId" IS NOT NULL
    AND "calculatedBy" IS NOT NULL AND "calculatedAt" IS NOT NULL)),
  -- REVIEWED and later: an independent, attested reviewer.
  ADD CONSTRAINT "HrFinalSettlement_reviewed" CHECK ("status" NOT IN ('REVIEWED','APPROVED','POSTED','PAID','CLOSED') OR (
        "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL AND length(btrim(coalesce("reviewAttestation", ''))) >= 10
    AND "reviewedBy" <> "calculatedBy" AND "reviewedBy" <> "preparedBy")),
  ADD CONSTRAINT "HrFinalSettlement_approved" CHECK ("status" NOT IN ('APPROVED','POSTED','PAID','CLOSED') OR (
        "approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL
    AND "approvedBy" <> "calculatedBy" AND "approvedBy" <> "preparedBy" AND "approvedBy" <> "reviewedBy")),
  ADD CONSTRAINT "HrFinalSettlement_posted" CHECK ("status" NOT IN ('POSTED','PAID','CLOSED') OR (
        "postingMode" IN ('SYSTEM','MANUAL') AND "journalEntryId" IS NOT NULL AND "postedBy" IS NOT NULL AND "postedAt" IS NOT NULL)),
  ADD CONSTRAINT "HrFinalSettlement_paid" CHECK ("status" NOT IN ('PAID','CLOSED') OR (
        "paidAmount" = "totalAmount" AND "paidOn" IS NOT NULL AND length(btrim(coalesce("paymentReference", ''))) >= 3
    AND "paymentProofDocumentId" IS NOT NULL AND "paymentJournalEntryId" IS NOT NULL AND "paidBy" IS NOT NULL AND "paidAt" IS NOT NULL
    AND "paidBy" <> "approvedBy" AND "paidBy" <> "calculatedBy" AND "paidBy" <> "reviewedBy" AND "paidBy" <> "preparedBy")),
  ADD CONSTRAINT "HrFinalSettlement_closed" CHECK ("status" <> 'CLOSED' OR ("closedBy" IS NOT NULL AND "closedAt" IS NOT NULL)),
  ADD CONSTRAINT "HrFinalSettlement_cancelled" CHECK ("status" <> 'CANCELLED' OR (
        "cancelledBy" IS NOT NULL AND "cancelledAt" IS NOT NULL AND length(btrim(coalesce("cancelReason", ''))) >= 3 AND "journalEntryId" IS NULL));
-- One live settlement per separation.
CREATE UNIQUE INDEX "HrFinalSettlement_one_live_per_separation" ON "HrFinalSettlement"("separationId") WHERE "status" <> 'CANCELLED';

-- Forward-only transitions; evidence frozen once the next stage has relied on it; never deleted.
CREATE OR REPLACE FUNCTION hr_final_settlement_guard() RETURNS trigger AS $$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  ident text[] := ARRAY['id','settlementNo','separationId','employeeId','preparedBy','createdAt'];
  calc text[] := ARRAY['eosAmount','leaveEncashmentDays','leaveEncashmentAmount','totalAmount','calcInputs','calcMethodNote','calcReference','calcDocumentId','eosProvisionAmount','leaveProvisionAmount','provisionReference','calculatedBy','calculatedAt'];
  rev text[] := ARRAY['reviewedBy','reviewedAt','reviewAttestation'];
  appr text[] := ARRAY['approvedBy','approvedAt','approvalNote'];
  post text[] := ARRAY['postingMode','journalEntryId','postedBy','postedAt'];
  paid text[] := ARRAY['paidAmount','paidOn','paymentReference','paymentProofDocumentId','paymentJournalEntryId','paidBy','paidAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: a final settlement is never deleted (cancel it)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'HR: a final settlement starts as DRAFT' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('CLOSED','CANCELLED') THEN
    RAISE EXCEPTION 'HR: a % final settlement never changes', OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF hr_p2_cols(n, ident) <> hr_p2_cols(o, ident) THEN
    RAISE EXCEPTION 'HR: a final settlement keeps its identity' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT (
       NEW."status" = OLD."status" AND OLD."status" = 'DRAFT'
    OR (OLD."status", NEW."status") IN (('DRAFT','CALCULATED'), ('CALCULATED','REVIEWED'), ('CALCULATED','DRAFT'), ('REVIEWED','DRAFT'),
                                        ('REVIEWED','APPROVED'), ('APPROVED','POSTED'), ('POSTED','PAID'), ('PAID','CLOSED'),
                                        ('DRAFT','CANCELLED'), ('CALCULATED','CANCELLED'), ('REVIEWED','CANCELLED'), ('APPROVED','CANCELLED'))) THEN
    RAISE EXCEPTION 'HR: a final settlement cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  -- Returned to DRAFT: the review is withdrawn with it.
  IF NEW."status" = 'DRAFT' AND (NEW."reviewedBy" IS NOT NULL OR NEW."approvedBy" IS NOT NULL) THEN
    RAISE EXCEPTION 'HR: a settlement returned to DRAFT carries no review or approval' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> 'DRAFT' THEN
    IF OLD."status" <> 'DRAFT' AND hr_p2_cols(n, calc) <> hr_p2_cols(o, calc) THEN
      RAISE EXCEPTION 'HR: the calculation of a final settlement is frozen once calculated' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD."status" IN ('REVIEWED','APPROVED','POSTED','PAID') AND hr_p2_cols(n, rev) <> hr_p2_cols(o, rev) THEN
      RAISE EXCEPTION 'HR: the review of a final settlement never changes' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD."status" IN ('APPROVED','POSTED','PAID') AND hr_p2_cols(n, appr) <> hr_p2_cols(o, appr) THEN
      RAISE EXCEPTION 'HR: the approval of a final settlement never changes' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD."status" IN ('POSTED','PAID') AND hr_p2_cols(n, post) <> hr_p2_cols(o, post) THEN
      RAISE EXCEPTION 'HR: the posting of a final settlement never changes' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD."status" = 'PAID' AND hr_p2_cols(n, paid) <> hr_p2_cols(o, paid) THEN
      RAISE EXCEPTION 'HR: the payment of a final settlement never changes' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER hr_final_settlement_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrFinalSettlement"
  FOR EACH ROW EXECUTE FUNCTION hr_final_settlement_guard();

COMMIT;
