-- P-2 independent-review corrections, settlements side (P1-B1, P1-B2, P2-B4, P2-B7, P3-B8).
-- Engineering CONTROLS only: no compensation formula, cap value, priority, threshold or GOSI rate is
-- set here, and no policy value is defaulted.
--
-- ADDITIVE:
--   · "HrPayrollAdjustment"."category" — a CLOSED list (CHECK, by kind); end of service, leave
--     encashment and final settlement are not on it (P1-B2). Existing rows are backfilled to
--     OTHER_WITH_MEMO by the column default, which is then dropped (no row trigger fires; no
--     existing value changes). A category never changes;
--   · "HrPayrollPolicy"."capBaseAfterUnearned" BOOLEAN, NULL = not decided (P2-B7). Existing
--     versions stay NULL: payroll refuses to run under them until a new, accountant-approved
--     version exists (P2-B6) — nothing is invented;
--   · final settlement: POSTED / PAID / CLOSED only with the settlement's HR-linked journals
--     (P1-B1) — a MANUAL posting is never accepted again;
--   · a HELD advance installment never changes month or order and is never deleted; its amount
--     only DECREASES, and only by what a recorded repayment covers (the open installments still
--     equal the outstanding balance) — never edited otherwise (P3-B8);
--   · GOSI (P2-B4): scheme and branch in the matching key (invoice lines, settlements,
--     adjustments; rows from before get 'UNSPECIFIED'); the difference type; the invoice lifecycle
--     ENTERED → RECONCILED → APPROVED (second person) → PAID (bank reference + HR-linked payment
--     journal) → CLOSED; a void is requested by one person and decided by another; the source file's
--     name, SHA-256 and (CSV) content; an invoice number is never live twice nor reused for another
--     month; table "HrGosiResolution" (append-only): a decision other than EMPLOYER_EXPENSE stays
--     OPEN until linked to its correction run or dispute outcome.
-- ONE existing guard function is REPLACED: hr_gosi_invoice_guard (the invoice now has a lifecycle;
-- its content stays immutable). The rollback restores the original body. Two unique indexes are
-- REPLACED by wider keys (GOSI invoice lines; one pending GOSI settlement per key).
--
-- DATA GUARD: the migration refuses (changes nothing) if two LIVE GOSI invoices already share an
-- invoice number, or one number is used for two months.
-- Same runtime-role assumption as 20261017120000: the guards hold only while the application's role
-- cannot disable triggers. Atomic: one transaction.
-- Rollback: docs/hr/migration-review/rollback-20261017130000_hr_p2_settlement_fixes.sql.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT lower(btrim("reference")) FROM "HrGosiInvoice" WHERE "status" <> 'VOID' GROUP BY 1 HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'migration refused: two live GOSI invoices share an invoice number; void one deliberately first';
  END IF;
  IF EXISTS (SELECT lower(btrim("reference")) FROM "HrGosiInvoice" GROUP BY 1 HAVING count(DISTINCT "periodMonth") > 1) THEN
    RAISE EXCEPTION 'migration refused: a GOSI invoice number is used for two months; review those invoices first';
  END IF;
END $$;

-- ── 1 · P1-B2: payroll adjustment categories (closed list) ───────────────────────────────────
ALTER TABLE "HrPayrollAdjustment" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'OTHER_WITH_MEMO';
ALTER TABLE "HrPayrollAdjustment" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "HrPayrollAdjustment" ADD CONSTRAINT "HrPayrollAdjustment_category" CHECK (
     ("kind" = 'EARNING' AND "category" IN ('OVERTIME_CORRECTION','ALLOWANCE_CORRECTION','SALARY_ARREARS','APPROVED_BONUS','OTHER_WITH_MEMO'))
  OR ("kind" = 'DEDUCTION' AND "category" IN ('CONSENTED_DEDUCTION','COURT_ORDER_DEDUCTION','DAMAGE_DEDUCTION','OTHER_WITH_MEMO')));

CREATE OR REPLACE FUNCTION hr_adjustment_category_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."category" IS DISTINCT FROM OLD."category" THEN
    RAISE EXCEPTION 'HR: the category of a payroll adjustment never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_adjustment_category_guard BEFORE UPDATE ON "HrPayrollAdjustment"
  FOR EACH ROW EXECUTE FUNCTION hr_adjustment_category_guard();

-- ── 2 · P2-B7: cap base after unearned pay — an accountant decision, never defaulted ────────────
ALTER TABLE "HrPayrollPolicy" ADD COLUMN "capBaseAfterUnearned" BOOLEAN;

