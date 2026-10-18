-- P-2 rev3 item 2 (Finding 12, P1): proof of payment per employee.
-- Engineering CONTROL only: no compensation formula, rate, account mapping or policy value.
--
-- A recorded payment (HrPayrollPayment) is what left the bank: one transfer for one employee line,
-- or one bulk transfer for many. It is NOT proof that each employee received their net. That proof
-- is an ALLOCATION: a row naming the payment, the run, the employee line, the payee and the bank
-- reference of that employee's credit (entered by hand, or from an imported bank result file).
--   · Σ allocations + Σ rejections of a payment never exceed the payment;
--   · per line: Σ allocations − Σ returned allocations never exceed the line's net;
--   · a bank reference is used once (allocations; returns / rejections) — a retried request or a
--     re-imported result can never record a second credit;
--   · a RETURNED allocation (the bank returned the credit) or a REJECTED part of a bulk payment
--     (the bank never credited the employee) is a return row; it reopens the line and has its own
--     journal (RETURN:<id>, Dr PAYROLL_CASH / Cr SALARIES_PAYABLE, posted by the application);
--   · a run is PAID only when every line is fully settled (allocated − returned = net), every
--     payment is fully accounted for (allocated + rejected = amount), payments − returns = net,
--     and every payment and return has its HR-linked journal;
--   · a PAID run goes back to APPROVED only after a return reopened one of its lines;
--   · a run is still paid per line or as a whole, never both — except that a line a return or
--     rejection reopened is paid again by its own per-line payment.
-- A bank file the system produces (the CSV export) is never proof: nothing here reads it.
--
-- ADDITIVE: three tables; three new guard functions / triggers; three existing guard functions
-- are REPLACED with a superset of their rules (hr_payroll_payment_guard and
-- hr_payroll_run_controls_guard from 20261017090000, hr_payroll_run_guard from 20261008120000 — its
-- one change: PAID → APPROVED after a return). No existing row is changed or re-validated: PAID runs
-- stay as they are. Atomic: one transaction.
--
-- Rollback: docs/hr/migration-review/rollback-20261017160000_hr_payroll_payment_proof.sql
BEGIN;

