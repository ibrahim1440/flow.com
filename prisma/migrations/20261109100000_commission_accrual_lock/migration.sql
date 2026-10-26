-- Commission accrual under the payroll lock (October 2026 accounting audit, F-4).
--
-- POSTING-CONTRACT §11.5 maps the HR key COMMISSION_EXPENSE to the COMMISSION_PAYABLE account (2145), so that a payout
-- through payroll clears the payable instead of expensing the commission twice. hr_is_payroll_account treats every
-- account ever mapped under an HR key as a payroll account, so 2145 became one, and while live payroll is off
-- hr_payroll_lock_guard refused the commission module's own ACCRUAL entry (Dr 6150 / Cr 2145): no commission month could
-- be approved once the map was aligned. The contract freezes the commission PAYOUT under the lock, not the accrual.
--
-- The exemption is exact, not a bypass. A posted line on a payroll account is admitted while locked only when BOTH hold:
--   1. its entry is the commission engine's accrual: sourceModule 'commissions', sourceType 'COMMISSION', sourceEvent
--      ACCRUED or ACCRUED.<n> (a correction), type AUTO, with an idempotency key (hr_is_commission_accrual);
--   2. the account is a payroll account ONLY through the COMMISSION_EXPENSE key — it was never mapped under any other HR
--      key except PAYROLL_CASH (hr_is_payroll_account_beyond_commission is false).
-- Everything else stays refused exactly as before: every entry of the HR module, a commission PAID.<n> payout, any
-- reversal, any other module, any line on a salary / GOSI / advances / EOS / settlement account, and the map itself
-- (no remap or unmap while locked). A map that put COMMISSION_EXPENSE on a salary account keeps that account locked.
-- Replaces hr_payroll_lock_guard in place (its other branches are copied unchanged) and adds two helper functions.

CREATE OR REPLACE FUNCTION hr_is_commission_accrual(m text, st text, ev text, t text, k text) RETURNS boolean AS $$
  SELECT coalesce(m = 'commissions' AND st = 'COMMISSION' AND ev ~ '^ACCRUED(\.[0-9]+)?$' AND t = 'AUTO' AND k IS NOT NULL, false)
$$ LANGUAGE sql IMMUTABLE;

-- A payroll account through some key OTHER than COMMISSION_EXPENSE (and PAYROLL_CASH, never a payroll account).
CREATE OR REPLACE FUNCTION hr_is_payroll_account_beyond_commission(acc text) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "HrPayrollAccount" m WHERE m."accountId" = acc AND m."key" NOT IN ('PAYROLL_CASH', 'COMMISSION_EXPENSE'))
      OR EXISTS (SELECT 1 FROM "HrAccountMap" m WHERE m."accountId" = acc AND m."key" NOT IN ('PAYROLL_CASH', 'COMMISSION_EXPENSE'))
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION hr_payroll_lock_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
          AND EXISTS (SELECT 1 FROM "JournalEntryLine" l WHERE l."journalEntryId" = NEW."id" AND hr_is_payroll_account(l."accountId")
                        AND NOT (hr_is_commission_accrual(NEW."sourceModule", NEW."sourceType", NEW."sourceEvent", NEW."type"::text, NEW."idempotencyKey")
                                 AND NOT hr_is_payroll_account_beyond_commission(l."accountId"))) THEN
      what := 'posting a journal entry on a payroll account';
    END IF;
  ELSIF TG_TABLE_NAME = 'JournalEntryLine' THEN
    SELECT j."status"::text AS status, j."sourceModule" AS m, j."sourceType" AS st, j."sourceEvent" AS ev, j."type"::text AS t, j."idempotencyKey" AS k
      INTO parent FROM "JournalEntry" j WHERE j."id" = NEW."journalEntryId";
    IF parent.status = 'POSTED' AND hr_is_payroll_account(NEW."accountId")
       AND NOT (hr_is_commission_accrual(parent.m, parent.st, parent.ev, parent.t, parent.k) AND NOT hr_is_payroll_account_beyond_commission(NEW."accountId")) THEN
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
$function$;
