-- Owner decisions F2 and 1b: independent approval of HR configuration changes (account map, HR
-- accounting on/off, leave types) and of grants of payroll-sensitive permissions (an account's
-- role / permission change, account creation included), plus the post-hoc review of immediate
-- revocations (PERMISSION_REVIEW: acknowledged by another person, never blocking). ADDITIVE ONLY: one new table and its two enums; no existing
-- table, column or row is touched. Atomic: the whole file runs in one transaction.
BEGIN;

-- CreateEnum
CREATE TYPE "HrConfigChangeKind" AS ENUM ('ACCOUNT_MAP_SET', 'ACCOUNTING_TOGGLE', 'LEAVE_TYPE_CREATE', 'PERMISSION_CHANGE', 'PERMISSION_REVIEW');

-- CreateEnum
CREATE TYPE "HrConfigChangeStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "HrConfigChange" (
    "id" TEXT NOT NULL,
    "kind" "HrConfigChangeKind" NOT NULL,
    "targetKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "before" JSONB,
    "fingerprint" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "HrConfigChangeStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "HrConfigChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HrConfigChange_status_requestedAt_idx" ON "HrConfigChange"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "HrConfigChange_targetKey_idx" ON "HrConfigChange"("targetKey");

-- ── Hand-written integrity (not expressible in the Prisma schema) ──────────────────────

-- One open request per target: a second request for the same key waits for the first.
CREATE UNIQUE INDEX "HrConfigChange_one_pending_per_target" ON "HrConfigChange"("targetKey") WHERE "status" = 'PENDING';

ALTER TABLE "HrConfigChange"
  -- Four eyes: whoever decides is never whoever requested.
  ADD CONSTRAINT "HrConfigChange_four_eyes" CHECK ("decidedBy" IS NULL OR "decidedBy" <> "requestedBy"),
  -- APPLIED / REJECTED name their decider; PENDING and WITHDRAWN (by the requester) do not.
  ADD CONSTRAINT "HrConfigChange_decider" CHECK (("status" IN ('APPLIED', 'REJECTED')) = ("decidedBy" IS NOT NULL)),
  -- Every closed request has a time; an open one has none.
  ADD CONSTRAINT "HrConfigChange_decided_at" CHECK (("status" <> 'PENDING') = ("decidedAt" IS NOT NULL)),
  ADD CONSTRAINT "HrConfigChange_reason" CHECK (length(btrim("reason")) >= 5);

-- A decided request is a record: it never changes, and no request is ever deleted. While
-- PENDING only the decision columns may be set (the requested content is immutable).
CREATE OR REPLACE FUNCTION hr_config_change_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: a configuration change request is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'HR: a decided configuration change never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'decidedBy', 'decidedAt', 'decisionNote']) <> (to_jsonb(OLD) - ARRAY['status', 'decidedBy', 'decidedAt', 'decisionNote']) THEN
    RAISE EXCEPTION 'HR: the content of a configuration change request never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER hr_config_change_guard BEFORE UPDATE OR DELETE ON "HrConfigChange"
  FOR EACH ROW EXECUTE FUNCTION hr_config_change_guard();

COMMIT;