-- ── 1 · tables ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "HrPayrollBankImport" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "paidRows" INTEGER NOT NULL,
    "returnedRows" INTEGER NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HrPayrollBankImport_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HrPayrollBankImport_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "HrPayrollBankImport_file" CHECK (length(btrim("fileName")) >= 3),
    CONSTRAINT "HrPayrollBankImport_rows" CHECK ("rowCount" >= 1 AND "paidRows" >= 0 AND "returnedRows" >= 0 AND "paidRows" + "returnedRows" = "rowCount")
);
CREATE UNIQUE INDEX "HrPayrollBankImport_runId_sha256_key" ON "HrPayrollBankImport"("runId", "sha256");
ALTER TABLE "HrPayrollBankImport" ADD CONSTRAINT "HrPayrollBankImport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "HrPayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HrPayrollBankImport" ADD CONSTRAINT "HrPayrollBankImport_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "HrPayrollPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HrPayrollPaymentAllocation" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "bankReference" TEXT NOT NULL,
    "payeeAccountLast4" TEXT,
    "source" TEXT NOT NULL,
    "importId" TEXT,
    "idempotencyKey" TEXT,
    "confirmedOn" DATE NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HrPayrollPaymentAllocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HrPayrollPaymentAllocation_amount" CHECK ("amount" > 0),
    CONSTRAINT "HrPayrollPaymentAllocation_reference" CHECK (length(btrim("bankReference")) >= 3),
    CONSTRAINT "HrPayrollPaymentAllocation_source" CHECK ("source" IN ('LINE_PAYMENT', 'MANUAL', 'BANK_IMPORT')),
    CONSTRAINT "HrPayrollPaymentAllocation_import" CHECK (("source" = 'BANK_IMPORT') = ("importId" IS NOT NULL)),
    CONSTRAINT "HrPayrollPaymentAllocation_last4" CHECK ("payeeAccountLast4" IS NULL OR "payeeAccountLast4" ~ '^[0-9A-Z]{4}$')
);
CREATE UNIQUE INDEX "HrPayrollPaymentAllocation_bankReference_key" ON "HrPayrollPaymentAllocation"(lower(btrim("bankReference")));
CREATE UNIQUE INDEX "HrPayrollPaymentAllocation_runId_idempotencyKey_key" ON "HrPayrollPaymentAllocation"("runId", "idempotencyKey");
CREATE INDEX "HrPayrollPaymentAllocation_lineId_idx" ON "HrPayrollPaymentAllocation"("lineId");
CREATE INDEX "HrPayrollPaymentAllocation_paymentId_idx" ON "HrPayrollPaymentAllocation"("paymentId");
ALTER TABLE "HrPayrollPaymentAllocation" ADD CONSTRAINT "HrPayrollPaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "HrPayrollPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HrPayrollPaymentAllocation" ADD CONSTRAINT "HrPayrollPaymentAllocation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "HrPayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HrPayrollPaymentAllocation" ADD CONSTRAINT "HrPayrollPaymentAllocation_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "HrPayrollLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HrPayrollPaymentAllocation" ADD CONSTRAINT "HrPayrollPaymentAllocation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HrPayrollPaymentAllocation" ADD CONSTRAINT "HrPayrollPaymentAllocation_importId_fkey" FOREIGN KEY ("importId") REFERENCES "HrPayrollBankImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HrPayrollPaymentReturn" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "allocationId" TEXT,
    "lineId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "bankReference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "returnedOn" DATE NOT NULL,
    "importId" TEXT,
    "idempotencyKey" TEXT,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HrPayrollPaymentReturn_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HrPayrollPaymentReturn_amount" CHECK ("amount" > 0),
    CONSTRAINT "HrPayrollPaymentReturn_kind" CHECK ("kind" IN ('RETURNED', 'REJECTED')),
    CONSTRAINT "HrPayrollPaymentReturn_allocation" CHECK (("kind" = 'RETURNED') = ("allocationId" IS NOT NULL)),
    CONSTRAINT "HrPayrollPaymentReturn_reference" CHECK (length(btrim("bankReference")) >= 3),
    CONSTRAINT "HrPayrollPaymentReturn_reason" CHECK (length(btrim("reason")) >= 3)
);
CREATE UNIQUE INDEX "HrPayrollPaymentReturn_allocationId_key" ON "HrPayrollPaymentReturn"("allocationId");
CREATE UNIQUE INDEX "HrPayrollPaymentReturn_bankReference_key" ON "HrPayrollPaymentReturn"(lower(btrim("bankReference")));
CREATE UNIQUE INDEX "HrPayrollPaymentReturn_runId_idempotencyKey_key" ON "HrPayrollPaymentReturn"("runId", "idempotencyKey");
CREATE INDEX "HrPayrollPaymentReturn_lineId_idx" ON "HrPayrollPaymentReturn"("lineId");
ALTER TABLE "HrPayrollPaymentReturn" ADD CONSTRAINT "HrPayrollPaymentReturn_runId_fkey" FOREIGN KEY ("runId") REFERENCES "HrPayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HrPayrollPaymentReturn" ADD CONSTRAINT "HrPayrollPaymentReturn_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "HrPayrollPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HrPayrollPaymentReturn" ADD CONSTRAINT "HrPayrollPaymentReturn_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "HrPayrollPaymentAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HrPayrollPaymentReturn" ADD CONSTRAINT "HrPayrollPaymentReturn_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "HrPayrollLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HrPayrollPaymentReturn" ADD CONSTRAINT "HrPayrollPaymentReturn_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HrPayrollPaymentReturn" ADD CONSTRAINT "HrPayrollPaymentReturn_importId_fkey" FOREIGN KEY ("importId") REFERENCES "HrPayrollBankImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 2 · settled amount of a line: allocated − returned ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION hr_payroll_line_settled(p_line text) RETURNS numeric AS $$
  SELECT COALESCE((SELECT sum("amount") FROM "HrPayrollPaymentAllocation" WHERE "lineId" = p_line), 0)
       - COALESCE((SELECT sum("amount") FROM "HrPayrollPaymentReturn" WHERE "lineId" = p_line AND "kind" = 'RETURNED'), 0);
$$ LANGUAGE sql STABLE;

-- What a payment has been accounted for: allocated to lines + rejected by the bank.
CREATE OR REPLACE FUNCTION hr_payroll_payment_accounted(p_payment text) RETURNS numeric AS $$
  SELECT COALESCE((SELECT sum("amount") FROM "HrPayrollPaymentAllocation" WHERE "paymentId" = p_payment), 0)
       + COALESCE((SELECT sum("amount") FROM "HrPayrollPaymentReturn" WHERE "paymentId" = p_payment AND "kind" = 'REJECTED'), 0);
