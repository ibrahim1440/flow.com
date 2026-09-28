-- PAYOUT FREEZE — an enforceable stop on recording commission payouts.
--
-- ── Why this is a database trigger and not a feature flag ──
--
-- The payout controls added in 498a1d3..ed201dd live in application code: the required
-- idempotency key, the employee-period lock, and the gate that refuses a period whose
-- entitlement cannot be derived. **Rolling back to code older than those commits removes
-- all three.** The older code has no unresolved-balance gate at all, so every period this
-- release blocks becomes payable again the moment it is deployed — including periods that
-- have already been paid against and cannot be reconciled.
--
-- That makes "roll back the deployment" and "roll back safely" two different operations.
-- A flag in the new code cannot help, because the code being rolled back to does not read
-- it. Hiding the button helps even less: the route is reachable by anyone who can send a
-- POST, and authorisation is not a matter of which buttons render.
--
-- So the stop has to live below the application, where every version of it is subject to
-- the same rule. This trigger refuses the INSERT itself. Whichever build is running, a
-- payout cannot be written while it is installed.
--
-- ── Scope ──
--
-- PAYOUT rows only. Accruals, reversals and adjustments are untouched, so collections
-- continue to be verified and commission continues to accrue while payouts are frozen —
-- a freeze on paying must not become an outage of the sales workflow.
--
-- ── Applying it ──
--
-- Run as the migration/owner identity, never as the application role. On the preview
-- database that is `sales_preview_migrator` via scripts/sales-preview/withmigrate.mjs.
-- Removing the freeze is the same file's DROP section, run deliberately.

-- ═══ FREEZE ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION commission_payout_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Commission payout recording is frozen at the database. No PAYOUT entry can be written '
    'until the freeze is lifted. See scripts/sales-preview/payout-freeze.sql.'
    USING ERRCODE = 'raise_exception';
END $$;

DROP TRIGGER IF EXISTS commission_payout_freeze_trg ON "CommissionLedgerEntry";

CREATE TRIGGER commission_payout_freeze_trg
  BEFORE INSERT ON "CommissionLedgerEntry"
  FOR EACH ROW
  WHEN (NEW.type = 'PAYOUT')
  EXECUTE FUNCTION commission_payout_freeze();

-- Confirm it is installed. Expect exactly one row.
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgrelid = '"CommissionLedgerEntry"'::regclass AND NOT tgisinternal;

-- ═══ LIFT ═════════════════════════════════════════════════════════════════════
-- Run these two, deliberately, once the deployed build is known to carry the payout
-- controls again. Leaving the function behind is harmless; the trigger is what enforces.
--
--   DROP TRIGGER IF EXISTS commission_payout_freeze_trg ON "CommissionLedgerEntry";
--   DROP FUNCTION IF EXISTS commission_payout_freeze();
