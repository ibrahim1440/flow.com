-- Finance approvals: no self-approval exception, and no approval-gated state without an
-- approved request decided by someone other than its requester.
--
-- The previous migration let FinSettings."allowSelfApproval" switch four-eyes off. That column
-- was writable by the application role, so the database boundary depended on a setting the
-- application could change. The exception is removed completely: the column and the helper
-- function are dropped and the guards no longer consult any setting or session variable.

-- 1. Guards without an exception -------------------------------------------------------------

CREATE OR REPLACE FUNCTION fin_guard_approval_request() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A request is born undecided; it cannot be inserted already approved or rejected.
    IF NEW."status" <> 'PENDING' OR NEW."decidedBy" IS NOT NULL OR NEW."decidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'An approval request must be created pending and undecided' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An approval request cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'A decided approval request cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IN ('APPROVED', 'REJECTED') THEN
    IF NEW."decidedBy" IS NULL THEN
      RAISE EXCEPTION 'A decision needs the deciding user' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."decidedBy" = NEW."requestedBy" THEN
      RAISE EXCEPTION 'The requester cannot decide their own request' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW."requestedBy" <> OLD."requestedBy" OR NEW."type" <> OLD."type" OR NEW."entityId" <> OLD."entityId"
     OR NEW."requiredSub" <> OLD."requiredSub" OR NEW."assignedToId" IS DISTINCT FROM OLD."assignedToId" THEN
    RAISE EXCEPTION 'The request itself cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "FinApprovalRequest_guard" ON "FinApprovalRequest";
CREATE TRIGGER "FinApprovalRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FinApprovalRequest"
  FOR EACH ROW EXECUTE FUNCTION fin_guard_approval_request();

-- True when an APPROVED request of this type exists for the entity (and, when given, has
-- exactly this id). The request guard above already guarantees decidedBy <> requestedBy.
CREATE OR REPLACE FUNCTION fin_has_approved_request(p_type text, p_entity text, p_request text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "FinApprovalRequest" r
    WHERE r."type"::text = p_type AND r."entityId" = p_entity AND r."status" = 'APPROVED'
      AND r."decidedBy" IS NOT NULL AND r."decidedBy" <> r."requestedBy"
      AND (p_request IS NULL OR r."id" = p_request)
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION fin_guard_revision_approval() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'APPROVED' AND OLD."status" <> 'APPROVED' THEN
    IF NEW."decidedBy" IS NULL OR NEW."decidedBy" = COALESCE(NEW."submittedBy", NEW."createdBy") THEN
      RAISE EXCEPTION 'A budget revision must be approved by someone other than its submitter' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT fin_has_approved_request('BUDGET_APPROVAL', NEW."id", NULL) THEN
      RAISE EXCEPTION 'A budget revision can only be approved through an approved request' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fin_guard_rule_activation() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'ACTIVE' AND OLD."status" <> 'ACTIVE' THEN
    IF NEW."approvedBy" IS NULL OR NEW."approvedBy" = NEW."createdBy" THEN
      RAISE EXCEPTION 'Allocation rules must be approved by someone other than their author' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT fin_has_approved_request('ALLOCATION_RULES', NEW."id", NULL) THEN
      RAISE EXCEPTION 'Allocation rules can only be activated through an approved request' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. States that only an approval may produce -----------------------------------------------

-- A payment request held for a spending override becomes ACTIVE only through its approved request.
CREATE OR REPLACE FUNCTION fin_guard_reservation_override() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'PENDING_APPROVAL' AND NEW."status" = 'ACTIVE'
     AND NOT fin_has_approved_request('SPEND_OVERRIDE', NEW."id", NEW."approvalId") THEN
    RAISE EXCEPTION 'A held payment request can only be released by its approved override request' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentReservation_override_approval" BEFORE UPDATE ON "PaymentReservation"
  FOR EACH ROW EXECUTE FUNCTION fin_guard_reservation_override();

-- Money moves between categories only under an approved transfer request.
CREATE OR REPLACE FUNCTION fin_guard_category_transfer() RETURNS trigger AS $$
BEGIN
  IF NEW."sourceType" = 'CATEGORY_TRANSFER' THEN
    IF NEW."approvalId" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "FinApprovalRequest" r
      WHERE r."id" = NEW."approvalId" AND r."type" = 'CATEGORY_TRANSFER' AND r."status" = 'APPROVED'
        AND r."decidedBy" IS NOT NULL AND r."decidedBy" <> r."requestedBy"
    ) THEN
      RAISE EXCEPTION 'A category transfer needs an approved transfer request' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AllocationEntry_transfer_approval" BEFORE INSERT ON "AllocationEntry"
  FOR EACH ROW EXECUTE FUNCTION fin_guard_category_transfer();

-- A closed period reopens only through an approved reopen request.
CREATE OR REPLACE FUNCTION fin_guard_budget_reopen() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'CLOSED' AND NEW."status" <> 'CLOSED'
     AND NOT fin_has_approved_request('PERIOD_REOPEN', NEW."id", NULL) THEN
    RAISE EXCEPTION 'A closed budget period can only be reopened through an approved request' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinBudget_reopen_approval" BEFORE UPDATE ON "FinBudget"
  FOR EACH ROW EXECUTE FUNCTION fin_guard_budget_reopen();

-- 3. Remove the exception itself ------------------------------------------------------------

DROP FUNCTION fin_self_approval_allowed();
ALTER TABLE "FinSettings" DROP COLUMN "allowSelfApproval";