$$ LANGUAGE sql STABLE;

-- ── 3 · allocation guard: append-only; within the payment and within the line's net ───────────
CREATE OR REPLACE FUNCTION hr_payroll_allocation_guard() RETURNS trigger AS $$
DECLARE pay RECORD; ln RECORD; run_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'HR: a payment allocation (proof of an employee''s credit) is never changed or deleted; record a return instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Lock order: run row, then the payment row (the same order as every payment write).
  SELECT "status" INTO run_status FROM "HrPayrollRun" WHERE "id" = NEW."runId" FOR UPDATE;
  IF run_status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'HR: payment proof is recorded against an APPROVED payroll run only (this run is %)', run_status USING ERRCODE = 'check_violation';
  END IF;
  SELECT "runId", "amount", "lineId" INTO pay FROM "HrPayrollPayment" WHERE "id" = NEW."paymentId" FOR UPDATE;
  IF NOT FOUND OR pay."runId" <> NEW."runId" THEN
    RAISE EXCEPTION 'HR: an allocation names a payment of the same run' USING ERRCODE = 'check_violation';
  END IF;
  IF pay."lineId" IS NOT NULL AND pay."lineId" <> NEW."lineId" THEN
    RAISE EXCEPTION 'HR: a payment to one employee line is allocated to that line only' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "runId", "employeeId", "net" INTO ln FROM "HrPayrollLine" WHERE "id" = NEW."lineId";
  IF NOT FOUND OR ln."runId" <> NEW."runId" OR ln."employeeId" <> NEW."employeeId" THEN
    RAISE EXCEPTION 'HR: an allocation names a line of the same run and that line''s employee' USING ERRCODE = 'check_violation';
  END IF;
  IF hr_payroll_payment_accounted(NEW."paymentId") + NEW."amount" > pay."amount" THEN
    RAISE EXCEPTION 'HR: the allocations of a payment never exceed the payment' USING ERRCODE = 'check_violation';
  END IF;
  IF hr_payroll_line_settled(NEW."lineId") + NEW."amount" > ln."net" THEN
    RAISE EXCEPTION 'HR: an employee line is never credited more than its net' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrPayrollPaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_allocation_guard();

-- ── 4 · return guard: append-only; a return matches what it returns ────────────────────────────
CREATE OR REPLACE FUNCTION hr_payroll_return_guard() RETURNS trigger AS $$
DECLARE pay RECORD; al RECORD; ln RECORD; run_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'HR: a payment return is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT "status" INTO run_status FROM "HrPayrollRun" WHERE "id" = NEW."runId" FOR UPDATE;
  IF run_status IS NULL OR run_status NOT IN ('APPROVED', 'PAID') THEN
    RAISE EXCEPTION 'HR: a payment return is recorded against an APPROVED or PAID run only' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "runId", "amount" INTO pay FROM "HrPayrollPayment" WHERE "id" = NEW."paymentId" FOR UPDATE;
  IF NOT FOUND OR pay."runId" <> NEW."runId" THEN
    RAISE EXCEPTION 'HR: a return names a payment of the same run' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "runId", "employeeId" INTO ln FROM "HrPayrollLine" WHERE "id" = NEW."lineId";
  IF NOT FOUND OR ln."runId" <> NEW."runId" OR ln."employeeId" <> NEW."employeeId" THEN
    RAISE EXCEPTION 'HR: a return names a line of the same run and that line''s employee' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'RETURNED' THEN
    SELECT "paymentId", "lineId", "amount" INTO al FROM "HrPayrollPaymentAllocation" WHERE "id" = NEW."allocationId";
    IF NOT FOUND OR al."paymentId" <> NEW."paymentId" OR al."lineId" <> NEW."lineId" OR al."amount" <> NEW."amount" THEN
      RAISE EXCEPTION 'HR: a returned credit is the whole allocation it returns (same payment, line and amount)' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF hr_payroll_payment_accounted(NEW."paymentId") + NEW."amount" > pay."amount" THEN
      RAISE EXCEPTION 'HR: a rejected part of a payment never exceeds what is still unaccounted for' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_return_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrPayrollPaymentReturn"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_return_guard();

