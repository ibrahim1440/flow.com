-- Phase 1 PAYROLL LOCK (decision C GAP-9 subset; owner decisions A-7 / A-8: strict, fail-closed,
-- for every account, administrators included). Engineering CONTROL only: no pay value, rate or
-- policy value; nothing is switched on.
--
-- 1 · The LIVE PAYROLL switch: HrSettings."payrollLive", default false — off in every seed and
--     fixture end state. It turns on only through an APPLIED two-person PAYROLL_LIVE_SET settings
--     change (new HrConfigChangeKind value); the application refuses that change while the
--     pre-activation readiness check (src/lib/hr/readiness.ts) has any finding. hr_settings_live_guard:
--     payrollLive becomes true only naming (payrollLiveChangeId) the most recent decided
--     PAYROLL_LIVE_SET change, APPLIED, enabling, requested and decided by two EXISTING logins that
--     are DIFFERENT PERSONS (hr_same_person: every link ever made, shared identity number) and each
--     hold a live identity verification, decided after it was requested. Turning it off needs
--     nothing (it only stops).
-- 2 · Settings / approval requests (HrConfigChange) are INSERTED PENDING only — never born decided —
--     and become APPLIED only with a decider who is not the requester's PERSON
--     (hr_config_change_decision_guard). A forged "applied" row can no longer be written directly.
-- 3 · While payroll is off, the database refuses every payroll MONEY or POSTING write, whoever writes
--     it (hr_payroll_lock_guard, trigger "HrA0_payroll_lock_guard", named to fire first):
--       HR: any HR journal link; a payroll run becoming APPROVED or PAID; a payroll payment,
--       per-employee allocation, return or bank-result import; a final settlement becoming POSTED or
--       PAID; a GOSI invoice payment or a booked GOSI adjustment; a provision ledger row; an advance
--       becoming DISBURSED, or INSERTED as DISBURSED / CLOSED; an advance repayment; a payroll policy
--       becoming ACTIVE or INSERTED as ACTIVE.
--       General ledger: a journal entry INSERTED with sourceModule 'hr' (only the HR services post
--       those, and they are locked); a journal entry becoming POSTED, or a journal line written into
--       a POSTED entry (a reversal posts on creation), that touches a PAYROLL ACCOUNT. Payroll
--       accounts = every account mapped in the HR posting map (HrAccountMap) except PAYROLL_CASH
--       (hr_is_payroll_account): salary / allowance / overtime / commission / employer-contribution
--       expense, salaries / contributions / other-deductions / final-settlement payables, employee
--       advances, EOS and leave provisions and expenses. PAYROLL_CASH is excluded because it is
--       normally the operating bank account: every payroll posting has a payroll-side line, which is
--       refused. Ordinary (non-payroll) manual journals post as before.
--       Commissions (owner-adjustable scope, PAYROLL-LOCK.md): a commission PAYOUT ledger entry
--       written, changed into or out of PAYOUT, or deleted; a commission accrual created PAID,
--       becoming or leaving PAID, or a PAID accrual deleted (employee compensation recorded as paid).
--       The HR posting map itself: a mapped key is never remapped or unmapped (HrAccountMap UPDATE of
--       the account / DELETE); mapping a key not yet mapped stays allowed.
--     Read-only access, dry preparation (DRAFT runs) and HR data entry are not touched. A missing
--     settings row, or anything but exactly true, is LOCKED.
-- 4 · STICKY payroll accounts: HrPayrollAccount records every (account, key) the posting map has ever
--     held (backfilled; appended by hr_payroll_account_record; append-only). hr_is_payroll_account
--     reads it, so an account once mapped stays a payroll account for the ledger lock.
-- 5 · Identity verifications (hr_identity_verification_insert_guard, "HrA0_identity_verification_insert_guard"):
--     never back- / forward-dated, never born revoked, never by the subject login's own person; while
--     locked and after the identity bootstrap, only by an existing verified login.
--
-- 6 · Manual journals DISABLED in Phase 1 (owner decision D1, Option B): HrSettings."manualJournalsEnabled"
--     (default false, fail-closed). While off, only the automatic HR posting workflow ('hr', AUTO /
--     REVERSAL) creates or changes ledger entries; a manual / generic entry is never created, changed,
--     approved, posted or deleted, nor its lines (hr_manual_journal_guard, "HrA1_manual_journal_guard"
--     on JournalEntry and JournalEntryLine). At all times a posted entry's lines are final.
--
-- 7 · Both switches turn ON only inside the owner-run Phase 2 release step (hr_release_step_active:
--     SET LOCAL hiqbah.release_step = 'phase2-activation', never set by the application), for every
--     role including the tables' owner (RC3 QA F3).
--
-- ADDITIVE: one enum value, three defaulted / nullable columns, one new table (HrPayrollAccount), thirteen
-- functions, 25 triggers (19 on HR tables, 6 on the ledger / commission tables). No existing row is
-- changed. Atomic.
--
-- Rollback: docs/hr/migration-review/rollback-20261017215000_hr_payroll_lock.sql
BEGIN;

