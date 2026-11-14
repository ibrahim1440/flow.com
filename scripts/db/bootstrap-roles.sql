-- R1-a (owner decision 4-أ): the roles the migration chain GRANTs to, for a NEW, EMPTY database.
--
-- 20261215090000_sales_plans says `GRANT … TO flowcom_app` without the `IF EXISTS (SELECT 1 FROM pg_roles …)` guard
-- every other migration carries. Production has the role, so it applied there; on a database that has never had it
-- (CI, a fresh local cluster, an empty Neon branch) the whole chain stops at that migration. An applied migration is
-- never edited (its checksum is recorded on live), so the role is made BEFORE the chain instead.
--
-- Idempotent, creates nothing that exists, grants nothing: NOLOGIN, no password — a runtime role is given LOGIN and a
-- password by an operator (scripts/release/grant-app-runtime.sql), never here. Run by scripts/migrate-deploy.mjs only
-- when the target has no applied migration yet; harmless to run by hand on any database. pg_catalog is named, so a
-- search_path cannot point the check at another pg_roles.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'flowcom_app') THEN
    CREATE ROLE flowcom_app NOLOGIN;
  END IF;
END
$$;
