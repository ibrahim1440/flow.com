-- 20261228090000_roast_problem_minor — roasting station reports, owner-approved design D16 (9 Nov 2026):
--   1. "RoastStationEvent"."blocking": a report stops charging (true — every existing report, the default) or is a minor
--      problem the roaster keeps roasting through (false: «متابعة التحميص · مشكلة بسيطة»). A PAUSE always stops (CHECK).
--   2. "RoastStationEvent"."resolveCause" / "resolveFix": «إيش كانت المشكلة؟» / «إيش الحل؟», written when the report is
--      ended (required by the service for every report but a PAUSE; ≤ 500 characters each, CHECK).
--   3. "RoastRun"."problemId": a roast charged while a minor report was open on its roaster — the mark the station, the
--      lot and QC show. ON DELETE SET NULL (a report is never deleted; the link never blocks anything).
-- Additive: one NOT NULL column with a constant default (no rewrite; every existing report = blocking, as it behaved),
-- three nullable columns, two CHECKs, one FK, one partial index. No data is written. The runtime role holds table-level
-- rights on both tables (20261223090000_roast_station_v2); if it ever works column by column there, the new columns are
-- granted too (the guarded grant below, as 20261226090000_sales_plan_internal). Check 94 asserts the privilege.
-- Rollback: docs/hr/migration-review/rollback-20261228090000_roast_problem_minor.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "RoastStationEvent" ADD COLUMN IF NOT EXISTS "blocking" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "RoastStationEvent" ADD COLUMN IF NOT EXISTS "resolveCause" TEXT;
ALTER TABLE "RoastStationEvent" ADD COLUMN IF NOT EXISTS "resolveFix" TEXT;
ALTER TABLE "RoastRun" ADD COLUMN IF NOT EXISTS "problemId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RoastStationEvent_pause_blocks_check') THEN
    ALTER TABLE "RoastStationEvent" ADD CONSTRAINT "RoastStationEvent_pause_blocks_check" CHECK ("kind" <> 'PAUSE' OR "blocking");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RoastStationEvent_resolve_text_check') THEN
    ALTER TABLE "RoastStationEvent" ADD CONSTRAINT "RoastStationEvent_resolve_text_check"
      CHECK (coalesce(length("resolveCause"), 0) <= 500 AND coalesce(length("resolveFix"), 0) <= 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RoastRun_problemId_fkey') THEN
    ALTER TABLE "RoastRun" ADD CONSTRAINT "RoastRun_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "RoastStationEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_name = 'RoastStationEvent' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_name = 'RoastStationEvent' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
      GRANT UPDATE ("blocking", "resolveCause", "resolveFix") ON "RoastStationEvent" TO flowcom_app;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_name = 'RoastRun' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_name = 'RoastRun' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
      GRANT UPDATE ("problemId") ON "RoastRun" TO flowcom_app;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "RoastRun_problemId_idx" ON "RoastRun" ("problemId") WHERE "problemId" IS NOT NULL;

COMMIT;
