-- BASELINE (owner decision 17 Oct, DECISION 3: "Preserve the existing commission_payout_freeze() function
-- and its trigger. Do not delete or replace them blindly."). It reconciles the migration history with
-- two objects that exist on the demo-training database (the probable production) but were created
-- out of band, outside every migration (no file in git history creates them). Definitions,
-- dependencies, purpose and the Phase 2 lift: docs/hr/COMMISSION-PAYOUT-FREEZE.md.
--
--   function public.commission_payout_freeze()  RETURNS trigger, plpgsql, VOLATILE, SECURITY INVOKER,
--            no search_path, owner = the migrate role, default ACL. It raises unconditionally:
--            "Commission payout recording is frozen at the database. …" (SQLSTATE P0001).
--   trigger  commission_payout_freeze_trg  BEFORE INSERT ON "CommissionLedgerEntry" FOR EACH ROW
--            WHEN (new.type = 'PAYOUT') — so no PAYOUT ledger entry can be written, by anyone
--            (the runtime role does not own the table and cannot disable or drop the trigger).
--            ACCRUAL / ADJUSTMENT / REVERSAL inserts, and every UPDATE / DELETE, are NOT affected.
--
-- Behaviour, per database:
--   · objects present and IDENTICAL (md5 of pg_get_functiondef / pg_get_triggerdef as recorded, no
--     other trigger on the function; the same definition as pre-flight check 10)
--                                    → nothing is changed (not even re-created): existing owner,
--                                      ACL, enabled state and comment are kept as they are.
--   · objects present but DIFFERENT  → the migration ABORTS and changes nothing: a variant is never
--                                      replaced blindly. Resolve it by hand, with the owner.
--   · objects absent                 → created exactly as on the copy, and marked with a COMMENT
--                                      naming this migration, so the rollback can tell objects this
--                                      migration created from objects that pre-existed.
--
-- Databases WITHOUT the objects (a fresh database, CI, the Neon branch named "production"): they are
-- CREATED, for production parity (owner decision). The payout freeze is then ON there too: the
-- standalone payout (POST /api/commissions/review/actions, action "payout") and the payroll payment
-- that settles a reserved commission period (settleReservations writes a PAYOUT) are refused, the
-- payment rolling back whole. Phase 1 refuses both anyway while payroll is locked (the payroll lock
-- trigger HrA0_payroll_lock_guard fires first, by name order). Lifting the freeze is a Phase 2
-- decision: docs/hr/COMMISSION-PAYOUT-FREEZE.md §6.
--
-- ADDITIVE and idempotent: re-running it on a database where it already ran is a no-op. Atomic.
-- Rollback: docs/hr/migration-review/rollback-20261017220000_commission_payout_freeze_baseline.sql
-- (drops ONLY what this migration created; never a pre-existing object).
BEGIN;
-- Delta review N1: everything below is judged and created under search_path = public (this transaction
-- only), so no schema earlier on the session's path can shadow the function or change how
-- pg_get_triggerdef renders it; pre-flight check 10 renders under the same path.
SET LOCAL search_path = public;

DO $migration$
DECLARE
  -- The body exactly as stored on the copy (pg_proc.prosrc, md5 e23b32d60ee9af69e05e0b2151dcc995,
  -- leading and trailing space included).
  expected_src CONSTANT text := $b$ BEGIN RAISE EXCEPTION 'Commission payout recording is frozen at the database. No PAYOUT entry can be written until the freeze is lifted. See scripts/sales-preview/payout-freeze.sql.' USING ERRCODE = 'raise_exception'; END $b$;
  -- "Identical" is ONE definition, shared verbatim with pre-flight check 10 (scripts/release/preflight-p4.sql)
  -- and docs/hr/COMMISSION-PAYOUT-FREEZE.md §1 (independent review F1):
  --   · the function public.commission_payout_freeze() (no arguments): md5(pg_get_functiondef) equals the
  --     recorded value — body, return type, language, volatility, STRICT, SECURITY DEFINER, LEAKPROOF,
  --     PARALLEL, COST, ROWS and SET (search_path …) all render into it;
  --   · the trigger commission_payout_freeze_trg on "CommissionLedgerEntry": md5(pg_get_triggerdef) equals
  --     the recorded value — timing, events, FOR EACH ROW, WHEN and the function render into it (the
  --     enabled state does not, and is preserved as found);
  --   · no OTHER trigger calls the function;
  --   · the trigger never exists without the function, and calls exactly it (tgfoid).
  -- Anything else is DIFFERENT: the migration aborts before changing anything.
  fn_md5 CONSTANT text := '13bbb1f3b4c42c2e8c98c82a18ffc6fa';
  trg_md5 CONSTANT text := '0237e501cafb7064df3cce01da22e287';
  marker CONSTANT text := 'Created by migration 20261017220000_commission_payout_freeze_baseline (owner decision 17 Oct: preserve the payout freeze). Rollback drops it only while this comment is unchanged.';
  fn_oid oid;
  trg_oid oid;
  others text;
BEGIN
  IF to_regclass('public."CommissionLedgerEntry"') IS NULL OR to_regtype('public."LedgerEntryType"') IS NULL THEN
    RAISE EXCEPTION 'commission baseline: table "CommissionLedgerEntry" or type "LedgerEntryType" is missing (20260924090000 not applied); nothing was changed';
  END IF;

  -- ── judge first, change nothing ─────────────────────────────────────────────────
  SELECT p.oid INTO fn_oid FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'commission_payout_freeze' AND p.pronargs = 0;
  SELECT tg.oid INTO trg_oid FROM pg_trigger tg
   WHERE tg.tgrelid = 'public."CommissionLedgerEntry"'::regclass AND tg.tgname = 'commission_payout_freeze_trg' AND NOT tg.tgisinternal;
  IF fn_oid IS NOT NULL AND md5(pg_get_functiondef(fn_oid)) <> fn_md5 THEN
    RAISE EXCEPTION 'commission baseline: public.commission_payout_freeze() exists but differs from the recorded definition (md5(pg_get_functiondef) %, recorded %); it is not replaced blindly — nothing was changed',
      md5(pg_get_functiondef(fn_oid)), fn_md5;
  END IF;
  IF trg_oid IS NOT NULL AND md5(pg_get_triggerdef(trg_oid)) <> trg_md5 THEN
    RAISE EXCEPTION 'commission baseline: trigger commission_payout_freeze_trg exists but differs from the recorded definition (%); nothing was changed', pg_get_triggerdef(trg_oid);
  END IF;
  IF trg_oid IS NOT NULL AND fn_oid IS NULL THEN
    RAISE EXCEPTION 'commission baseline: trigger commission_payout_freeze_trg exists without public.commission_payout_freeze(); nothing was changed';
  END IF;
  IF trg_oid IS NOT NULL AND (SELECT tgfoid FROM pg_trigger WHERE oid = trg_oid) IS DISTINCT FROM fn_oid THEN
    RAISE EXCEPTION 'commission baseline: trigger commission_payout_freeze_trg calls % , not public.commission_payout_freeze(); nothing was changed',
      (SELECT tgfoid::regprocedure FROM pg_trigger WHERE oid = trg_oid);
  END IF;
  IF fn_oid IS NOT NULL THEN
    SELECT string_agg(tg.tgrelid::regclass || '.' || tg.tgname, ', ') INTO others FROM pg_trigger tg
     WHERE tg.tgfoid = fn_oid AND NOT tg.tgisinternal AND tg.oid IS DISTINCT FROM trg_oid;
    IF others IS NOT NULL THEN
      RAISE EXCEPTION 'commission baseline: commission_payout_freeze() is used by another trigger (%); nothing was changed', others;
    END IF;
  END IF;

  -- ── then create only what is absent ─────────────────────────────────────────────
  IF fn_oid IS NULL THEN
    EXECUTE 'CREATE FUNCTION public.commission_payout_freeze() RETURNS trigger LANGUAGE plpgsql AS $function$'
            || expected_src || '$function$';
    fn_oid := 'public.commission_payout_freeze()'::regprocedure;
    IF md5(pg_get_functiondef(fn_oid)) <> fn_md5 THEN
      RAISE EXCEPTION 'commission baseline: the created function does not render as recorded (%); rolled back', md5(pg_get_functiondef(fn_oid));
    END IF;
    EXECUTE format('COMMENT ON FUNCTION public.commission_payout_freeze() IS %L', marker);
    RAISE NOTICE 'commission baseline: function commission_payout_freeze() created';
  ELSE
    RAISE NOTICE 'commission baseline: function commission_payout_freeze() already present and identical; left untouched';
  END IF;
  IF trg_oid IS NULL THEN
    CREATE TRIGGER commission_payout_freeze_trg BEFORE INSERT ON "CommissionLedgerEntry" FOR EACH ROW
      WHEN (new.type = 'PAYOUT'::"LedgerEntryType") EXECUTE FUNCTION public.commission_payout_freeze();
    SELECT tg.oid INTO trg_oid FROM pg_trigger tg
     WHERE tg.tgrelid = 'public."CommissionLedgerEntry"'::regclass AND tg.tgname = 'commission_payout_freeze_trg';
    IF (SELECT tgfoid FROM pg_trigger WHERE oid = trg_oid) <> 'public.commission_payout_freeze()'::regprocedure THEN
      RAISE EXCEPTION 'commission baseline: the created trigger does not call public.commission_payout_freeze(); rolled back';
    END IF;
    IF md5(pg_get_triggerdef(trg_oid)) <> trg_md5 THEN
      RAISE EXCEPTION 'commission baseline: the created trigger does not render as recorded (%); rolled back', pg_get_triggerdef(trg_oid);
    END IF;
    EXECUTE format('COMMENT ON TRIGGER commission_payout_freeze_trg ON "CommissionLedgerEntry" IS %L', marker);
    RAISE NOTICE 'commission baseline: trigger commission_payout_freeze_trg created (the payout freeze is now ON in this database)';
  ELSE
    RAISE NOTICE 'commission baseline: trigger commission_payout_freeze_trg already present and identical (enabled state %); left untouched',
      (SELECT tgenabled FROM pg_trigger WHERE oid = trg_oid);
  END IF;
END
$migration$;

COMMIT;
