-- P-2 round-5 F1: a payroll run is frozen once it is submitted (database backstop).
-- Engineering CONTROL only: no compensation formula, rate or policy value.
--
-- The service already locks month → people → run row and re-reads the status before changing a
-- run (payroll.ts lockRunForChange). These guards make the same rule hold for any writer:
--   · HrPayrollAdjustment: INSERT, UPDATE and DELETE only while the run is DRAFT;
--   · HrPayrollLine while the run is in REVIEW: no INSERT or DELETE; an UPDATE may change only the
--     approval stamp ("approvedBy", "approvedAt") — what approval writes, and what return to draft
--     clears — and nothing else;
--   · HrPayrollItem while the run is in REVIEW: no INSERT, UPDATE or DELETE.
-- (APPROVED, PAID and CANCELLED runs were already frozen by the native-HR line / item guards.)
--
-- ADDITIVE: three functions and three triggers. No table, column or existing trigger is changed,
-- no row is touched, and nothing is validated against existing rows (rows written to a REVIEW run
-- before this migration stay as they are). Atomic: one transaction.
--
-- Rollback: docs/hr/migration-review/rollback-20261017140000_hr_payroll_review_freeze.sql
BEGIN;

CREATE OR REPLACE FUNCTION hr_payroll_adjustment_draft_guard() RETURNS trigger AS $$
DECLARE run_status text;
BEGIN
  SELECT "status" INTO run_status FROM "HrPayrollRun" WHERE "id" = COALESCE(NEW."runId", OLD."runId");
  IF run_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'HR: payroll adjustments change only while the run is DRAFT (this run is %)', run_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."runId" IS DISTINCT FROM OLD."runId" THEN
    RAISE EXCEPTION 'HR: a payroll adjustment never moves to another run' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_adjustment_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrPayrollAdjustment"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_adjustment_draft_guard();

CREATE OR REPLACE FUNCTION hr_payroll_line_review_guard() RETURNS trigger AS $$
DECLARE run_status text;
BEGIN
  SELECT "status" INTO run_status FROM "HrPayrollRun" WHERE "id" = COALESCE(NEW."runId", OLD."runId");
  IF run_status = 'REVIEW' THEN
    IF TG_OP <> 'UPDATE' THEN
      RAISE EXCEPTION 'HR: payslip lines of a submitted (REVIEW) run are not added or removed; return it to draft first'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['approvedBy', 'approvedAt']) <> (to_jsonb(OLD) - ARRAY['approvedBy', 'approvedAt']) THEN
      RAISE EXCEPTION 'HR: a payslip line of a submitted (REVIEW) run changes only its approval; return it to draft first'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_line_review_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrPayrollLine"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_line_review_guard();

CREATE OR REPLACE FUNCTION hr_payroll_item_review_guard() RETURNS trigger AS $$
DECLARE run_status text;
BEGIN
  SELECT r."status" INTO run_status FROM "HrPayrollLine" l JOIN "HrPayrollRun" r ON r."id" = l."runId"
    WHERE l."id" = COALESCE(NEW."lineId", OLD."lineId");
  IF run_status = 'REVIEW' THEN
    RAISE EXCEPTION 'HR: payslip items of a submitted (REVIEW) run never change; return it to draft first'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_item_review_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrPayrollItem"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_item_review_guard();

COMMIT;
