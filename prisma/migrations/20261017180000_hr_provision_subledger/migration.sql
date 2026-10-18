-- P-2 rev3 item 4 (D-7g): a per-employee liability subledger for the EOS and leave provisions.
-- Engineering CONTROL only: no measurement (statutory or actuarial), no amount, no account mapping.
--
-- Until now a final settlement could draw on the provision up to the AGGREGATE ledger balance of
-- the mapped EOS_PROVISION / LEAVE_PROVISION account, so one employee's settlement could use
-- provision recognised for others. HrProvisionLedger attributes the provision per employee:
--   · RECOGNITION — part of a POSTED journal's credit to the mapped provision account, attributed to
--     one employee (never more, in total, than that journal credited the account); requested by one
--     person, APPROVED by another;
--   · ADJUSTMENT — a ± correction with a reason; requested by one person, APPROVED by another;
--   · USAGE — written when a final settlement is posted: what it took from THIS employee's
--     provision (one per settlement and provision, never twice);
-- An employee's balance (Σ APPROVED rows) never goes below zero: a settlement uses at most that
-- employee's own attributed provision, whatever the aggregate (checked under a per-employee lock,
-- in the database too). The subledger is reconciled to the GL in a report; differences are
-- reported, never corrected.
-- HrProvisionShortfall: when a settlement is due more than the provision it uses, the shortfall is
-- NOT expensed automatically. It blocks posting until a second person records the accountant's
-- decision for exactly that amount (D-7g, open: strict default = blocked).
--
-- ADDITIVE: two tables, three functions, two triggers. No existing row or object is changed. Atomic.
--
-- Rollback: docs/hr/migration-review/rollback-20261017180000_hr_provision_subledger.sql
BEGIN;

CREATE TABLE "HrProvisionLedger" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "provisionKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "journalEntryId" TEXT,
    "reference" TEXT NOT NULL,
    "reason" TEXT,
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HrProvisionLedger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HrProvisionLedger_key" CHECK ("provisionKey" IN ('EOS_PROVISION', 'LEAVE_PROVISION')),
    CONSTRAINT "HrProvisionLedger_kind" CHECK ("kind" IN ('RECOGNITION', 'ADJUSTMENT', 'USAGE')),
    CONSTRAINT "HrProvisionLedger_status" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')),
    CONSTRAINT "HrProvisionLedger_reference" CHECK (length(btrim("reference")) >= 3),
    CONSTRAINT "HrProvisionLedger_amount" CHECK ("amount" <> 0
      AND ("kind" <> 'RECOGNITION' OR "amount" > 0)
      AND ("kind" <> 'USAGE' OR "amount" < 0)),
    CONSTRAINT "HrProvisionLedger_source" CHECK (
          ("kind" = 'RECOGNITION' AND "sourceType" = 'JOURNAL' AND "journalEntryId" IS NOT NULL)
       OR ("kind" = 'ADJUSTMENT' AND "sourceType" = 'MANUAL' AND "reason" IS NOT NULL AND length(btrim("reason")) >= 5)
       OR ("kind" = 'USAGE' AND "sourceType" = 'FINAL_SETTLEMENT' AND "sourceId" IS NOT NULL AND "journalEntryId" IS NOT NULL AND "status" = 'APPROVED')),
    -- Attributions and adjustments are decided by a SECOND person.
    CONSTRAINT "HrProvisionLedger_four_eyes" CHECK ("kind" = 'USAGE' OR "status" = 'PENDING'
      OR ("approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedBy" <> "requestedBy"))
);
CREATE INDEX "HrProvisionLedger_employee_key_idx" ON "HrProvisionLedger"("employeeId", "provisionKey");
CREATE UNIQUE INDEX "HrProvisionLedger_one_usage" ON "HrProvisionLedger"("sourceId", "provisionKey") WHERE "kind" = 'USAGE';
ALTER TABLE "HrProvisionLedger" ADD CONSTRAINT "HrProvisionLedger_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An employee's APPROVED balance for one provision.
CREATE OR REPLACE FUNCTION hr_provision_balance(p_employee text, p_key text) RETURNS numeric AS $$
  SELECT COALESCE(sum("amount"), 0) FROM "HrProvisionLedger" WHERE "employeeId" = p_employee AND "provisionKey" = p_key AND "status" = 'APPROVED';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION hr_provision_ledger_guard() RETURNS trigger AS $$