ALTER TYPE "HrConfigChangeKind" ADD VALUE IF NOT EXISTS 'PAYROLL_LIVE_SET';

ALTER TABLE "HrSettings" ADD COLUMN "payrollLive" BOOLEAN NOT NULL DEFAULT false,
                         ADD COLUMN "payrollLiveChangeId" TEXT,
                         ADD COLUMN "manualJournalsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- The HR persons a login is, or ever was, linked to (the SQL twin of identity.personsOf): employee and
-- external-person records linked now, every record an ACCOUNT_LINK / ACCOUNT_UNLINK ever named for
-- the login, and the record of the other kind sharing an identity number with any of them.
CREATE OR REPLACE FUNCTION hr_person_keys(acc text) RETURNS TABLE (k text) AS $$
  WITH e AS (
    SELECT h."id" FROM "HrEmployee" h WHERE h."accountId" = acc
    UNION SELECT a."entityId" FROM "HrAuditLog" a
     WHERE a."entityType" = 'HrEmployee' AND a."action" IN ('ACCOUNT_LINK', 'ACCOUNT_UNLINK')
       AND ((a."after"->>'accountId') = acc OR (a."before"->>'accountId') = acc)
  ), x AS (
    SELECT p."id" FROM "HrExternalPerson" p WHERE p."accountId" = acc
    UNION SELECT a."entityId" FROM "HrAuditLog" a
     WHERE a."entityType" = 'HrExternalPerson' AND a."action" IN ('ACCOUNT_LINK', 'ACCOUNT_UNLINK')
       AND ((a."after"->>'accountId') = acc OR (a."before"->>'accountId') = acc)
  )
  SELECT 'E:' || id FROM e
  UNION SELECT 'E:' || p."employeeId" FROM "HrEmployeePrivate" p JOIN "HrExternalPerson" xp ON p."idNumberNorm" = xp."idNumberNorm"
         WHERE xp."id" IN (SELECT id FROM x) AND p."idNumberNorm" IS NOT NULL
  UNION SELECT 'X:' || id FROM x
  UNION SELECT 'X:' || xp."id" FROM "HrExternalPerson" xp JOIN "HrEmployeePrivate" p ON p."idNumberNorm" = xp."idNumberNorm"
         WHERE p."employeeId" IN (SELECT id FROM e) AND xp."idNumberNorm" IS NOT NULL
$$ LANGUAGE sql STABLE;

-- The same login, or two logins of one person.
CREATE OR REPLACE FUNCTION hr_same_person(a text, b text) RETURNS boolean AS $$
  SELECT a = b OR EXISTS (SELECT 1 FROM hr_person_keys(a) pa JOIN hr_person_keys(b) pb ON pa.k = pb.k)
$$ LANGUAGE sql STABLE;

-- A login holds a live identity verification that attests it.
CREATE OR REPLACE FUNCTION hr_login_verified(acc text) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "HrIdentityVerification" v WHERE v."accountId" = acc AND v."revokedAt" IS NULL)
$$ LANGUAGE sql STABLE;

-- Settings / approval requests are born PENDING; APPLIED needs a decider who is another PERSON.
CREATE OR REPLACE FUNCTION hr_config_change_decision_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'PENDING' OR NEW."decidedBy" IS NOT NULL OR NEW."decidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'HR: a configuration change request is created PENDING and decided by another person later' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW."status"::text = 'APPLIED' AND OLD."status"::text <> 'APPLIED' THEN
    IF NEW."decidedBy" IS NULL OR hr_same_person(NEW."requestedBy", NEW."decidedBy") THEN
      RAISE EXCEPTION 'HR: a configuration change is applied only by a person other than its requester' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "HrA0_config_change_decision_guard" BEFORE INSERT OR UPDATE ON "HrConfigChange"
  FOR EACH ROW EXECUTE FUNCTION hr_config_change_decision_guard();