CREATE OR REPLACE FUNCTION hr_payroll_bank_import_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'HR: an imported bank result file is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "HrPayrollPayment" WHERE "id" = NEW."paymentId" AND "runId" = NEW."runId") THEN
    RAISE EXCEPTION 'HR: a bank result file names a payment of the same run' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_bank_import_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrPayrollBankImport"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_bank_import_guard();

-- ── 5 · payment guard (replaces 20261017090000): net of returns; per-line cap net of what was credited ──
CREATE OR REPLACE FUNCTION hr_payroll_payment_guard() RETURNS trigger AS $$
DECLARE r RECORD; paid numeric; returned numeric; line_net numeric; line_run text;
BEGIN
  SELECT "status", "totalNet" INTO r FROM "HrPayrollRun" WHERE "id" = NEW."runId" FOR UPDATE;
  IF NOT FOUND OR r."status" <> 'APPROVED' THEN
    RAISE EXCEPTION 'HR: a payment is recorded against an APPROVED payroll run only' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum("amount"), 0) INTO paid FROM "HrPayrollPayment" WHERE "runId" = NEW."runId";
  SELECT COALESCE(sum("amount"), 0) INTO returned FROM "HrPayrollPaymentReturn" WHERE "runId" = NEW."runId";
  IF paid - returned + NEW."amount" > r."totalNet" THEN
    RAISE EXCEPTION 'HR: the payments of a payroll run, net of returns, never exceed its net' USING ERRCODE = 'check_violation';
  END IF;
  -- Paid per line or as a whole, never both — except that a line a return or rejection reopened is
  -- paid again by its own per-line payment.
  IF NEW."lineId" IS NULL AND EXISTS (SELECT 1 FROM "HrPayrollPayment" WHERE "runId" = NEW."runId" AND "lineId" IS NOT NULL) THEN
    RAISE EXCEPTION 'HR: a payroll run is paid either per line or as a whole, never both' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lineId" IS NOT NULL AND EXISTS (SELECT 1 FROM "HrPayrollPayment" WHERE "runId" = NEW."runId" AND "lineId" IS NULL)
     AND NOT EXISTS (SELECT 1 FROM "HrPayrollPaymentReturn" WHERE "lineId" = NEW."lineId") THEN
    RAISE EXCEPTION 'HR: a payroll run is paid either per line or as a whole, never both (a per-line payment after a whole-run one is for a line reopened by a return)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lineId" IS NOT NULL THEN
    SELECT "runId", "net" INTO line_run, line_net FROM "HrPayrollLine" WHERE "id" = NEW."lineId";
    IF line_run IS DISTINCT FROM NEW."runId" THEN
      RAISE EXCEPTION 'HR: a line payment names a line of the same run' USING ERRCODE = 'check_violation';
    END IF;
    IF hr_payroll_line_settled(NEW."lineId") + NEW."amount" > line_net THEN
      RAISE EXCEPTION 'HR: the payments of a payslip line never exceed its net' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "HrJournalLink" WHERE "sourceType" = 'PAYROLL_RUN' AND "sourceId" = NEW."runId" AND "purpose" = 'ACCRUAL') THEN
    RAISE EXCEPTION 'HR: no payment is recorded without the run''s posted accrual journal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 6 · run controls (replaces 20261017090000): PAID needs every line settled with proof ────────
