-- AlterTable
ALTER TABLE "BankImportBatch" ADD COLUMN     "attachedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "statementBatchId" TEXT,
ADD COLUMN     "statementConfirmedAt" TIMESTAMP(3);

-- ─── Separation of duties, enforced by the database ─────────────────────────────────
-- The service layer already refuses these; the triggers make them hold for any client that
-- connects with the application role, including a bug or a hand-written SQL session.
-- Self-approval is refused unless FinSettings.allowSelfApproval is true.

CREATE OR REPLACE FUNCTION fin_self_approval_allowed() RETURNS boolean AS $$
  SELECT COALESCE((SELECT "allowSelfApproval" FROM "FinSettings" WHERE "id" = 'singleton'), false);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION fin_guard_approval_request() RETURNS trigger AS $$
BEGIN
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
    IF NEW."decidedBy" = NEW."requestedBy" AND NOT fin_self_approval_allowed() THEN
      RAISE EXCEPTION 'The requester cannot decide their own request' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW."requestedBy" <> OLD."requestedBy" OR NEW."type" <> OLD."type" OR NEW."entityId" <> OLD."entityId" THEN
    RAISE EXCEPTION 'The request itself cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinApprovalRequest_guard" BEFORE UPDATE OR DELETE ON "FinApprovalRequest"
  FOR EACH ROW EXECUTE FUNCTION fin_guard_approval_request();

CREATE OR REPLACE FUNCTION fin_guard_revision_approval() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'APPROVED' AND OLD."status" <> 'APPROVED' THEN
    IF NEW."decidedBy" IS NULL OR (NEW."decidedBy" = COALESCE(NEW."submittedBy", NEW."createdBy") AND NOT fin_self_approval_allowed()) THEN
      RAISE EXCEPTION 'A budget revision must be approved by someone other than its submitter' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BudgetRevision_four_eyes" BEFORE UPDATE ON "BudgetRevision"
  FOR EACH ROW EXECUTE FUNCTION fin_guard_revision_approval();

CREATE OR REPLACE FUNCTION fin_guard_rule_activation() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'ACTIVE' AND OLD."status" <> 'ACTIVE' THEN
    IF NEW."approvedBy" IS NULL OR (NEW."approvedBy" = NEW."createdBy" AND NOT fin_self_approval_allowed()) THEN
      RAISE EXCEPTION 'Allocation rules must be approved by someone other than their author' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AllocationRuleVersion_four_eyes" BEFORE UPDATE ON "AllocationRuleVersion"
  FOR EACH ROW EXECUTE FUNCTION fin_guard_rule_activation();