-- ── 3 · P1-B1: a final settlement moves only with its HR-linked journals ─────────────────────
CREATE OR REPLACE FUNCTION hr_final_settlement_journal_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'POSTED' AND OLD."status" <> 'POSTED' AND (
       NEW."postingMode" IS DISTINCT FROM 'SYSTEM' OR NOT EXISTS (
         SELECT 1 FROM "HrJournalLink" l WHERE l."sourceType" = 'FINAL_SETTLEMENT' AND l."sourceId" = NEW."id" AND l."purpose" = 'ACCRUAL' AND l."journalEntryId" = NEW."journalEntryId")) THEN
    RAISE EXCEPTION 'HR: a final settlement is POSTED only with its HR-linked accrual journal' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'PAID' AND OLD."status" <> 'PAID' AND NOT EXISTS (
       SELECT 1 FROM "HrJournalLink" l WHERE l."sourceType" = 'FINAL_SETTLEMENT' AND l."sourceId" = NEW."id" AND l."purpose" = 'PAYMENT' AND l."journalEntryId" = NEW."paymentJournalEntryId") THEN
    RAISE EXCEPTION 'HR: a final settlement is PAID only with its HR-linked payment journal' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'CLOSED' AND OLD."status" <> 'CLOSED' AND (
       NOT EXISTS (SELECT 1 FROM "HrJournalLink" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
                    WHERE l."sourceType" = 'FINAL_SETTLEMENT' AND l."sourceId" = NEW."id" AND l."purpose" = 'ACCRUAL' AND l."journalEntryId" = NEW."journalEntryId" AND e."status" = 'POSTED')
    OR NOT EXISTS (SELECT 1 FROM "HrJournalLink" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
                    WHERE l."sourceType" = 'FINAL_SETTLEMENT' AND l."sourceId" = NEW."id" AND l."purpose" = 'PAYMENT' AND l."journalEntryId" = NEW."paymentJournalEntryId" AND e."status" = 'POSTED')) THEN
    RAISE EXCEPTION 'HR: a final settlement is CLOSED only while both HR-linked journals are posted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_final_settlement_journal_guard BEFORE UPDATE ON "HrFinalSettlement"
  FOR EACH ROW EXECUTE FUNCTION hr_final_settlement_journal_guard();

-- ── 4 · P3-B8: a HELD installment keeps its month and order; its amount only falls by a repayment ─
CREATE OR REPLACE FUNCTION hr_installment_held_guard() RETURNS trigger AS $$
DECLARE adv numeric; settled numeric; repaid numeric; open_rest numeric;
BEGIN
  IF OLD."status" = 'HELD' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'HR: a held installment is never deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."dueMonth" <> OLD."dueMonth" OR NEW."seq" <> OLD."seq" OR NEW."advanceId" <> OLD."advanceId"
       OR NEW."recoveryRequestId" IS DISTINCT FROM OLD."recoveryRequestId" THEN
      RAISE EXCEPTION 'HR: a held installment keeps its month, order and recovery decision' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."amount" <> OLD."amount" THEN
      -- Only the remainder after a recorded repayment: a decrease that leaves the open installments
      -- (scheduled, reserved, held) equal to amount − settled − repaid. Never an increase, never 0.
      SELECT "amount" INTO adv FROM "HrAdvance" WHERE "id" = NEW."advanceId";
      SELECT COALESCE(sum("amount"), 0) INTO settled FROM "HrAdvanceInstallment" WHERE "advanceId" = NEW."advanceId" AND "status" = 'SETTLED';
      SELECT COALESCE(sum("amount"), 0) INTO repaid FROM "HrAdvanceRepayment" WHERE "advanceId" = NEW."advanceId";
      SELECT COALESCE(sum("amount"), 0) INTO open_rest FROM "HrAdvanceInstallment"
       WHERE "advanceId" = NEW."advanceId" AND "id" <> NEW."id" AND "status" IN ('SCHEDULED', 'RESERVED', 'HELD');
      IF NEW."status" <> 'HELD' OR NEW."amount" >= OLD."amount" OR NEW."amount" <= 0 OR open_rest + NEW."amount" <> adv - settled - repaid THEN
        RAISE EXCEPTION 'HR: a held installment keeps its amount (only a recorded repayment reduces it)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_installment_held_guard BEFORE UPDATE OR DELETE ON "HrAdvanceInstallment"
  FOR EACH ROW EXECUTE FUNCTION hr_installment_held_guard();

-- ── 5 · P2-B4: GOSI matching key (scheme + branch), difference type ──────────────────────────
ALTER TABLE "HrGosiInvoiceLine" ADD COLUMN "scheme" TEXT NOT NULL DEFAULT 'UNSPECIFIED',
  ADD COLUMN "branch" TEXT NOT NULL DEFAULT 'UNSPECIFIED',
  ADD COLUMN "days" INTEGER;
