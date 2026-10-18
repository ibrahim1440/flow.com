-- P-2 freeze follow-up (round-6 P3-1): a payslip line never moves to another run, and a payslip
-- item never moves to another line.
-- Engineering CONTROL only: no compensation formula, rate or policy value.
--
-- The freeze guards (native HR for APPROVED / PAID / CANCELLED runs; 20261017140000 for REVIEW
-- runs) read the parent of the row as it will be AFTER the change. An UPDATE that changes
-- "runId" / "lineId" could therefore carry a row out of a frozen run into a DRAFT one. No
-- application path ever changes either column (lines are deleted and rebuilt in DRAFT, items with
-- them), so the change is refused outright — the same rule the adjustment guard already applies
-- to "runId" (20261017140000).
--
-- ADDITIVE: two functions and two triggers. No table, column or existing trigger is changed, no row
-- is touched. Atomic: one transaction.
--
-- Rollback: docs/hr/migration-review/rollback-20261017145000_hr_payroll_freeze_move_guard.sql
BEGIN;

CREATE OR REPLACE FUNCTION hr_payroll_line_move_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."runId" IS DISTINCT FROM OLD."runId" THEN
    RAISE EXCEPTION 'HR: a payslip line never moves to another payroll run' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_line_move_guard BEFORE UPDATE ON "HrPayrollLine"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_line_move_guard();

CREATE OR REPLACE FUNCTION hr_payroll_item_move_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."lineId" IS DISTINCT FROM OLD."lineId" THEN
    RAISE EXCEPTION 'HR: a payslip item never moves to another payslip line' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_item_move_guard BEFORE UPDATE ON "HrPayrollItem"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_item_move_guard();

COMMIT;