-- The Phase 2 RELEASE STEP (RC3 QA F3): a switch is turned ON only inside an owner-run release step that
-- declares itself in its own transaction — SET LOCAL hiqbah.release_step = 'phase2-activation' — which
-- the application never sets. Whatever role writes (the tables' owner included), without it the
-- database refuses. Turning a switch OFF needs nothing (it only stops).
CREATE OR REPLACE FUNCTION hr_release_step_active() RETURNS boolean AS $$
  SELECT coalesce(current_setting('hiqbah.release_step', true), '') = 'phase2-activation'
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION hr_settings_live_guard() RETURNS trigger AS $$
DECLARE latest RECORD;
BEGIN
  IF NEW."manualJournalsEnabled" AND (TG_OP = 'INSERT' OR NOT OLD."manualJournalsEnabled") AND NOT hr_release_step_active() THEN
    RAISE EXCEPTION 'HR: manual journals are turned on only by the owner-run Phase 2 release step (hiqbah.release_step)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."payrollLive" AND (TG_OP = 'INSERT' OR NOT OLD."payrollLive" OR NEW."payrollLiveChangeId" IS DISTINCT FROM OLD."payrollLiveChangeId") THEN
    IF NOT hr_release_step_active() THEN
      RAISE EXCEPTION 'HR: live payroll is turned on only by the owner-run Phase 2 release step (hiqbah.release_step)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT c."id", c."status"::text AS status, c."requestedBy", c."decidedBy", c."requestedAt", c."decidedAt", c."payload" INTO latest
      FROM "HrConfigChange" c
     WHERE c."kind"::text = 'PAYROLL_LIVE_SET' AND c."decidedAt" IS NOT NULL
     ORDER BY c."decidedAt" DESC, c."id" DESC LIMIT 1;
    IF latest."id" IS NULL OR latest."id" <> NEW."payrollLiveChangeId" OR latest.status <> 'APPLIED'
       OR latest."decidedBy" IS NULL OR latest."decidedAt" < latest."requestedAt"
       OR NOT EXISTS (SELECT 1 FROM "Employee" e WHERE e."id" = latest."requestedBy")
       OR NOT EXISTS (SELECT 1 FROM "Employee" e WHERE e."id" = latest."decidedBy")
       OR NOT hr_login_verified(latest."requestedBy") OR NOT hr_login_verified(latest."decidedBy")
       OR hr_same_person(latest."requestedBy", latest."decidedBy")
       OR coalesce((latest."payload"->>'payrollLive')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'HR: live payroll turns on only through the latest applied two-person PAYROLL_LIVE_SET change (two verified persons; and a clean readiness check)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_settings_live_guard BEFORE INSERT OR UPDATE ON "HrSettings"
  FOR EACH ROW EXECUTE FUNCTION hr_settings_live_guard();

-- STICKY payroll accounts (re-review R1): every (account, key) the HR posting map has EVER held,
-- recorded on each mapping and backfilled from the map and the applied ACCOUNT_MAP_SET history.
-- An account once mapped under a payroll key stays a payroll account for the ledger lock, so
-- remapping or unmapping cannot open it again. Append-only.
CREATE TABLE "HrPayrollAccount" (
    "accountId"   TEXT NOT NULL,
    "key"         TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HrPayrollAccount_pkey" PRIMARY KEY ("accountId", "key")
);
INSERT INTO "HrPayrollAccount" ("accountId", "key")
  SELECT m."accountId", m."key" FROM "HrAccountMap" m
  UNION SELECT c."payload"->>'accountId', c."payload"->>'key' FROM "HrConfigChange" c
   WHERE c."kind"::text = 'ACCOUNT_MAP_SET' AND c."status"::text = 'APPLIED' AND c."payload"->>'accountId' IS NOT NULL AND c."payload"->>'key' IS NOT NULL
  UNION SELECT c."before" #>> '{}', c."payload"->>'key' FROM "HrConfigChange" c
   WHERE c."kind"::text = 'ACCOUNT_MAP_SET' AND c."status"::text = 'APPLIED' AND jsonb_typeof(c."before") = 'string' AND c."payload"->>'key' IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION hr_payroll_account_record() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'HrPayrollAccount' THEN
    RAISE EXCEPTION 'HR: the payroll-account history is append-only' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  INSERT INTO "HrPayrollAccount" ("accountId", "key") VALUES (NEW."accountId", NEW."key") ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_account_record AFTER INSERT OR UPDATE ON "HrAccountMap"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_account_record();
CREATE TRIGGER hr_payroll_account_append_only BEFORE UPDATE OR DELETE ON "HrPayrollAccount"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_account_record();

-- The payroll accounts of the general ledger: every account EVER mapped under an HR posting key,
-- PAYROLL_CASH excepted (see 3).
CREATE OR REPLACE FUNCTION hr_is_payroll_account(acc text) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "HrPayrollAccount" m WHERE m."accountId" = acc AND m."key" <> 'PAYROLL_CASH')
      OR EXISTS (SELECT 1 FROM "HrAccountMap" m WHERE m."accountId" = acc AND m."key" <> 'PAYROLL_CASH')
$$ LANGUAGE sql STABLE;

-- Re-review R4: identity verifications are written by the application's verification path only.
-- What the database can check: a verification is never back- or forward-dated, never born revoked,
-- never attests a login of the same person as its verifier; and, while payroll is locked and the
-- one-time identity bootstrap is complete, its verifier is an existing login with a live
-- verification of its own. (Who really verified is not visible to the database: the runtime login
-- cannot write the payroll switch at all — the grants of scripts/hr/grant-hr-runtime.sql.)
CREATE OR REPLACE FUNCTION hr_identity_verification_insert_guard() RETURNS trigger AS $$
DECLARE live boolean;
BEGIN
  IF NEW."verifiedAt" < now() - interval '5 minutes' OR NEW."verifiedAt" > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'HR: an identity verification is recorded when it is made (verifiedAt is not back- or forward-dated)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."revokedAt" IS NOT NULL OR NEW."revokedBy" IS NOT NULL THEN
    RAISE EXCEPTION 'HR: an identity verification is never created revoked' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."accountId" IS NOT NULL AND hr_same_person(NEW."accountId", NEW."verifiedBy") THEN
    RAISE EXCEPTION 'HR: nobody verifies a login of their own person' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT s."payrollLive" INTO live FROM "HrSettings" s WHERE s."id" = 'singleton';
  IF NOT coalesce(live, false) AND EXISTS (SELECT 1 FROM "HrIdentityBootstrap")
     AND NOT (EXISTS (SELECT 1 FROM "Employee" e WHERE e."id" = NEW."verifiedBy") AND hr_login_verified(NEW."verifiedBy")) THEN
    RAISE EXCEPTION 'HR: payroll is locked (live payroll is off): an identity verification by a verifier who is not a verified login is refused' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "HrA0_identity_verification_insert_guard" BEFORE INSERT ON "HrIdentityVerification"
  FOR EACH ROW EXECUTE FUNCTION hr_identity_verification_insert_guard();

CREATE OR REPLACE FUNCTION hr_payroll_lock_guard() RETURNS trigger AS $$
DECLARE live boolean; what text; parent RECORD;
BEGIN
  SELECT s."payrollLive" INTO live FROM "HrSettings" s WHERE s."id" = 'singleton';
  IF coalesce(live, false) THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'HrAccountMap' THEN
    -- Re-review R1: while locked an HR posting key is never remapped or unmapped (mapping a key not
    -- yet mapped is allowed: it only adds protection, and the release gate needs it).
    IF TG_OP = 'DELETE' THEN
      what := 'unmapping the HR posting key ' || OLD."key";
    ELSIF NEW."accountId" IS DISTINCT FROM OLD."accountId" OR NEW."key" IS DISTINCT FROM OLD."key" THEN
      what := 'remapping the HR posting key ' || OLD."key";
    END IF;
  ELSIF TG_TABLE_NAME = 'HrPayrollRun' THEN
    IF NEW."status"::text IN ('APPROVED', 'PAID') AND NEW."status"::text IS DISTINCT FROM OLD."status"::text THEN
      what := 'a payroll run becoming ' || NEW."status"::text;
    END IF;
  ELSIF TG_TABLE_NAME = 'HrFinalSettlement' THEN
    IF NEW."status" IN ('POSTED', 'PAID') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
      what := 'a final settlement becoming ' || NEW."status";
    END IF;
  ELSIF TG_TABLE_NAME = 'HrAdvance' THEN
    IF TG_OP = 'INSERT' AND NEW."status"::text IN ('DISBURSED', 'CLOSED') THEN
      what := 'an advance created ' || NEW."status"::text;
    ELSIF TG_OP = 'UPDATE' AND NEW."status"::text = 'DISBURSED' AND OLD."status"::text IS DISTINCT FROM 'DISBURSED' THEN
      what := 'an advance disbursement';
    END IF;
  ELSIF TG_TABLE_NAME = 'HrPayrollPolicy' THEN
    IF NEW."status"::text = 'ACTIVE' AND (TG_OP = 'INSERT' OR OLD."status"::text IS DISTINCT FROM 'ACTIVE') THEN
      what := 'a payroll policy ' || CASE WHEN TG_OP = 'INSERT' THEN 'created ACTIVE' ELSE 'activation' END;
    END IF;
  ELSIF TG_TABLE_NAME = 'HrJournalLink' THEN
    what := 'an HR journal (' || NEW."sourceType" || ' ' || NEW."purpose" || ')';
  ELSIF TG_TABLE_NAME = 'JournalEntry' THEN
    IF lower(btrim(NEW."sourceModule")) = 'hr' AND (TG_OP = 'INSERT' OR lower(btrim(OLD."sourceModule")) IS DISTINCT FROM 'hr') THEN
      what := 'a journal entry of the HR module';
    ELSIF NEW."status"::text = 'POSTED' AND (TG_OP = 'INSERT' OR OLD."status"::text IS DISTINCT FROM 'POSTED')
          AND EXISTS (SELECT 1 FROM "JournalEntryLine" l WHERE l."journalEntryId" = NEW."id" AND hr_is_payroll_account(l."accountId")) THEN
      what := 'posting a journal entry on a payroll account';
    END IF;
  ELSIF TG_TABLE_NAME = 'JournalEntryLine' THEN
    SELECT j."status"::text AS status INTO parent FROM "JournalEntry" j WHERE j."id" = NEW."journalEntryId";
    IF parent.status = 'POSTED' AND hr_is_payroll_account(NEW."accountId") THEN
      what := 'a posted journal line on a payroll account';
    END IF;
  ELSIF TG_TABLE_NAME = 'CommissionLedgerEntry' THEN
    -- Re-review R3: a PAYOUT is never written, turned into, changed or removed while locked.
    IF TG_OP = 'INSERT' AND NEW."type"::text = 'PAYOUT' THEN
      what := 'a commission payout';
    ELSIF TG_OP = 'UPDATE' AND (NEW."type"::text = 'PAYOUT' OR OLD."type"::text = 'PAYOUT') THEN
      what := 'changing a commission payout entry';
    ELSIF TG_OP = 'DELETE' AND OLD."type"::text = 'PAYOUT' THEN
      what := 'removing a commission payout entry';
    END IF;
  ELSIF TG_TABLE_NAME = 'CommissionAccrual' THEN
    IF TG_OP = 'INSERT' AND NEW."status"::text = 'PAID' THEN
      what := 'a commission accrual created PAID';
    ELSIF TG_OP = 'UPDATE' AND (NEW."status"::text = 'PAID') <> (OLD."status"::text = 'PAID') THEN
      what := 'a commission accrual ' || CASE WHEN NEW."status"::text = 'PAID' THEN 'becoming PAID' ELSE 'leaving PAID' END;
    ELSIF TG_OP = 'DELETE' AND OLD."status"::text = 'PAID' THEN
      what := 'removing a PAID commission accrual';
    END IF;
  ELSE
    what := 'a ' || TG_TABLE_NAME || ' row';
  END IF;
  IF what IS NOT NULL THEN
    RAISE EXCEPTION 'HR: payroll is locked (live payroll is off): % is refused', what USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Named "HrA0_…" so that it fires FIRST on each table (PostgreSQL fires triggers in byte order of name): a locked
-- write is refused as locked, before any other guard looks at it.
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE UPDATE ON "HrPayrollRun"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE UPDATE ON "HrFinalSettlement"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT OR UPDATE ON "HrAdvance"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT OR UPDATE ON "HrPayrollPolicy"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT ON "HrJournalLink"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT ON "HrPayrollPayment"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT ON "HrPayrollPaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT ON "HrPayrollPaymentReturn"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT ON "HrPayrollBankImport"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT ON "HrGosiInvoicePayment"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT ON "HrProvisionLedger"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT ON "HrAdvanceRepayment"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT ON "HrGosiAdjustment"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE UPDATE OR DELETE ON "HrAccountMap"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT OR UPDATE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT OR UPDATE ON "JournalEntryLine"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CommissionLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();
CREATE TRIGGER "HrA0_payroll_lock_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CommissionAccrual"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock_guard();

-- 6 · MANUAL JOURNALS DISABLED in Phase 1 (owner decision D1, Option B). HrSettings."manualJournalsEnabled"
-- (default false; a missing row is disabled; the runtime role cannot write it — grant-hr-runtime.sql).
-- While it is not exactly true, a journal entry is created, changed, posted or deleted ONLY by an
-- automatic workflow on the allowlist (hr_automatic_journal_module: the HR posting bridge, 'hr'; type
-- AUTO or REVERSAL) — never one of the manual / generic ledger ('manual', NULL, anything else), and
-- never its lines. At all times, a line of a POSTED entry is never changed or deleted.
CREATE OR REPLACE FUNCTION hr_manual_journals_enabled() RETURNS boolean AS $$
  SELECT coalesce((SELECT s."manualJournalsEnabled" FROM "HrSettings" s WHERE s."id" = 'singleton'), false)
$$ LANGUAGE sql STABLE;

-- The automatic posting workflows allowed to write the ledger while manual journals are disabled.
CREATE OR REPLACE FUNCTION hr_automatic_journal_module(m text) RETURNS boolean AS $$
  SELECT m IS NOT NULL AND lower(btrim(m)) IN ('hr')
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION hr_manual_journal_guard() RETURNS trigger AS $$
DECLARE what text; parent RECORD;
BEGIN
  IF TG_TABLE_NAME = 'JournalEntryLine' THEN
    -- At all times: a posted entry's lines are final (a correction is a reversal).
    IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."id" = OLD."journalEntryId" AND j."status"::text IN ('POSTED', 'REVERSED')) THEN
      RAISE EXCEPTION 'LEDGER: a line of a posted journal entry is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."id" = NEW."journalEntryId" AND j."status"::text IN ('POSTED', 'REVERSED')) THEN
      RAISE EXCEPTION 'LEDGER: a line of a posted journal entry is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF hr_manual_journals_enabled() THEN
      RETURN coalesce(NEW, OLD);
    END IF;
    SELECT j."sourceModule" AS m INTO parent FROM "JournalEntry" j
     WHERE j."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."journalEntryId" ELSE NEW."journalEntryId" END;
    IF NOT hr_automatic_journal_module(parent.m) THEN
      what := 'a line of a manual journal entry';
    END IF;
  ELSE
    IF hr_manual_journals_enabled() THEN
      RETURN coalesce(NEW, OLD);
    END IF;
    IF TG_OP = 'INSERT' AND (NOT hr_automatic_journal_module(NEW."sourceModule") OR NEW."type"::text NOT IN ('AUTO', 'REVERSAL')) THEN
      what := 'creating a manual journal entry';
    ELSIF TG_OP = 'UPDATE' AND (NOT hr_automatic_journal_module(OLD."sourceModule") OR NOT hr_automatic_journal_module(NEW."sourceModule")) THEN
      what := 'changing, approving or posting a manual journal entry';
    ELSIF TG_OP = 'DELETE' AND NOT hr_automatic_journal_module(OLD."sourceModule") THEN
      what := 'deleting a manual journal entry';
    END IF;
  END IF;
  IF what IS NOT NULL THEN
    RAISE EXCEPTION 'LEDGER: manual journals are disabled (Phase 1): % is refused', what USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
-- "HrA1_…": right after the payroll lock (which answers first for payroll writes).
CREATE TRIGGER "HrA1_manual_journal_guard" BEFORE INSERT OR UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION hr_manual_journal_guard();
CREATE TRIGGER "HrA1_manual_journal_guard" BEFORE INSERT OR UPDATE OR DELETE ON "JournalEntryLine"
  FOR EACH ROW EXECUTE FUNCTION hr_manual_journal_guard();

COMMIT;