ALTER TABLE "HrGosiInvoiceLine" ALTER COLUMN "scheme" DROP DEFAULT, ALTER COLUMN "branch" DROP DEFAULT;
ALTER TABLE "HrGosiInvoiceLine" ADD CONSTRAINT "HrGosiInvoiceLine_key" CHECK (length(btrim("scheme")) >= 1 AND length(btrim("branch")) >= 1 AND ("days" IS NULL OR "days" BETWEEN 0 AND 31));
DROP INDEX "HrGosiInvoiceLine_invoiceId_employeeId_share_key";
CREATE UNIQUE INDEX "HrGosiInvoiceLine_invoiceId_employeeId_scheme_branch_share_key" ON "HrGosiInvoiceLine"("invoiceId", "employeeId", "scheme", "branch", "share");

ALTER TABLE "HrGosiSettlement" ADD COLUMN "scheme" TEXT NOT NULL DEFAULT 'UNSPECIFIED',
  ADD COLUMN "branch" TEXT NOT NULL DEFAULT 'UNSPECIFIED',
  ADD COLUMN "differenceType" TEXT;
ALTER TABLE "HrGosiSettlement" ALTER COLUMN "scheme" DROP DEFAULT, ALTER COLUMN "branch" DROP DEFAULT;
ALTER TABLE "HrGosiSettlement" ADD CONSTRAINT "HrGosiSettlement_difference_type" CHECK ("differenceType" IS NULL OR "differenceType" IN
  ('MISSING_IN_PAYROLL','MISSING_IN_INVOICE','WAGE_MISMATCH','DAYS_MISMATCH','RATE_MISMATCH','CATEGORY_MISMATCH','ROUNDING','AMOUNT_MISMATCH'));
DROP INDEX "HrGosiSettlement_one_pending";
CREATE UNIQUE INDEX "HrGosiSettlement_one_pending" ON "HrGosiSettlement"("invoiceId", "employeeId", "scheme", "branch", "share") WHERE "status" = 'PENDING';

ALTER TABLE "HrGosiAdjustment" ADD COLUMN "scheme" TEXT NOT NULL DEFAULT 'UNSPECIFIED',
  ADD COLUMN "branch" TEXT NOT NULL DEFAULT 'UNSPECIFIED';
ALTER TABLE "HrGosiAdjustment" ALTER COLUMN "scheme" DROP DEFAULT, ALTER COLUMN "branch" DROP DEFAULT;

-- ── 6 · P2-B4: GOSI invoice lifecycle, second-person void, source file, unique number ───────
ALTER TABLE "HrGosiInvoice"
  ADD COLUMN "stage" TEXT NOT NULL DEFAULT 'ENTERED',
  ADD COLUMN "reconciledBy" TEXT,
  ADD COLUMN "reconciledAt" TIMESTAMP(3),
  ADD COLUMN "reconcileDigest" TEXT,
  ADD COLUMN "approvedBy" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvalNote" TEXT,
  ADD COLUMN "paidBy" TEXT,
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "paidOn" DATE,
  ADD COLUMN "paidAmount" DECIMAL(18,2),
  ADD COLUMN "paymentReference" TEXT,
  ADD COLUMN "paymentJournalEntryId" TEXT,
  ADD COLUMN "closedBy" TEXT,
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "voidRequestedBy" TEXT,
  ADD COLUMN "voidRequestedAt" TIMESTAMP(3),
  ADD COLUMN "voidRequestReason" TEXT,
  ADD COLUMN "sourceFileName" TEXT,
  ADD COLUMN "sourceFileSha256" TEXT,
  ADD COLUMN "sourceContent" TEXT;
