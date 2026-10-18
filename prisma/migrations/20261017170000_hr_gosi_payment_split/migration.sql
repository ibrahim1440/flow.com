-- P-2 rev3 item 3 (D-4h): a GOSI invoice's PAYMENT status is separate from its DIFFERENCE status.
-- Engineering CONTROL only: no GOSI rate, threshold, account mapping or treatment is approved here.
--
-- 1 · Payment = bank reality. HrGosiInvoicePayment records each amount actually paid to GOSI, with
--     its bank reference (unique) and its own HR journal PAYMENT:<id> (Dr CONTRIB_PAYABLE /
--     Cr PAYROLL_CASH, posted by the application). Partial payments are recorded as such. The
--     invoice reaches stage PAID when the payments equal the invoice total — open differences do
--     not stop it (re-review N3's refusal moves to CLOSE, in the application). Never more than the
--     invoice total; never by the invoice's approver; only on an APPROVED invoice.
-- 2 · Differences = a register. A difference is booked only through a treatment the accountant
--     approved: HrGosiTreatment holds the nine cases of the D-4h matrix, ALL DISABLED, with NO
--     posting keys. A case is enabled only by an applied two-person configuration change
--     (HrConfigChangeKind GOSI_TREATMENT_SET) naming both keys and the decision reference; the
--     CHECK below refuses an enabled row without them. A decision on a disabled case is recorded,
--     stays OPEN and flagged in the register, and posts nothing.
-- 3 · A settlement names its case (HrGosiSettlement."treatmentCase"); two decision actions are added
--     (EMPLOYEE_RECEIVABLE, EMPLOYEE_REFUND) for cases 2a and 4. A booked adjustment records the case
--     and the keys it posted with.
--
-- ADDITIVE: one enum value; two tables (nine seeded rows, all disabled); nullable columns; two CHECK
-- constraints widened (a superset of their values); two new guards; hr_gosi_invoice_guard REPLACED
-- (20261017130000) with one widened rule (PAID may rest on PAYMENT:<id> journals). No existing row
-- is changed. Atomic.
--
-- Rollback: docs/hr/migration-review/rollback-20261017170000_hr_gosi_payment_split.sql
BEGIN;

ALTER TYPE "HrConfigChangeKind" ADD VALUE IF NOT EXISTS 'GOSI_TREATMENT_SET';

-- ── 1 · treatment matrix (D-4h), every case disabled ──────────────────────────────────────────
CREATE TABLE "HrGosiTreatment" (
    "caseCode" TEXT NOT NULL,
    "posting" BOOLEAN NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "debitKey" TEXT,
    "creditKey" TEXT,
    "decisionReference" TEXT,
    "requestedBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "configChangeId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HrGosiTreatment_pkey" PRIMARY KEY ("caseCode"),
    CONSTRAINT "HrGosiTreatment_case" CHECK ("caseCode" IN ('CASE_1_EMPLOYER_INVOICE_HIGHER', 'CASE_2A_EMPLOYEE_SHARE_RECOVER', 'CASE_2B_EMPLOYEE_SHARE_EMPLOYER_BORNE',
      'CASE_3_EMPLOYER_INVOICE_LOWER', 'CASE_4_EMPLOYEE_SHARE_REFUND', 'CASE_5_ALREADY_BOOKED', 'CASE_6_REGISTRATION_CORRECTED', 'CASE_7_ROUNDING', 'CASE_8_DISPUTED')),
    -- An enabled case is a posting case approved by a second person, with both keys and the accountant's decision named.
    CONSTRAINT "HrGosiTreatment_enabled" CHECK (NOT "enabled" OR (
      "posting" AND "debitKey" IS NOT NULL AND "creditKey" IS NOT NULL AND "debitKey" <> "creditKey"
      AND "decisionReference" IS NOT NULL AND length(btrim("decisionReference")) >= 3
      AND "requestedBy" IS NOT NULL AND "approvedBy" IS NOT NULL AND "approvedBy" <> "requestedBy" AND "approvedAt" IS NOT NULL AND "configChangeId" IS NOT NULL))
);
INSERT INTO "HrGosiTreatment" ("caseCode", "posting") VALUES
  ('CASE_1_EMPLOYER_INVOICE_HIGHER', true),
  ('CASE_2A_EMPLOYEE_SHARE_RECOVER', true),
  ('CASE_2B_EMPLOYEE_SHARE_EMPLOYER_BORNE', true),
  ('CASE_3_EMPLOYER_INVOICE_LOWER', true),
  ('CASE_4_EMPLOYEE_SHARE_REFUND', true),
  ('CASE_5_ALREADY_BOOKED', false),
  ('CASE_6_REGISTRATION_CORRECTED', false),
  ('CASE_7_ROUNDING', true),
  ('CASE_8_DISPUTED', true);

CREATE OR REPLACE FUNCTION hr_gosi_treatment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'HR: the GOSI treatment matrix has exactly its nine cases (none added or removed)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."caseCode" <> OLD."caseCode" OR NEW."posting" <> OLD."posting" THEN
    RAISE EXCEPTION 'HR: a GOSI treatment case and whether it posts never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Every change goes through an applied two-person configuration change, named on the row.
  IF NEW."configChangeId" IS NULL OR NEW."configChangeId" IS NOT DISTINCT FROM OLD."configChangeId"
     OR NOT EXISTS (SELECT 1 FROM "HrConfigChange" c WHERE c."id" = NEW."configChangeId" AND c."kind"::text = 'GOSI_TREATMENT_SET'
                    AND c."status" = 'APPLIED' AND c."decidedBy" IS NOT NULL AND c."decidedBy" <> c."requestedBy"
                    AND c."targetKey" = 'GOSI_TREATMENT:' || NEW."caseCode") THEN
    RAISE EXCEPTION 'HR: a GOSI treatment changes only through its own applied two-person configuration change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_gosi_treatment_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrGosiTreatment"
  FOR EACH ROW EXECUTE FUNCTION hr_gosi_treatment_guard();

-- ── 2 · a decision names its case; the two employee-share actions ──────────────────────────────
ALTER TABLE "HrGosiSettlement" ADD COLUMN "treatmentCase" TEXT;
ALTER TABLE "HrGosiSettlement" ADD CONSTRAINT "HrGosiSettlement_treatment_case" CHECK ("treatmentCase" IS NULL OR "treatmentCase" IN (
  'CASE_1_EMPLOYER_INVOICE_HIGHER', 'CASE_2A_EMPLOYEE_SHARE_RECOVER', 'CASE_2B_EMPLOYEE_SHARE_EMPLOYER_BORNE', 'CASE_3_EMPLOYER_INVOICE_LOWER',
  'CASE_4_EMPLOYEE_SHARE_REFUND', 'CASE_5_ALREADY_BOOKED', 'CASE_6_REGISTRATION_CORRECTED', 'CASE_7_ROUNDING', 'CASE_8_DISPUTED'));
ALTER TABLE "HrGosiSettlement" DROP CONSTRAINT "HrGosiSettlement_action";
ALTER TABLE "HrGosiSettlement" ADD CONSTRAINT "HrGosiSettlement_action" CHECK ("action" IN ('EMPLOYER_EXPENSE','PAYROLL_CORRECTION','INVOICE_DISPUTE','NO_ADJUSTMENT','EMPLOYEE_RECEIVABLE','EMPLOYEE_REFUND'));
ALTER TABLE "HrGosiAdjustment" ADD COLUMN "treatmentCase" TEXT, ADD COLUMN "debitKey" TEXT, ADD COLUMN "creditKey" TEXT;
ALTER TABLE "HrGosiAdjustment" DROP CONSTRAINT "HrGosiAdjustment_action";
ALTER TABLE "HrGosiAdjustment" ADD CONSTRAINT "HrGosiAdjustment_action" CHECK ("action" IN ('EMPLOYER_EXPENSE','PAYROLL_CORRECTION','INVOICE_DISPUTE','NO_ADJUSTMENT','EMPLOYEE_RECEIVABLE','EMPLOYEE_REFUND'));
-- A booked adjustment of a named case carries the keys it posted with, and its case was enabled.
ALTER TABLE "HrGosiAdjustment" ADD CONSTRAINT "HrGosiAdjustment_treatment_keys" CHECK (("treatmentCase" IS NULL) = ("debitKey" IS NULL) AND ("debitKey" IS NULL) = ("creditKey" IS NULL));

CREATE OR REPLACE FUNCTION hr_gosi_adjustment_treatment_guard() RETURNS trigger AS $$
DECLARE t RECORD;
BEGIN
  IF NEW."treatmentCase" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO t FROM "HrGosiTreatment" WHERE "caseCode" = NEW."treatmentCase";
  IF NOT FOUND OR NOT t."enabled" OR t."debitKey" IS DISTINCT FROM NEW."debitKey" OR t."creditKey" IS DISTINCT FROM NEW."creditKey" THEN
    RAISE EXCEPTION 'HR: a GOSI difference is booked only under its enabled treatment, with that treatment''s keys' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_gosi_adjustment_treatment_guard BEFORE INSERT ON "HrGosiAdjustment"
  FOR EACH ROW EXECUTE FUNCTION hr_gosi_adjustment_treatment_guard();

-- ── 3 · invoice payments (bank reality) ────────────────────────────────────────────────────────
CREATE TABLE "HrGosiInvoicePayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "bankReference" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HrGosiInvoicePayment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HrGosiInvoicePayment_amount" CHECK ("amount" > 0),
    CONSTRAINT "HrGosiInvoicePayment_reference" CHECK (length(btrim("bankReference")) >= 3),
    CONSTRAINT "HrGosiInvoicePayment_key" CHECK (length("idempotencyKey") BETWEEN 8 AND 80)
);
CREATE UNIQUE INDEX "HrGosiInvoicePayment_bankReference_key" ON "HrGosiInvoicePayment"(lower(btrim("bankReference")));
CREATE UNIQUE INDEX "HrGosiInvoicePayment_invoiceId_idempotencyKey_key" ON "HrGosiInvoicePayment"("invoiceId", "idempotencyKey");
ALTER TABLE "HrGosiInvoicePayment" ADD CONSTRAINT "HrGosiInvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "HrGosiInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION hr_gosi_invoice_payment_guard() RETURNS trigger AS $$
DECLARE inv RECORD; paid numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'HR: a GOSI invoice payment is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO inv FROM "HrGosiInvoice" WHERE "id" = NEW."invoiceId" FOR UPDATE;
  IF NOT FOUND OR inv."status" <> 'ACTIVE' OR inv."stage" <> 'APPROVED' THEN
    RAISE EXCEPTION 'HR: a GOSI payment is recorded against an approved, active invoice not yet fully paid' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recordedBy" = inv."approvedBy" THEN
    RAISE EXCEPTION 'HR: the approver of a GOSI invoice never records its payment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum("amount"), 0) INTO paid FROM "HrGosiInvoicePayment" WHERE "invoiceId" = NEW."invoiceId";
  IF paid + NEW."amount" > inv."totalEmployee" + inv."totalEmployer" THEN
    RAISE EXCEPTION 'HR: the payments of a GOSI invoice never exceed its total' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_gosi_invoice_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrGosiInvoicePayment"
  FOR EACH ROW EXECUTE FUNCTION hr_gosi_invoice_payment_guard();

