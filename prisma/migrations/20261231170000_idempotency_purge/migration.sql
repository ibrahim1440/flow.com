-- 20261231170000_idempotency_purge — R1-b gate L1: the stored answers of keyed writes ("IdempotencyRequest") expire.
--   idempotency_purge(keep_days integer DEFAULT 7): deletes the rows created more than keep_days days ago and returns how
--   many. The runtime role holds no DELETE on the table (checks 16 / 103: an answer is never deleted by the application
--   while a retry may still need it), so the clean-up is this one narrow SECURITY DEFINER function: it can only remove
--   rows older than at least one day, nothing else. The scheduled job that calls it is R1-d.
-- Additive: one new function, EXECUTE for the runtime role when it exists. No existing row is read or written.
BEGIN;

CREATE OR REPLACE FUNCTION idempotency_purge(keep_days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF keep_days IS NULL OR keep_days < 1 THEN
    RAISE EXCEPTION 'idempotency_purge: keep_days must be at least 1 (got %)', keep_days;
  END IF;
  DELETE FROM public."IdempotencyRequest" WHERE "createdAt" < pg_catalog.now() - pg_catalog.make_interval(days => keep_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION idempotency_purge(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT EXECUTE ON FUNCTION idempotency_purge(integer) TO flowcom_app;
  END IF;
END $$;

COMMIT;