DECLARE acct text; credited numeric; attributed numeric; st text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: a provision subledger entry is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" <> 'PENDING' OR NEW."status" NOT IN ('APPROVED', 'REJECTED')
       OR (to_jsonb(NEW) - ARRAY['status', 'approvedBy', 'approvedAt']) <> (to_jsonb(OLD) - ARRAY['status', 'approvedBy', 'approvedAt']) THEN
      RAISE EXCEPTION 'HR: a provision subledger entry only goes from PENDING to APPROVED or REJECTED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  -- One employee's provision is changed one writer at a time (balance read below, under this lock).
  PERFORM pg_advisory_xact_lock(hashtext('hr:provision-emp:' || NEW."employeeId" || ':' || NEW."provisionKey"));
  IF NEW."kind" = 'RECOGNITION' AND TG_OP = 'INSERT' THEN
    SELECT "accountId" INTO acct FROM "HrAccountMap" WHERE "key" = NEW."provisionKey";
    SELECT "status" INTO st FROM "JournalEntry" WHERE "id" = NEW."journalEntryId";
    IF acct IS NULL OR st IS DISTINCT FROM 'POSTED' THEN
      RAISE EXCEPTION 'HR: a provision is attributed only from a POSTED journal on the mapped provision account' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('hr:provision-journal:' || NEW."journalEntryId" || ':' || NEW."provisionKey"));
    SELECT COALESCE(sum("credit") - sum("debit"), 0) INTO credited FROM "JournalEntryLine" WHERE "journalEntryId" = NEW."journalEntryId" AND "accountId" = acct;
    SELECT COALESCE(sum("amount"), 0) INTO attributed FROM "HrProvisionLedger"
      WHERE "kind" = 'RECOGNITION' AND "journalEntryId" = NEW."journalEntryId" AND "provisionKey" = NEW."provisionKey" AND "status" IN ('PENDING', 'APPROVED');
    IF attributed + NEW."amount" > credited THEN
      RAISE EXCEPTION 'HR: a journal''s provision is never attributed beyond what it credited the provision account' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'APPROVED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'APPROVED')
     AND hr_provision_balance(NEW."employeeId", NEW."provisionKey") + NEW."amount" < 0 THEN
    RAISE EXCEPTION 'HR: an employee''s provision balance never goes below zero (a settlement uses at most that employee''s own provision)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_provision_ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrProvisionLedger"
  FOR EACH ROW EXECUTE FUNCTION hr_provision_ledger_guard();

CREATE TABLE "HrProvisionShortfall" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "provisionKey" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "employeeBalance" DECIMAL(18,2) NOT NULL,
    "decisionReference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HrProvisionShortfall_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HrProvisionShortfall_key" CHECK ("provisionKey" IN ('EOS_PROVISION', 'LEAVE_PROVISION')),
    CONSTRAINT "HrProvisionShortfall_amount" CHECK ("amount" > 0 AND "employeeBalance" >= 0),
    CONSTRAINT "HrProvisionShortfall_status" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')),
    CONSTRAINT "HrProvisionShortfall_text" CHECK (length(btrim("decisionReference")) >= 3 AND length(btrim("reason")) >= 10),
    CONSTRAINT "HrProvisionShortfall_four_eyes" CHECK (("status" = 'PENDING') = ("decidedBy" IS NULL) AND ("decidedBy" IS NULL OR ("decidedBy" <> "requestedBy" AND "decidedAt" IS NOT NULL)))
);
CREATE UNIQUE INDEX "HrProvisionShortfall_live" ON "HrProvisionShortfall"("settlementId", "provisionKey") WHERE "status" IN ('PENDING', 'APPROVED');
ALTER TABLE "HrProvisionShortfall" ADD CONSTRAINT "HrProvisionShortfall_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "HrFinalSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION hr_provision_shortfall_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: a provision shortfall decision is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD."status" <> 'PENDING'
     OR (to_jsonb(NEW) - ARRAY['status', 'decidedBy', 'decidedAt', 'decisionNote']) <> (to_jsonb(OLD) - ARRAY['status', 'decidedBy', 'decidedAt', 'decisionNote'])) THEN
    RAISE EXCEPTION 'HR: a provision shortfall decision is decided once and never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_provision_shortfall_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrProvisionShortfall"
  FOR EACH ROW EXECUTE FUNCTION hr_provision_shortfall_guard();

COMMIT;
