-- P-2 rev3 item 5 (D-7i): the separation-earning control is tied to the employment relationship and
-- its settlement (application: final-settlement.ts separationEarningContext), and legitimate dues
-- earned BEFORE the separation have their own path.
-- Engineering CONTROL only: no pay value, rate or category amount.
--
-- Two EARNING categories are added to the closed list of payroll adjustment categories:
--   · PRIOR_PERIOD_ARREARS — pay owed for an earlier period of the relationship;
--   · COMMISSION_TRUE_UP — a commission true-up for an earlier period.
-- Each needs a document reference and the related period (YYYY-MM); for a person whose separation
-- is in scope the period must be before the separation, and an independent attestation is still
-- required (no general override). These amounts are not counted towards the end-of-service match.
--
-- ADDITIVE: two nullable columns; the category CHECK widened to a superset of its values; one CHECK
-- added. No existing row is changed. Atomic.
--
-- Rollback: docs/hr/migration-review/rollback-20261017190000_hr_separation_scope.sql
BEGIN;

ALTER TABLE "HrPayrollAdjustment" ADD COLUMN "documentReference" TEXT, ADD COLUMN "relatedPeriod" TEXT;

ALTER TABLE "HrPayrollAdjustment" DROP CONSTRAINT "HrPayrollAdjustment_category";
ALTER TABLE "HrPayrollAdjustment" ADD CONSTRAINT "HrPayrollAdjustment_category" CHECK (
     ("kind" = 'EARNING' AND "category" IN ('OVERTIME_CORRECTION','ALLOWANCE_CORRECTION','SALARY_ARREARS','APPROVED_BONUS','OTHER_WITH_MEMO','PRIOR_PERIOD_ARREARS','COMMISSION_TRUE_UP'))
  OR ("kind" = 'DEDUCTION' AND "category" IN ('CONSENTED_DEDUCTION','COURT_ORDER_DEDUCTION','DAMAGE_DEDUCTION','OTHER_WITH_MEMO')));

-- The prior-period categories carry their evidence; no other category carries it.
ALTER TABLE "HrPayrollAdjustment" ADD CONSTRAINT "HrPayrollAdjustment_dues_evidence" CHECK (
  ("category" IN ('PRIOR_PERIOD_ARREARS','COMMISSION_TRUE_UP'))
    = ("documentReference" IS NOT NULL AND length(btrim("documentReference")) >= 3 AND "relatedPeriod" IS NOT NULL AND "relatedPeriod" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
  AND ("category" IN ('PRIOR_PERIOD_ARREARS','COMMISSION_TRUE_UP') OR ("documentReference" IS NULL AND "relatedPeriod" IS NULL)));

COMMIT;
