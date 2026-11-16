-- 20261231180000_cron_runs — R1-d (owner 5-ب): every scheduled job run is recorded, and a job never runs twice at once.
--   "CronRun": one row per run of a job (dispatch, zatca-reporting, marketing, the daily jobs …) — who started it (the
--   GitHub schedule, Vercel Cron, a person), when it started and finished, OK / FAILED / SKIPPED, a counts-only summary
--   and a short error. The partial UNIQUE index on (job) WHERE status = 'RUNNING' is the per-job lock: a second start
--   while one runs fails on it and is recorded as SKIPPED (the GitHub schedule and the Vercel backup may overlap).
--   The watchdog reads the last OK per job for the «did not run on time» alert.
-- Additive: one new table and its indexes; guarded GRANT to the runtime role. No existing row is read or written.
BEGIN;

CREATE TABLE "CronRun" (
  "id"         TEXT NOT NULL,
  "job"        TEXT NOT NULL,
  "trigger"    TEXT NOT NULL,
  "status"     TEXT NOT NULL DEFAULT 'RUNNING',
  "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "summary"    JSONB,
  "error"      TEXT,
  CONSTRAINT "CronRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CronRun_job_check" CHECK ("job" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  CONSTRAINT "CronRun_trigger_check" CHECK ("trigger" IN ('github', 'vercel', 'manual')),
  CONSTRAINT "CronRun_status_check" CHECK ("status" IN ('RUNNING', 'OK', 'FAILED', 'SKIPPED')),
  CONSTRAINT "CronRun_finished_check" CHECK (("status" = 'RUNNING') = ("finishedAt" IS NULL)),
  CONSTRAINT "CronRun_error_check" CHECK ("error" IS NULL OR length("error") <= 500)
);
CREATE UNIQUE INDEX "CronRun_one_running_key" ON "CronRun" ("job") WHERE "status" = 'RUNNING';
CREATE INDEX "CronRun_job_startedAt_idx" ON "CronRun" ("job", "startedAt");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "CronRun" TO flowcom_app;
  END IF;
END $$;

COMMIT;