CREATE UNIQUE INDEX "HrGosiInvoice_paymentJournalEntryId_key" ON "HrGosiInvoice"("paymentJournalEntryId");
CREATE UNIQUE INDEX "HrGosiInvoice_reference_live" ON "HrGosiInvoice"(lower(btrim("reference"))) WHERE "status" <> 'VOID';
ALTER TABLE "HrGosiInvoice"
  ADD CONSTRAINT "HrGosiInvoice_stage" CHECK ("stage" IN ('ENTERED','RECONCILED','APPROVED','PAID','CLOSED')),
  ADD CONSTRAINT "HrGosiInvoice_reconciled" CHECK ("stage" = 'ENTERED' OR ("reconciledBy" IS NOT NULL AND "reconciledAt" IS NOT NULL AND "reconcileDigest" IS NOT NULL)),
  ADD CONSTRAINT "HrGosiInvoice_approved" CHECK ("stage" IN ('ENTERED','RECONCILED') OR ("approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedBy" <> "enteredBy" AND "approvedBy" <> "reconciledBy")),
  ADD CONSTRAINT "HrGosiInvoice_paid" CHECK ("stage" NOT IN ('PAID','CLOSED') OR (
        "paidBy" IS NOT NULL AND "paidAt" IS NOT NULL AND "paidOn" IS NOT NULL AND "paidAmount" IS NOT NULL AND "paidAmount" > 0
    AND length(btrim(coalesce("paymentReference", ''))) >= 3 AND "paymentJournalEntryId" IS NOT NULL AND "paidBy" <> "approvedBy")),
  ADD CONSTRAINT "HrGosiInvoice_closed" CHECK ("stage" <> 'CLOSED' OR ("closedBy" IS NOT NULL AND "closedAt" IS NOT NULL)),
  ADD CONSTRAINT "HrGosiInvoice_void_request" CHECK (("voidRequestedBy" IS NULL) = ("voidRequestedAt" IS NULL)
    AND ("voidRequestedBy" IS NULL OR length(btrim(coalesce("voidRequestReason", ''))) >= 5)),
  ADD CONSTRAINT "HrGosiInvoice_source_hash" CHECK ("sourceFileSha256" IS NULL OR "sourceFileSha256" ~ '^[0-9a-f]{64}$');

-- REPLACED (was: only the void columns could change). Content stays immutable; the lifecycle moves
-- forward only; the evidence of each stage is frozen once the next relies on it; a void needs a
-- second person and is possible only before approval; nothing is deleted.
CREATE OR REPLACE FUNCTION hr_gosi_invoice_guard() RETURNS trigger AS $$
DECLARE
  life text[] := ARRAY['status','voidedBy','voidedAt','voidReason','stage','reconciledBy','reconciledAt','reconcileDigest','approvedBy','approvedAt','approvalNote',
                       'paidBy','paidAt','paidOn','paidAmount','paymentReference','paymentJournalEntryId','closedBy','closedAt','voidRequestedBy','voidRequestedAt','voidRequestReason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: a GOSI invoice is never deleted (void it)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."stage" <> 'ENTERED' OR NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'HR: a GOSI invoice is entered ACTIVE / ENTERED' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."sourceFileName" IS NULL OR length(btrim(NEW."sourceFileName")) < 3 OR NEW."sourceFileSha256" IS NULL THEN
      RAISE EXCEPTION 'HR: a GOSI invoice records its source file name and SHA-256' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "HrGosiInvoice" i WHERE lower(btrim(i."reference")) = lower(btrim(NEW."reference")) AND i."periodMonth" <> NEW."periodMonth") THEN
      RAISE EXCEPTION 'HR: a GOSI invoice number is never reused for another month' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'HR: a void GOSI invoice never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."stage" = 'CLOSED' THEN
    RAISE EXCEPTION 'HR: a closed GOSI invoice never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - life) <> (to_jsonb(OLD) - life) THEN
    RAISE EXCEPTION 'HR: a GOSI invoice is never edited (void it and enter it again)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT (NEW."stage" = OLD."stage" OR (OLD."stage", NEW."stage") IN (('ENTERED','RECONCILED'), ('RECONCILED','APPROVED'), ('APPROVED','PAID'), ('PAID','CLOSED'))) THEN
    RAISE EXCEPTION 'HR: a GOSI invoice cannot go from % to %', OLD."stage", NEW."stage" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."stage" IN ('APPROVED','PAID') AND (hr_p2_cols(to_jsonb(NEW), ARRAY['reconciledBy','reconciledAt','reconcileDigest','approvedBy','approvedAt','approvalNote'])
                                           <> hr_p2_cols(to_jsonb(OLD), ARRAY['reconciledBy','reconciledAt','reconcileDigest','approvedBy','approvedAt','approvalNote'])) THEN
    RAISE EXCEPTION 'HR: the reconciliation and approval of a GOSI invoice never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."stage" = 'PAID' AND (hr_p2_cols(to_jsonb(NEW), ARRAY['paidBy','paidAt','paidOn','paidAmount','paymentReference','paymentJournalEntryId'])
                             <> hr_p2_cols(to_jsonb(OLD), ARRAY['paidBy','paidAt','paidOn','paidAmount','paymentReference','paymentJournalEntryId'])) THEN
    RAISE EXCEPTION 'HR: the payment of a GOSI invoice never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."stage" = 'PAID' AND OLD."stage" <> 'PAID' AND NOT EXISTS (
       SELECT 1 FROM "HrJournalLink" l WHERE l."sourceType" = 'GOSI_INVOICE' AND l."sourceId" = NEW."id" AND l."purpose" = 'PAYMENT' AND l."journalEntryId" = NEW."paymentJournalEntryId") THEN
    RAISE EXCEPTION 'HR: a GOSI invoice is PAID only with its HR-linked payment journal' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stage" NOT IN ('ENTERED','RECONCILED') AND (NEW."voidRequestedBy" IS NOT NULL) THEN
    RAISE EXCEPTION 'HR: an approved GOSI invoice is not voided' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'VOID' THEN
    IF OLD."stage" NOT IN ('ENTERED','RECONCILED') OR NEW."stage" <> OLD."stage" THEN
      RAISE EXCEPTION 'HR: only a GOSI invoice not yet approved is voided' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."voidRequestedBy" IS NULL OR NEW."voidedBy" IS NULL OR NEW."voidedBy" = NEW."voidRequestedBy" THEN
      RAISE EXCEPTION 'HR: a GOSI invoice is voided by a second person, on another person''s request' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER hr_gosi_invoice_guard ON "HrGosiInvoice";
