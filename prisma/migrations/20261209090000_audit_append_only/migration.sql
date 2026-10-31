-- Batch 26 (owner-approved 31 Oct 2026; amended by gate B26 fix round 1): the audit logs are append-only for the runtime role.
--   1. audit_append_only(): one hardened guard (search_path = pg_catalog, public, pg_temp; relations written public."…") on the
--      audit tables that had none — BEFORE UPDATE OR DELETE refuses, BEFORE TRUNCATE refuses (also added, TRUNCATE only, to
--      FinAuditLog, HrAuditLog, HrLeaveLedger and MktAuditLog, whose own guards cover rows but not TRUNCATE). It binds the
--      owner role too, and lets a change through ONLY:
--        · ON DELETE SET NULL: inside a foreign-key action (pg_trigger_depth() > 1, running as the table owner), only FK columns
--          of ON DELETE SET NULL constraints going to NULL, and only when the row they referenced is gone (gate G2);
--        · ON DELETE CASCADE: inside a foreign-key action, when the parent row named by TG_ARGV (table, then child / parent
--          column pairs) no longer exists — never a row of a record that still exists;
--        · the reset marker of audit_reset_purge() below: never for the runtime role, and only at trigger depth 1 — the
--          function's own DELETE, never a foreign-key action it causes (gate G1);
--        · a throwaway TEST database whose provisioning sets hiqbah.audit_purge = 'test-cleanup': only when NEITHER the session
--          user NOR the current user is the runtime role (a foreign-key action runs as the table owner — gate G1).
--   2. Every audit table — the new ones and those already guarded by their own trigger, plus MktConsentEvent (consent
--      evidence; DELETE was unguarded) and CommissionLedgerCorrection — loses UPDATE, DELETE and TRUNCATE for the runtime role
--      (flowcom_app); it keeps SELECT and INSERT (23 tables).
--   3. audit_reset_purge(p_actor_id, p_actor_name, p_reason): the training / admin reset's only way to clear the customer-tied
--      audit rows it has always cleared (all of CustomerCreditLog; CommissionAuditLog rows of a customer). SECURITY DEFINER,
--      hardened like batch 25b; the actor must be an ACTIVE employee, the administrator or a holder of settings › reset /
--      training_reset (the routes' own gates); a reason is required; it writes one SettingsAuditLog row with the counts.
--      NOT executable by the runtime role from this migration (gate G3): grant-app-runtime.sql grants it only with the explicit
--      opt-in -v allow_reset=1, on training / demo databases. In production it stays the owner's.
--   4. message_archive_set_legal_hold / message_archive_erase_customer (batch 25b) now also require the actor to be an active
--      administrator, inside the function (gate B25B-R3 residual). Like every actor check in the database, this guards against
--      application bugs — not against a compromised runtime role, which can write "Employee" (RUNBOOK §10.18).
--   5. message_archive_immutable() (batch 25b): the same G1 fix — its marker only at trigger depth 1, its test setting only when
--      neither the session user nor the current user is the runtime role; search_path pinned.
--   golive-reset.sql runs as the owner and disables user triggers before it truncates: unaffected.
-- Rollback: docs/hr/migration-review/rollback-20261209090000_audit_append_only.sql. Verifier check 82.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1 ────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION audit_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  depth integer := pg_catalog.pg_trigger_depth();
  k text; changed integer := 0; only_set_null boolean := true; parent_alive boolean; cond text := ''; i integer;
  fk record;
BEGIN
  -- ON DELETE SET NULL (an employee, a pipeline stage is deleted): only inside a foreign-key action — depth > 1 and running as
  -- the table owner — and only columns of ON DELETE SET NULL constraints turned to NULL whose referenced row is gone.
  IF TG_OP = 'UPDATE' AND depth > 1 AND current_user <> 'flowcom_app' THEN
    FOR k IN SELECT j.key FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(OLD)) j LOOP
      IF (pg_catalog.to_jsonb(NEW) -> k) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) -> k) THEN
        changed := changed + 1;
        SELECT c.confrelid::regclass AS parent, pa.attname AS pcol INTO fk
          FROM pg_catalog.pg_constraint c
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          JOIN pg_catalog.pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
         WHERE c.conrelid = TG_RELID AND c.contype = 'f' AND c.confdeltype = 'n' AND pg_catalog.array_length(c.conkey, 1) = 1 AND a.attname = k
         LIMIT 1;
        IF (pg_catalog.to_jsonb(NEW) ->> k) IS NOT NULL OR NOT FOUND THEN
          only_set_null := false;
        ELSE
          EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I::text = $1)', fk.parent, fk.pcol)
            INTO parent_alive USING (pg_catalog.to_jsonb(OLD) ->> k);
          IF parent_alive THEN only_set_null := false; END IF;
        END IF;
      END IF;
    END LOOP;
    IF changed > 0 AND only_set_null THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- audit_reset_purge()'s own DELETE (depth 1), never for the runtime role, never a foreign-key action it causes.
    IF current_user <> 'flowcom_app' AND depth = 1
       AND coalesce(pg_catalog.current_setting('hiqbah.audit_controlled', true), '') = 'reset-purge' THEN
      RETURN OLD;
    END IF;
    -- ON DELETE CASCADE: TG_ARGV = parent table, then (child column, parent column) pairs; the parent row must be gone.
    IF TG_NARGS >= 3 AND depth > 1 AND current_user <> 'flowcom_app' THEN
      i := 1;
      WHILE i + 1 <= TG_NARGS - 1 LOOP
        IF (pg_catalog.to_jsonb(OLD) ->> TG_ARGV[i]) IS NULL THEN cond := NULL; EXIT; END IF;
        cond := cond || CASE WHEN cond = '' THEN '' ELSE ' AND ' END
                || pg_catalog.format('%I::text = %L', TG_ARGV[i + 1], pg_catalog.to_jsonb(OLD) ->> TG_ARGV[i]);
        i := i + 2;
      END LOOP;
      IF cond IS NOT NULL AND cond <> '' THEN
        EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE %s)', TG_ARGV[0], cond) INTO parent_alive;
        IF NOT parent_alive THEN RETURN OLD; END IF;   -- the parent is being deleted: the cascade removes its history
      END IF;
    END IF;
  END IF;
  -- Throwaway test databases only: never when the runtime role is the session or the current user.
  IF session_user <> 'flowcom_app' AND current_user <> 'flowcom_app'
     AND coalesce(pg_catalog.current_setting('hiqbah.audit_purge', true), '') = 'test-cleanup' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD WHEN TG_OP = 'UPDATE' THEN NEW ELSE NULL END;
  END IF;
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY: % on % is not allowed (append-only audit record)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."SettingsAuditLog" FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."SettingsAuditLog" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."CommissionAuditLog" FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."CommissionAuditLog" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."CustomerCreditLog" FOR EACH ROW EXECUTE FUNCTION audit_append_only('Customer', 'customerId', 'id');
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."CustomerCreditLog" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."SalesQuoteAudit" FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."SalesQuoteAudit" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."WorkstationActionLog" FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."WorkstationActionLog" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."RoasterControlLog" FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."RoasterControlLog" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."QcCorrectionHistory" FOR EACH ROW EXECUTE FUNCTION audit_append_only('QcRecord', 'qcRecordId', 'id');
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."QcCorrectionHistory" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."OpportunityStageEvent" FOR EACH ROW EXECUTE FUNCTION audit_append_only('Opportunity', 'opportunityId', 'id');
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."OpportunityStageEvent" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."BatchSerialHistory" FOR EACH ROW EXECUTE FUNCTION audit_append_only('RoastingBatch', 'batchId', 'id');
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."BatchSerialHistory" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."EmailProviderEvent" FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."EmailProviderEvent" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
-- Consent evidence (PDPL) and commission corrections: append-only too; the consent's erasure (owner, DELETE of the MktConsent
-- row) and a deleted ledger entry still remove their history through the cascade.
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."MktConsentEvent" FOR EACH ROW EXECUTE FUNCTION audit_append_only('MktConsent', 'phone', 'phone', 'channel', 'channel');
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."MktConsentEvent" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public."CommissionLedgerCorrection" FOR EACH ROW EXECUTE FUNCTION audit_append_only('CommissionLedgerEntry', 'entryId', 'id');
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."CommissionLedgerCorrection" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
-- Four tables guarded since their own batch against row UPDATE / DELETE but not TRUNCATE: the statement guard as well.
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."FinAuditLog" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."HrAuditLog" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."HrLeaveLedger" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public."MktAuditLog" FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();

