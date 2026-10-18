-- P-2 rev3 independent review (rev9 P3) — the separation status guard of 20261017200000, tightened.
-- Engineering CONTROL only: no pay value, rate, account or policy value.
--
-- hr_separation_guard is replaced by a superset:
--   · noticeDate and createdAt never change: they open the separation-earning cumulative window
--     (final-settlement.ts separationEarningContext) — moving them would drop earnings from it;
--   · eosAmount is recorded once (NULL → a value) and then never changes: it is an amount on record
--     the end-of-service match compares with (the application refuses the same: EOS_AMOUNT_RECORDED);
--   · a cancellation with settlement records needs an APPLIED independent SEPARATION_CANCEL
--     attestation REQUESTED by the person cancelling (cancelledBy) and decided by another person —
--     not merely any applied attestation from someone else.
-- Everything 20261017200000 refused is still refused.
--
-- ADDITIVE: one function replaced (CREATE OR REPLACE FUNCTION takes no table lock); the trigger is
-- unchanged. No existing row is changed. Atomic.
--
-- Rollback: docs/hr/migration-review/rollback-20261017210000_hr_separation_guard_tighten.sql
BEGIN;

CREATE OR REPLACE FUNCTION hr_separation_guard() RETURNS trigger AS $$
DECLARE live text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: a separation is never deleted (cancel it instead)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."employeeId" <> OLD."employeeId" OR NEW."lastWorkingDay" <> OLD."lastWorkingDay"
     OR NEW."noticeDate" <> OLD."noticeDate" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'HR: a separation''s person, notice date, last working day and creation time never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."eosAmount" IS NOT NULL AND NEW."eosAmount" IS DISTINCT FROM OLD."eosAmount" THEN
    RAISE EXCEPTION 'HR: the end-of-service amount on a separation is recorded once and never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'INITIATED' THEN
    RAISE EXCEPTION 'HR: a % separation never changes status', OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    IF NEW."completedBy" IS NULL OR NEW."completedAt" IS NULL THEN
      RAISE EXCEPTION 'HR: a completed separation records who completed it and when' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'CANCELLED' THEN
    IF NEW."cancelledBy" IS NULL OR NEW."cancelledAt" IS NULL THEN
      RAISE EXCEPTION 'HR: a cancelled separation records who cancelled it and when' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT string_agg("settlementNo" || ' ' || "status", ', ') INTO live FROM "HrFinalSettlement"
     WHERE "separationId" = NEW."id" AND "status" <> 'CANCELLED';
    IF live IS NOT NULL THEN
      RAISE EXCEPTION 'HR: this separation has a final settlement in progress (%); cancel the settlement first', live USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "HrFinalSettlement" WHERE "separationId" = NEW."id")
       AND NOT EXISTS (SELECT 1 FROM "HrConfigChange"
                        WHERE "kind"::text = 'PAYROLL_CONTROL_ATTEST' AND "status"::text = 'APPLIED'
                          AND "targetKey" = 'PAYROLL_ATTEST:SEPARATION_CANCEL:' || NEW."id"
                          AND "requestedBy" = NEW."cancelledBy"
                          AND "decidedBy" IS NOT NULL AND "decidedBy" <> NEW."cancelledBy") THEN
      RAISE EXCEPTION 'HR: this separation has final-settlement records, so cancelling it needs an applied independent attestation (PAYROLL_CONTROL_ATTEST / SEPARATION_CANCEL) requested by the person cancelling and decided by another person' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HR: a separation goes from INITIATED to COMPLETED or CANCELLED only (not %)', NEW."status" USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

COMMIT;
