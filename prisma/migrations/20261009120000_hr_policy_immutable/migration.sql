-- Native HR: an approved payroll policy version never changes.
--
-- Affects two tables, nothing else: "HrPayrollPolicy" (UPDATE, DELETE) and "HrContributionRule"
-- (INSERT, UPDATE, DELETE). No data is changed by this migration; no backfill is needed.
--
-- A DRAFT version may be edited (by its drafter; enforced in the service) and activated by
-- another policy manager. Once ACTIVE or RETIRED, the only change allowed is ACTIVE → RETIRED
-- (a later activation on the same date retires it); nothing else on the row may change, and
-- non-draft versions are never deleted. Their contribution rules are frozen with them.
-- Runs keep the version they were calculated with.
CREATE OR REPLACE FUNCTION hr_policy_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'HR: an approved payroll policy version is never deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    IF NOT (OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED')
       OR (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'HR: an approved payroll policy version never changes; draft a new version instead'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER hr_policy_guard BEFORE UPDATE OR DELETE ON "HrPayrollPolicy"
  FOR EACH ROW EXECUTE FUNCTION hr_policy_guard();

-- Contribution rules belong to their version: they may change only while it is a DRAFT. The
-- parent row is read FOR SHARE, so a rule written while an activation is committing waits for
-- it and then sees the version as ACTIVE (and is refused) instead of slipping in.
CREATE OR REPLACE FUNCTION hr_contribution_rule_guard() RETURNS trigger AS $$
DECLARE
  s "HrPolicyStatus";
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "status" INTO s FROM "HrPayrollPolicy" WHERE "id" = OLD."policyId" FOR SHARE;
    -- s IS NULL only while the parent itself is being deleted (the FK cascade), which
    -- hr_policy_guard already allows for a DRAFT alone.
    IF s IS NOT NULL AND s <> 'DRAFT' THEN
      RAISE EXCEPTION 'HR: contribution rules of an approved payroll policy version never change'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT "status" INTO s FROM "HrPayrollPolicy" WHERE "id" = NEW."policyId" FOR SHARE;
    IF s IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'HR: contribution rules of an approved payroll policy version never change'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER hr_contribution_rule_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrContributionRule"
  FOR EACH ROW EXECUTE FUNCTION hr_contribution_rule_guard();
