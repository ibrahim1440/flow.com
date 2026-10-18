-- P-2 rev3 independent review (rev8) — two database controls. Engineering CONTROL only: no pay value,
-- rate, account or policy value.
--
-- 1 · Separation status (review P3, item 5). The separation-earning scope now ENDS when a separation is
--     cancelled, so its status is guarded the way a final settlement's is: a status edit made outside
--     the service is refused. Allowed transitions only:
--       INITIATED → COMPLETED  (completedBy / completedAt recorded);
--       INITIATED → CANCELLED  (cancelledBy / cancelledAt recorded; no final settlement other than
--                               CANCELLED; and, when the separation has any settlement record, an
--                               APPLIED independent attestation PAYROLL_CONTROL_ATTEST / SEPARATION_CANCEL
--                               for it, decided by a person other than the one cancelling).
--     A COMPLETED or CANCELLED separation never changes status again; its person and its last working
--     day (which decide the relationship and a rehire) never change; a separation is never deleted.
--     (The attestation's digest and same-person checks stay in the service: workforce.cancelSeparation.)
--
-- 2 · Provision shortfall decisions (review P3, item 4). A settlement returned to draft and
--     recalculated after its shortfall was approved could not get a new decision (the live unique
--     index held the old one). An APPROVED decision may now LAPSE — status only, everything else as
--     decided — while its settlement is not posted (no USAGE row for it). Lapsing only makes posting
--     stricter: posting still needs an APPROVED decision for exactly the current shortfall.
--
-- Note: migration 20261017190000's header says the prior-period dues categories are not counted
-- towards the end-of-service match; that was changed in the application by this same review
-- (P2-a): they COUNT while the route for legitimate dues (D-7i-5) is undecided. No schema change.
--
-- ADDITIVE: one function + trigger (new); the shortfall status CHECK widened to a superset; one
-- guard function replaced by a superset. No existing row is changed. Atomic.
--
-- Rollback: docs/hr/migration-review/rollback-20261017200000_hr_p2_rev3_review_fixes.sql
BEGIN;

CREATE OR REPLACE FUNCTION hr_separation_guard() RETURNS trigger AS $$
DECLARE live text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: a separation is never deleted (cancel it instead)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."employeeId" <> OLD."employeeId" OR NEW."lastWorkingDay" <> OLD."lastWorkingDay" THEN
    RAISE EXCEPTION 'HR: a separation''s person and last working day never change' USING ERRCODE = 'integrity_constraint_violation';
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
                          AND "decidedBy" IS NOT NULL AND "decidedBy" <> NEW."cancelledBy") THEN
      RAISE EXCEPTION 'HR: this separation has final-settlement records, so cancelling it needs an applied independent attestation (PAYROLL_CONTROL_ATTEST / SEPARATION_CANCEL) from another person' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HR: a separation goes from INITIATED to COMPLETED or CANCELLED only (not %)', NEW."status" USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_separation_guard BEFORE UPDATE OR DELETE ON "HrSeparation"
  FOR EACH ROW EXECUTE FUNCTION hr_separation_guard();

ALTER TABLE "HrProvisionShortfall" DROP CONSTRAINT "HrProvisionShortfall_status";
ALTER TABLE "HrProvisionShortfall" ADD CONSTRAINT "HrProvisionShortfall_status" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'LAPSED'));

CREATE OR REPLACE FUNCTION hr_provision_shortfall_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: a provision shortfall decision is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- An approved decision lapses (status only) while its settlement has not used the provision.
  IF TG_OP = 'UPDATE' AND OLD."status" = 'APPROVED' AND NEW."status" = 'LAPSED'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    IF EXISTS (SELECT 1 FROM "HrProvisionLedger" WHERE "kind" = 'USAGE' AND "sourceType" = 'FINAL_SETTLEMENT' AND "sourceId" = NEW."settlementId") THEN
      RAISE EXCEPTION 'HR: the settlement was posted on this shortfall decision, so it never lapses' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD."status" <> 'PENDING' OR NEW."status" = 'LAPSED'
     OR (to_jsonb(NEW) - ARRAY['status', 'decidedBy', 'decidedAt', 'decisionNote']) <> (to_jsonb(OLD) - ARRAY['status', 'decidedBy', 'decidedAt', 'decisionNote'])) THEN
    RAISE EXCEPTION 'HR: a provision shortfall decision is decided once and never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."status" = 'LAPSED' THEN
    RAISE EXCEPTION 'HR: a provision shortfall decision is never created lapsed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