CREATE OR REPLACE FUNCTION hr_payroll_run_controls_guard() RETURNS trigger AS $$
DECLARE paid numeric; returned numeric; unbooked int; proposal boolean; unsettled int; unaccounted int;
BEGIN
  IF OLD."status" IN ('APPROVED', 'PAID') AND (
       NEW."totalGross" <> OLD."totalGross" OR NEW."totalDeductions" <> OLD."totalDeductions" OR NEW."totalNet" <> OLD."totalNet"
    OR NEW."totalEmployer" <> OLD."totalEmployer" OR NEW."policyId" <> OLD."policyId" OR NEW."accountingSkipped" <> OLD."accountingSkipped"
    OR NEW."periodMonth" <> OLD."periodMonth" OR NEW."periodStart" <> OLD."periodStart" OR NEW."periodEnd" <> OLD."periodEnd"
    OR NEW."kind" <> OLD."kind" OR NEW."branchKey" <> OLD."branchKey" OR NEW."correctsRunId" IS DISTINCT FROM OLD."correctsRunId"
    OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" OR NEW."preparedBy" <> OLD."preparedBy" OR NEW."submittedBy" IS DISTINCT FROM OLD."submittedBy") THEN
    RAISE EXCEPTION 'HR: the approved figures of a payroll run never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'APPROVED' AND OLD."status" NOT IN ('APPROVED', 'PAID') THEN
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
    SELECT COALESCE(sum("amount"), 0) INTO returned FROM "HrPayrollPaymentReturn" WHERE "runId" = NEW."id";
    IF paid - returned <> NEW."totalNet" THEN
      RAISE EXCEPTION 'HR: a payroll run is PAID only when its payments, net of returns, equal its net' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO unsettled FROM "HrPayrollLine" l WHERE l."runId" = NEW."id" AND hr_payroll_line_settled(l."id") <> l."net";
    IF unsettled > 0 THEN
      RAISE EXCEPTION 'HR: a payroll run is PAID only when every employee line is credited its net with proof (% line(s) not settled)', unsettled USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO unaccounted FROM "HrPayrollPayment" p WHERE p."runId" = NEW."id" AND hr_payroll_payment_accounted(p."id") <> p."amount";
    IF unaccounted > 0 THEN
      RAISE EXCEPTION 'HR: a payroll run is PAID only when every payment is allocated to employee lines (% payment(s) not fully allocated)', unaccounted USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO unbooked FROM "HrPayrollPayment" p WHERE p."runId" = NEW."id"
      AND NOT EXISTS (SELECT 1 FROM "HrJournalLink" l WHERE l."sourceType" = 'PAYROLL_RUN' AND l."sourceId" = NEW."id" AND l."purpose" = 'PAYMENT:' || p."id");
    IF unbooked > 0 THEN
      RAISE EXCEPTION 'HR: a payroll run is PAID only when every payment has its posted journal' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO unbooked FROM "HrPayrollPaymentReturn" x WHERE x."runId" = NEW."id"
      AND NOT EXISTS (SELECT 1 FROM "HrJournalLink" l WHERE l."sourceType" = 'PAYROLL_RUN' AND l."sourceId" = NEW."id" AND l."purpose" = 'RETURN:' || x."id");
    IF unbooked > 0 THEN
      RAISE EXCEPTION 'HR: a payroll run is PAID only when every payment return has its posted journal' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 7 · native run lifecycle (replaces 20261008120000): one added transition ─────────────────────
-- PAID → APPROVED, and nothing else changing but "paidAt", only when a recorded return left an
-- employee line of the run short of its net. Every other rule is the original's, unchanged.
CREATE OR REPLACE FUNCTION hr_payroll_run_guard() RETURNS trigger AS $$
DECLARE n_pending int; n_blocking int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: payroll runs are cancelled, never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'HR: a payroll run starts as DRAFT' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'PAID' AND NEW."status" = 'APPROVED'
     AND (to_jsonb(NEW) - ARRAY['status', 'paidAt']) = (to_jsonb(OLD) - ARRAY['status', 'paidAt'])
     AND EXISTS (SELECT 1 FROM "HrPayrollPaymentReturn" x WHERE x."runId" = NEW."id")
     AND EXISTS (SELECT 1 FROM "HrPayrollLine" l WHERE l."runId" = NEW."id" AND hr_payroll_line_settled(l."id") < l."net") THEN
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('PAID', 'CANCELLED') THEN
    RAISE EXCEPTION 'HR: a % payroll run cannot change', OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'APPROVED' AND NEW."status" = 'APPROVED' AND (
       NEW."totalGross" <> OLD."totalGross" OR NEW."totalNet" <> OLD."totalNet"
       OR NEW."totalDeductions" <> OLD."totalDeductions" OR NEW."policyId" <> OLD."policyId") THEN
    RAISE EXCEPTION 'HR: an approved payroll run is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('REVIEW', 'CANCELLED'))
    OR (OLD."status" = 'REVIEW' AND NEW."status" IN ('DRAFT', 'APPROVED', 'CANCELLED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('PAID', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'HR: payroll run cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'APPROVED' AND OLD."status" <> 'APPROVED' THEN
    SELECT count(*) FILTER (WHERE "approvedBy" IS NULL), count(*) FILTER (WHERE "blocking")
      INTO n_pending, n_blocking FROM "HrPayrollLine" WHERE "runId" = NEW."id";
    IF n_pending > 0 OR n_blocking > 0 THEN
      RAISE EXCEPTION 'HR: % lines unapproved, % blocking — the run cannot be approved', n_pending, n_blocking
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
