-- Privileges of the accounting runtime role: the same shape as production's erp_app
-- (docs/finance/RELEASE-20260927.md §1e) — DML only. No TRUNCATE, TRIGGER, REFERENCES, DDL,
-- ownership or role membership, so the database triggers that enforce the ledger rules cannot be
-- disabled or bypassed by the application.
--
-- Run as the database OWNER after migrations, on a disposable/test database. The role itself is
-- created beforehand WITHOUT this script (Neon console, or locally with a generated password), so no
-- password passes through SQL files or tool output.
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO accounting_app', current_database()); END $$;
GRANT USAGE ON SCHEMA public TO accounting_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO accounting_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO accounting_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO accounting_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO accounting_app;