-- 3 ────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION audit_reset_purge(p_actor_id text, p_actor_name text, p_reason text)
RETURNS TABLE (credit_log integer, commission_log integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a integer; b integer; allowed boolean := false; e_role text; e_perms text;
BEGIN
  -- The actor: an ACTIVE employee who is the administrator or holds settings › reset / training_reset (the routes' gates).
  SELECT e."role", e."permissions" INTO e_role, e_perms FROM public."Employee" e WHERE e."id" = p_actor_id AND e."active";
  IF FOUND THEN
    allowed := e_role = 'admin';
    IF NOT allowed THEN
      BEGIN
        allowed := coalesce((e_perms::jsonb #>> '{settings,sub,reset}') = 'true' OR (e_perms::jsonb #>> '{settings,sub,training_reset}') = 'true', false);
      EXCEPTION WHEN others THEN allowed := false;
      END;
    END IF;
  END IF;
  IF NOT allowed THEN
    RAISE EXCEPTION 'AUDIT_RESET: the actor must be an active administrator or hold the reset permission' USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.length(pg_catalog.regexp_replace(coalesce(p_reason, ''), '\s', '', 'g')) < 5 THEN
    RAISE EXCEPTION 'AUDIT_RESET: a reason is required' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_catalog.set_config('hiqbah.audit_controlled', 'reset-purge', true);
  DELETE FROM public."CustomerCreditLog";
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM public."CommissionAuditLog" WHERE "customerId" IS NOT NULL;
  GET DIAGNOSTICS b = ROW_COUNT;
  PERFORM pg_catalog.set_config('hiqbah.audit_controlled', '', true);
  INSERT INTO public."SettingsAuditLog" ("id", "section", "action", "entityType", "entityId", "changed", "after", "reason", "actorId", "actorName")
  VALUES (pg_catalog.gen_random_uuid()::text, 'organisation', 'SETTINGS_UPDATED', 'AuditLog', 'reset', ARRAY['CustomerCreditLog', 'CommissionAuditLog'],
          pg_catalog.jsonb_build_object('customerCreditLog', a, 'commissionAuditLog', b, 'why', pg_catalog.left(pg_catalog.btrim(p_reason, E' \t\r\n'), 300)),
          'AUDIT_RESET_PURGE', p_actor_id, pg_catalog.left(coalesce(p_actor_name, ''), 120));
  credit_log := a; commission_log := b;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION audit_reset_purge(text, text, text) FROM PUBLIC;

-- 4 ────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION message_archive_erase_customer(p_customer text, p_actor_id text, p_actor_name text, p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."Employee" e WHERE e."id" = p_actor_id AND e."active" AND e."role" = 'admin') THEN
    RAISE EXCEPTION 'MESSAGE_ARCHIVE_ERASE: the actor must be an active administrator' USING ERRCODE = 'P0001';
  END IF;
  IF p_customer IS NULL OR NOT EXISTS (SELECT 1 FROM public."Customer" WHERE "id" = p_customer) THEN
    RAISE EXCEPTION 'MESSAGE_ARCHIVE_ERASE: no such customer' USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.length(pg_catalog.regexp_replace(coalesce(p_reason, ''), '\s', '', 'g')) < 5 THEN
    RAISE EXCEPTION 'MESSAGE_ARCHIVE_ERASE: a reason and the person are required' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public."Customer" WHERE "id" = p_customer AND "messageLegalHold") THEN
    RAISE EXCEPTION 'MESSAGE_ARCHIVE_LEGAL_HOLD: this customer''s messages are under a legal hold' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_catalog.set_config('hiqbah.message_archive_controlled', 'retention-or-erasure', true);
  DELETE FROM public."MessageArchive" WHERE "customerId" = p_customer;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_catalog.set_config('hiqbah.message_archive_controlled', '', true);
  INSERT INTO public."SettingsAuditLog" ("id", "section", "action", "entityType", "entityId", "changed", "after", "reason", "actorId", "actorName")
  VALUES (pg_catalog.gen_random_uuid()::text, 'automation', 'SETTINGS_UPDATED', 'Customer', p_customer, ARRAY['messageArchive'],
          pg_catalog.jsonb_build_object('erased', n, 'why', pg_catalog.left(pg_catalog.btrim(p_reason, E' \t\r\n'), 300)), 'MESSAGE_ARCHIVE_ERASURE', p_actor_id, pg_catalog.left(coalesce(p_actor_name, ''), 120));
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION message_archive_set_legal_hold(p_customer text, p_hold boolean, p_actor_id text, p_actor_name text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE was boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."Employee" e WHERE e."id" = p_actor_id AND e."active" AND e."role" = 'admin') THEN
    RAISE EXCEPTION 'MESSAGE_ARCHIVE_HOLD: the actor must be an active administrator' USING ERRCODE = 'P0001';
  END IF;
  IF p_hold IS NULL OR pg_catalog.length(pg_catalog.regexp_replace(coalesce(p_reason, ''), '\s', '', 'g')) < 5 THEN
    RAISE EXCEPTION 'MESSAGE_ARCHIVE_HOLD: the hold, the person and a reason are required' USING ERRCODE = 'P0001';
  END IF;
  SELECT c."messageLegalHold" INTO was FROM public."Customer" c WHERE c."id" = p_customer FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSAGE_ARCHIVE_HOLD: no such customer' USING ERRCODE = 'P0001'; END IF;
  IF was IS DISTINCT FROM p_hold THEN
    UPDATE public."Customer" SET "messageLegalHold" = p_hold, "messageLegalHoldAt" = CASE WHEN p_hold THEN pg_catalog.now() AT TIME ZONE 'UTC' END
     WHERE "id" = p_customer;
    INSERT INTO public."SettingsAuditLog" ("id", "section", "action", "entityType", "entityId", "changed", "before", "after", "reason", "actorId", "actorName")
    VALUES (pg_catalog.gen_random_uuid()::text, 'organisation', 'SETTINGS_UPDATED', 'Customer', p_customer, ARRAY['messageLegalHold'],
            pg_catalog.jsonb_build_object('messageLegalHold', was),
            pg_catalog.jsonb_build_object('messageLegalHold', p_hold, 'why', pg_catalog.left(pg_catalog.btrim(p_reason, E' \t\r\n'), 300)),
            CASE WHEN p_hold THEN 'CUSTOMER_LEGAL_HOLD_ON' ELSE 'CUSTOMER_LEGAL_HOLD_OFF' END, p_actor_id, pg_catalog.left(coalesce(p_actor_name, ''), 120));
  END IF;
  RETURN p_hold;
END $$;

-- 5 ────────────────────────────────────────────────────────────────────────────────────────────
-- message_archive_immutable() (batch 25b), gate G1: the controlled marker only for the controlled functions' own DELETE (depth 1);
-- the test setting never when the runtime role is the session or the current user (a foreign-key action runs as the owner).
CREATE OR REPLACE FUNCTION message_archive_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user <> 'flowcom_app' AND TG_OP = 'DELETE' AND pg_catalog.pg_trigger_depth() = 1
     AND coalesce(pg_catalog.current_setting('hiqbah.message_archive_controlled', true), '') = 'retention-or-erasure' THEN
    RETURN OLD;
  END IF;
  IF session_user <> 'flowcom_app' AND current_user <> 'flowcom_app'
     AND coalesce(pg_catalog.current_setting('hiqbah.audit_purge', true), '') = 'test-cleanup' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD WHEN TG_OP = 'UPDATE' THEN NEW ELSE NULL END;
  END IF;
  RAISE EXCEPTION 'MESSAGE_ARCHIVE_IMMUTABLE: archived messages are never changed or deleted (%)', TG_OP USING ERRCODE = 'P0001';
END $$;

-- 2 ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    FOREACH t IN ARRAY ARRAY['SettingsAuditLog', 'CommissionAuditLog', 'CustomerCreditLog', 'SalesQuoteAudit', 'WorkstationActionLog',
                             'RoasterControlLog', 'QcCorrectionHistory', 'OpportunityStageEvent', 'BatchSerialHistory', 'EmailProviderEvent',
                             'AccountingAuditLog', 'CuppingAuditLog', 'FinAuditLog', 'HrAuditLog', 'HrLeaveLedger', 'MktAuditLog', 'PrintAuditLog',
                             'ZatcaLog', 'WorkTaskEvent', 'AuthAuditLog', 'MessageArchive', 'MktConsentEvent', 'CommissionLedgerCorrection'] LOOP
      EXECUTE pg_catalog.format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM flowcom_app', t);
      EXECUTE pg_catalog.format('GRANT SELECT, INSERT ON public.%I TO flowcom_app', t);
    END LOOP;
    -- audit_reset_purge(): NOT granted here (gate G3) — grant-app-runtime.sql -v allow_reset=1 on training / demo databases only.
  END IF;
END $$;

COMMIT;
