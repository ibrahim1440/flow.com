-- Batch 25b, the e-mail follow-ups (owner decisions 31 Oct 2026). Additive, plus the archive guard narrowed:
--   1. "Customer"."messageLegalHold" / "messageLegalHoldAt": a per-customer legal hold (the administrator sets it). While it is
--      on, nothing of that customer's archived messages is ever destroyed — neither by the 5-year retention nor by an erasure.
--   2. message_archive_purge_expired(p_limit): the ONLY retention path. Destroys at most p_limit archived messages created
--      more than FIVE YEARS ago (the cutoff is fixed inside the function, not a parameter), skipping customers on legal
--      hold, and writes ONE "SettingsAuditLog" row for the batch (count and date range — never the content).
--   3. message_archive_erase_customer(p_customer, p_actor_id, p_actor_name, p_reason): the data-subject erasure of one
--      customer's archived messages. Refuses a customer on legal hold, needs a reason of at least 5 characters, and
--      writes ONE audit row (count, actor, reason).
--   3b. message_archive_set_legal_hold(p_customer, p_hold, p_actor_id, p_actor_name, p_reason): the ONLY way to set or lift
--      a legal hold (gate D2): the runtime role holds no UPDATE on the two hold columns (column grants), and the function
--      writes the audit row itself.
--      All three are SECURITY DEFINER (owned by the migrate role) with search_path = pg_catalog, public, pg_temp (pg_temp
--      LAST) and every relation schema-qualified as public."…" (gate D1: a temporary table can never stand in for one), EXECUTE
--      revoked from PUBLIC and granted to the runtime role only; the runtime role still holds no UPDATE / DELETE on
--      "MessageArchive". The two deleting ones set a transaction-local marker the guard honours for their DELETE, then clear it.
--   4. message_archive_immutable() narrowed: a DELETE passes ONLY under that marker (outside the runtime role); UPDATE and
--      TRUNCATE never (the test databases' provisioning cleanup excepted, as before). The former manual
--      "hiqbah.message_archive_purge = admin-purge-confirmed" path is removed.
--   5. customer_legal_hold_guard (trigger on "Customer"): a held customer cannot be deleted or have its id changed (gate F1).
-- Rollback: docs/hr/migration-review/rollback-20261208090000_email_followups.sql. Verifier check 81.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1 ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Customer" ADD COLUMN "messageLegalHold"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Customer" ADD COLUMN "messageLegalHoldAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_message_legal_hold_check" CHECK (
  NOT "messageLegalHold" OR "messageLegalHoldAt" IS NOT NULL
) NOT VALID;
ALTER TABLE "Customer" VALIDATE CONSTRAINT "Customer_message_legal_hold_check";

-- 4 ────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION message_archive_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'flowcom_app' AND TG_OP = 'DELETE'
     AND coalesce(current_setting('hiqbah.message_archive_controlled', true), '') = 'retention-or-erasure' THEN
    RETURN OLD;
  END IF;
  IF current_user <> 'flowcom_app' AND coalesce(current_setting('hiqbah.audit_purge', true), '') = 'test-cleanup' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD WHEN TG_OP = 'UPDATE' THEN NEW ELSE NULL END;
  END IF;
  RAISE EXCEPTION 'MESSAGE_ARCHIVE_IMMUTABLE: archived messages are never changed or deleted (%)', TG_OP USING ERRCODE = 'P0001';
END $$;

-- 1b ───────────────────────────────────────────────────────────────────────────────────────────
-- Gate F1: a customer on legal hold can neither be deleted nor re-keyed (its archived messages are tied to the id), so the
-- hold cannot be side-stepped by removing or renaming the row it sits on. Lift the hold first (audited).
CREATE FUNCTION customer_legal_hold_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."messageLegalHold" AND (TG_OP = 'DELETE' OR NEW."id" IS DISTINCT FROM OLD."id") THEN
    RAISE EXCEPTION 'CUSTOMER_LEGAL_HOLD: this customer is under a legal hold and cannot be deleted or re-keyed (%)', TG_OP USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER customer_legal_hold_guard BEFORE DELETE OR UPDATE OF "id" ON public."Customer"
  FOR EACH ROW EXECUTE FUNCTION customer_legal_hold_guard();

-- 2 ────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION message_archive_purge_expired(p_limit integer)
RETURNS TABLE (purged integer, oldest timestamp, newest timestamp)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cutoff timestamp := (pg_catalog.now() AT TIME ZONE 'UTC') - interval '5 years';
  n integer; lo timestamp; hi timestamp;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'MESSAGE_ARCHIVE_PURGE: the batch size must be 1..5000' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_catalog.set_config('hiqbah.message_archive_controlled', 'retention-or-erasure', true);
  WITH gone AS (
    DELETE FROM public."MessageArchive" a
     WHERE a."id" IN (SELECT m."id" FROM public."MessageArchive" m
                       WHERE m."messageCreatedAt" < cutoff
                         AND NOT EXISTS (SELECT 1 FROM public."Customer" c WHERE c."id" = m."customerId" AND c."messageLegalHold")
                       ORDER BY m."messageCreatedAt", m."id" LIMIT p_limit FOR UPDATE SKIP LOCKED)
    RETURNING a."messageCreatedAt")
  SELECT count(*)::integer, min("messageCreatedAt"), max("messageCreatedAt") INTO n, lo, hi FROM gone;
  PERFORM pg_catalog.set_config('hiqbah.message_archive_controlled', '', true);
  IF n > 0 THEN
    INSERT INTO public."SettingsAuditLog" ("id", "section", "action", "entityType", "entityId", "changed", "after", "reason", "actorId", "actorName")
    VALUES (pg_catalog.gen_random_uuid()::text, 'automation', 'SETTINGS_UPDATED', 'MessageArchive', 'retention', ARRAY['purged'],
            pg_catalog.jsonb_build_object('count', n, 'oldest', lo, 'newest', hi, 'cutoff', cutoff),
            'MESSAGE_ARCHIVE_RETENTION_PURGE', 'message-archive-job', 'حذف الأرشيف بعد 5 سنوات');
  END IF;
  purged := n; oldest := lo; newest := hi;
  RETURN NEXT;
END $$;

-- 3 ────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION message_archive_erase_customer(p_customer text, p_actor_id text, p_actor_name text, p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_customer IS NULL OR NOT EXISTS (SELECT 1 FROM public."Customer" WHERE "id" = p_customer) THEN
    RAISE EXCEPTION 'MESSAGE_ARCHIVE_ERASE: no such customer' USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.length(pg_catalog.regexp_replace(coalesce(p_reason, ''), '\s', '', 'g')) < 5 OR p_actor_id IS NULL THEN
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

-- 3b ───────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION message_archive_set_legal_hold(p_customer text, p_hold boolean, p_actor_id text, p_actor_name text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE was boolean;
BEGIN
  IF p_hold IS NULL OR p_actor_id IS NULL OR pg_catalog.length(pg_catalog.regexp_replace(coalesce(p_reason, ''), '\s', '', 'g')) < 5 THEN
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

REVOKE ALL ON FUNCTION message_archive_purge_expired(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION message_archive_erase_customer(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION message_archive_set_legal_hold(text, boolean, text, text, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT EXECUTE ON FUNCTION message_archive_purge_expired(integer) TO flowcom_app;
    GRANT EXECUTE ON FUNCTION message_archive_erase_customer(text, text, text, text) TO flowcom_app;
    GRANT EXECUTE ON FUNCTION message_archive_set_legal_hold(text, boolean, text, text, text) TO flowcom_app;
    -- Gate D2 / F1: the runtime role never writes the hold columns nor the id — table UPDATE is replaced by every other column.
    REVOKE UPDATE ON "Customer" FROM flowcom_app;
    EXECUTE (SELECT format('GRANT UPDATE (%s) ON "Customer" TO flowcom_app', string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum))
               FROM pg_attribute a WHERE a.attrelid = '"Customer"'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                AND a.attname NOT IN ('id', 'messageLegalHold', 'messageLegalHoldAt'));
  END IF;
END $$;

COMMIT;
