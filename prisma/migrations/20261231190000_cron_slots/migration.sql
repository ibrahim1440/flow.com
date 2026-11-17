-- 20261231190000_cron_slots — R1-e (owner decision 25 = أ): a scheduled job runs at most once per period, decided by the
-- database, whoever calls it (cron-job.org through the GitHub workflow, GitHub's fallback schedule, Vercel's daily cron,
-- a person's «شغّل الآن»).
--   "CronRun"."slotKey": the job's period (the UTC hour "2030-03-10T10" for marketing, the Riyadh day "2030-03-10" for the
--   daily jobs; NULL for the queue drains, which run on every call). The partial UNIQUE index (job, slotKey) over the
--   RUNNING and OK rows makes the INSERT that starts a run the decision: a second start in the same period — at the same
--   moment or later — fails on it and is recorded SKIPPED; a FAILED run leaves the index, so the period can be retried.
--   "externalRunId" / "externalRunAttempt" / "source": the GitHub run that called (run_id, run_attempt) and who started
--   it (cron-job.org, schedule, …) — the link from cron-job.org's log to GitHub's run to this row.
--   "CommissionLedgerEntry": the year-end credit-note clawback writes at most one line per (person, credit note) —
--   a UNIQUE index on the marker its reason starts with (it was a check in the code under a per-note lock).
-- Additive: three columns (NULL for existing rows), two partial UNIQUE indexes; no existing row is changed. The
-- clawback index is refused (nothing applied) if the ledger already holds a duplicate — it never deletes one.
BEGIN;

ALTER TABLE "CronRun"
  ADD COLUMN "slotKey" TEXT,
  ADD COLUMN "externalRunId" TEXT,
  ADD COLUMN "externalRunAttempt" INTEGER,
  ADD COLUMN "source" TEXT,
  ADD CONSTRAINT "CronRun_slotKey_check" CHECK ("slotKey" IS NULL OR "slotKey" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2})?$'),
  ADD CONSTRAINT "CronRun_externalRunId_check" CHECK ("externalRunId" IS NULL OR "externalRunId" ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT "CronRun_externalRunAttempt_check" CHECK ("externalRunAttempt" IS NULL OR "externalRunAttempt" BETWEEN 1 AND 9999),
  ADD CONSTRAINT "CronRun_source_check" CHECK ("source" IS NULL OR "source" ~ '^[a-z0-9][a-z0-9._-]{0,39}$');

CREATE UNIQUE INDEX "CronRun_slot_key" ON "CronRun" ("job", "slotKey")
  WHERE "status" IN ('RUNNING', 'OK') AND "slotKey" IS NOT NULL;
CREATE INDEX "CronRun_externalRunId_idx" ON "CronRun" ("externalRunId") WHERE "externalRunId" IS NOT NULL;

DO $$
DECLARE dup integer;
BEGIN
  SELECT count(*) INTO dup FROM (
    SELECT 1 FROM "CommissionLedgerEntry"
     WHERE "type" = 'ADJUSTMENT' AND "reason" LIKE 'CREDIT\_NOTE\_CLAWBACK:%'
     GROUP BY "employeeId", substring("reason" from '^CREDIT_NOTE_CLAWBACK:[^:]+:')
    HAVING count(*) > 1) d;
  IF dup > 0 THEN
    RAISE EXCEPTION '20261231190000_cron_slots: % (person, credit note) pair(s) already hold more than one clawback line — resolve them first; nothing was applied', dup;
  END IF;
END $$;
CREATE UNIQUE INDEX "CommissionLedgerEntry_clawback_key" ON "CommissionLedgerEntry" ("employeeId", (substring("reason" from '^CREDIT_NOTE_CLAWBACK:[^:]+:')))
  WHERE "type" = 'ADJUSTMENT' AND "reason" LIKE 'CREDIT\_NOTE\_CLAWBACK:%';

COMMIT;