-- ── 4 · invoice lifecycle (replaces 20261017130000): PAID may rest on per-payment journals ─────
CREATE OR REPLACE FUNCTION hr_gosi_invoice_guard() RETURNS trigger AS $$
DECLARE
  life text[] := ARRAY['status','voidedBy','voidedAt','voidReason','stage','reconciledBy','reconciledAt','reconcileDigest','approvedBy','approvedAt','approvalNote',
                       'paidBy','paidAt','paidOn','paidAmount','paymentReference','paymentJournalEntryId','closedBy','closedAt','voidRequestedBy','voidRequestedAt','voidRequestReason'];
  paid numeric; n_pay int; n_unbooked int;
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
  IF NEW."stage" = 'PAID' AND OLD."stage" <> 'PAID' THEN
    SELECT count(*), COALESCE(sum("amount"), 0) INTO n_pay, paid FROM "HrGosiInvoicePayment" WHERE "invoiceId" = NEW."id";
    IF n_pay = 0 THEN
      -- The single-payment path of 20261017130000.
      IF NOT EXISTS (SELECT 1 FROM "HrJournalLink" l WHERE l."sourceType" = 'GOSI_INVOICE' AND l."sourceId" = NEW."id" AND l."purpose" = 'PAYMENT' AND l."journalEntryId" = NEW."paymentJournalEntryId") THEN
        RAISE EXCEPTION 'HR: a GOSI invoice is PAID only with its HR-linked payment journal' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      -- Recorded payments: they equal the invoice total and the paid amount, each has its journal, and
      -- the payment journal named on the invoice is one of them.
      IF paid <> NEW."totalEmployee" + NEW."totalEmployer" OR paid <> NEW."paidAmount" THEN
        RAISE EXCEPTION 'HR: a GOSI invoice is PAID only when its recorded payments equal its total' USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO n_unbooked FROM "HrGosiInvoicePayment" p WHERE p."invoiceId" = NEW."id"
        AND NOT EXISTS (SELECT 1 FROM "HrJournalLink" l WHERE l."sourceType" = 'GOSI_INVOICE' AND l."sourceId" = NEW."id" AND l."purpose" = 'PAYMENT:' || p."id");
      IF n_unbooked > 0 OR NOT EXISTS (SELECT 1 FROM "HrJournalLink" l WHERE l."sourceType" = 'GOSI_INVOICE' AND l."sourceId" = NEW."id" AND l."purpose" LIKE 'PAYMENT:%' AND l."journalEntryId" = NEW."paymentJournalEntryId") THEN
        RAISE EXCEPTION 'HR: a GOSI invoice is PAID only with an HR-linked journal for every payment' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
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

COMMIT;