CREATE TRIGGER hr_gosi_invoice_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrGosiInvoice"
  FOR EACH ROW EXECUTE FUNCTION hr_gosi_invoice_guard();

-- ── 7 · P2-B4: a non-employer decision stays OPEN until linked to its outcome ────────────────
CREATE TABLE "HrGosiResolution" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "correctionRunId" TEXT,
    "reference" TEXT NOT NULL,
    "note" TEXT,
    "resolvedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HrGosiResolution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HrGosiResolution_outcome" CHECK ("outcome" IN ('CORRECTION_RUN','INVOICE_CORRECTED','DISPUTE_REJECTED','ACCEPTED')),
    CONSTRAINT "HrGosiResolution_reference" CHECK (length(btrim("reference")) >= 3),
    CONSTRAINT "HrGosiResolution_run" CHECK (("outcome" = 'CORRECTION_RUN') = ("correctionRunId" IS NOT NULL))
);
CREATE UNIQUE INDEX "HrGosiResolution_settlementId_key" ON "HrGosiResolution"("settlementId");
ALTER TABLE "HrGosiResolution" ADD CONSTRAINT "HrGosiResolution_settlementId_fkey"
  FOREIGN KEY ("settlementId") REFERENCES "HrGosiSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "HrGosiResolution_append_only" BEFORE UPDATE OR DELETE ON "HrGosiResolution"
  FOR EACH ROW EXECUTE FUNCTION hr_forbid_mutation();

CREATE OR REPLACE FUNCTION hr_gosi_resolution_guard() RETURNS trigger AS $$
DECLARE s RECORD; r RECORD;
BEGIN
  SELECT "status", "action", "periodMonth", "decidedAt" INTO s FROM "HrGosiSettlement" WHERE "id" = NEW."settlementId";
  IF NOT FOUND OR s."status" <> 'APPROVED' OR s."action" = 'EMPLOYER_EXPENSE' THEN
    RAISE EXCEPTION 'HR: only an approved GOSI decision other than EMPLOYER_EXPENSE is resolved' USING ERRCODE = 'check_violation';
  END IF;
  IF (s."action" = 'PAYROLL_CORRECTION' AND NEW."outcome" <> 'CORRECTION_RUN')
     OR (s."action" = 'INVOICE_DISPUTE' AND NEW."outcome" NOT IN ('INVOICE_CORRECTED','DISPUTE_REJECTED'))
     OR (s."action" = 'NO_ADJUSTMENT' AND NEW."outcome" <> 'ACCEPTED') THEN
    RAISE EXCEPTION 'HR: a GOSI decision is resolved by the outcome its action calls for' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."correctionRunId" IS NOT NULL THEN
    SELECT "kind", "status", "periodMonth", "approvedAt" INTO r FROM "HrPayrollRun" WHERE "id" = NEW."correctionRunId";
    IF NOT FOUND OR r."kind" <> 'CORRECTION' OR r."status" NOT IN ('APPROVED','PAID') OR r."periodMonth" <> s."periodMonth" OR r."approvedAt" < s."decidedAt" THEN
      RAISE EXCEPTION 'HR: a payroll-correction decision is resolved by an approved correction run of that month, approved after the decision' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_gosi_resolution_guard BEFORE INSERT ON "HrGosiResolution"
  FOR EACH ROW EXECUTE FUNCTION hr_gosi_resolution_guard();

COMMIT;
