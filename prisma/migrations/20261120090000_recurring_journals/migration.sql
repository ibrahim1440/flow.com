-- «القيود السهلة» and «المعاملات المتكررة» (feat/recurring-journals, Qoyod parity phase 4 items 1 and 2; the accounting
-- council's design). ADDITIVE ONLY, one transaction (PostgreSQL 16 / 17). Four new, empty tables — nothing existing is
-- altered, so no row is rewritten and no existing trigger fires:
--
--   1. "JournalTemplate" / "JournalTemplateLine" — a reusable journal: name, description, an amount mode (FIXED: each
--      line an amount; PERCENT: each line a percentage of a total entered at use time), lines (account, side D / C,
--      amount or percentage, optional branch / cost centre / party, memo). BALANCE IN THE DATABASE (deferred, at commit:
--      journal_template_balanced): ≥ 2 lines, a debit and a credit line, every line of the template's mode, and
--      Σ debit = Σ credit (FIXED) or the percentages of each side = 100 exactly (PERCENT). A template is deleted only
--      while no recurring transaction names it (FK RESTRICT); otherwise it is archived. Using a template creates an
--      ordinary manual journal DRAFT through the existing journal service — every journal rule applies there.
--   2. "RecurringSchedule" — «معاملة متكررة»: a reference (REC-000001), a name, the kind (JOURNAL | SALES_INVOICE), the
--      source (a TEMPLATE, a copied JOURNAL, or a copied SALES_INVOICE) frozen as "payload" when saved, the rule
--      (DAILY / WEEKLY / MONTHLY / YEARLY, an interval, a start date, an end date and / or an occurrence count), the
--      next occurrence (index + date), a status (ACTIVE / PAUSED with its reason / COMPLETED / CANCELLED) and the
--      auto-post setting — JOURNALS ONLY, and only with the name and time of who authorised it, and whether that was a
--      self-authorisation the SoD setting allowed ("autoPostSodBypass") (CHECKs). Never deleted (its runs are the
--      history): recurring_no_delete.
--   3. "RecurringRun" — one row per (schedule, due date): THE RUN KEY, UNIQUE, so a re-run, a retry or two runners at
--      once never make a document twice. CREATED (a draft journal or a draft sales invoice), POSTED (an auto-posted
--      journal), SKIPPED (accounting not active / before the go-live date — the engine's skipped-entry pattern) or
--      FAILED (the refusal's code and message; retried in place). Each run SNAPSHOTS at its first attempt what it makes
--      ("payload") and its auto-post authorisation (who, and whether it was a self-authorisation), so a retry makes exactly
--      that, whatever the schedule became since (auto-post may only be withdrawn). A run that made a document — or was
--      skipped — is final: recurring_run_guard refuses any change to it, and to any run's key; runs are never deleted.
--      An auto-posted run's journal is an ordinary MANUAL journal posted through the journal service (the manual-journal
--      reviews, the SoD exceptions and the auditor's filters see it); a self-authorisation is carried as its sodBypass.
--   4. The audit trail: ledger_audit_row on the four tables (who, when, before / after, IP, device → "AccountingAuditLog");
--      ledger_no_truncate on the schedules and runs (as the other books tables).
--   5. The runtime role (flowcom_app), when it exists, is granted the tables, the reference sequence and the functions.
-- Rollback: docs/hr/migration-review/rollback-20261120090000_recurring_journals.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "JournalTemplate" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "name" TEXT NOT NULL,
  "description" TEXT,
  "amountMode" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "archivedAt" TIMESTAMP(3),
  "archivedBy" TEXT,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JournalTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JournalTemplate_mode_check" CHECK ("amountMode" IN ('FIXED', 'PERCENT')),
  CONSTRAINT "JournalTemplate_text_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120 AND ("description" IS NULL OR length("description") <= 500)),
  CONSTRAINT "JournalTemplate_archive_check" CHECK ("isActive" = ("archivedAt" IS NULL))
);
CREATE INDEX "JournalTemplate_tenantId_isActive_idx" ON "JournalTemplate"("tenantId", "isActive");

CREATE TABLE "JournalTemplateLine" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "templateId" TEXT NOT NULL,
  "lineNo" INTEGER NOT NULL,
  "accountId" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "amount" DECIMAL(18,2),
  "percent" DECIMAL(7,4),
  "description" TEXT,
  "branchId" TEXT,
  "costCenterId" TEXT,
  "partyType" TEXT,
  "partyId" TEXT,
  CONSTRAINT "JournalTemplateLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JournalTemplateLine_side_check" CHECK ("side" IN ('D', 'C')),
  CONSTRAINT "JournalTemplateLine_value_check" CHECK (("amount" IS NULL) <> ("percent" IS NULL)
    AND ("amount" IS NULL OR "amount" > 0) AND ("percent" IS NULL OR ("percent" > 0 AND "percent" <= 100))),
  CONSTRAINT "JournalTemplateLine_party_check" CHECK ((("partyType" IS NULL) = ("partyId" IS NULL)) AND ("partyType" IS NULL OR "partyType" IN ('CUSTOMER', 'SUPPLIER', 'EMPLOYEE'))),
  CONSTRAINT "JournalTemplateLine_text_check" CHECK ("description" IS NULL OR length("description") <= 500),
  CONSTRAINT "JournalTemplateLine_lineNo_check" CHECK ("lineNo" >= 1)
);
CREATE UNIQUE INDEX "JournalTemplateLine_templateId_lineNo_key" ON "JournalTemplateLine"("templateId", "lineNo");
CREATE INDEX "JournalTemplateLine_accountId_idx" ON "JournalTemplateLine"("accountId");
ALTER TABLE "JournalTemplateLine" ADD CONSTRAINT "JournalTemplateLine_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "JournalTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JournalTemplateLine" ADD CONSTRAINT "JournalTemplateLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The template balances, checked at COMMIT (the lines are replaced as a whole when it is edited).
CREATE OR REPLACE FUNCTION journal_template_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid text; m text; t RECORD;
BEGIN
  IF TG_TABLE_NAME = 'JournalTemplateLine' THEN
    tid := CASE WHEN TG_OP = 'DELETE' THEN OLD."templateId" ELSE NEW."templateId" END;
  ELSE
    tid := NEW."id";
  END IF;
  SELECT jt."amountMode" INTO m FROM "JournalTemplate" jt WHERE jt."id" = tid;
  IF NOT FOUND THEN
    RETURN NULL; -- the template itself was deleted (its lines cascade)
  END IF;
  SELECT count(*) AS n,
         count(*) FILTER (WHERE l."side" = 'D') AS nd, count(*) FILTER (WHERE l."side" = 'C') AS nc,
         count(*) FILTER (WHERE (m = 'FIXED' AND l."amount" IS NULL) OR (m = 'PERCENT' AND l."percent" IS NULL)) AS wrong,
         coalesce(sum(l."amount") FILTER (WHERE l."side" = 'D'), 0) AS ad, coalesce(sum(l."amount") FILTER (WHERE l."side" = 'C'), 0) AS ac,
         coalesce(sum(l."percent") FILTER (WHERE l."side" = 'D'), 0) AS pd, coalesce(sum(l."percent") FILTER (WHERE l."side" = 'C'), 0) AS pc
    INTO t FROM "JournalTemplateLine" l WHERE l."templateId" = tid;
  IF t.n < 2 OR t.nd = 0 OR t.nc = 0 OR t.wrong > 0 THEN
    RAISE EXCEPTION 'JOURNAL_TEMPLATE: a template has at least two lines, a debit and a credit line, each of the template''s amount mode' USING ERRCODE = 'check_violation';
  END IF;
  IF m = 'FIXED' AND t.ad <> t.ac THEN
    RAISE EXCEPTION 'JOURNAL_TEMPLATE: a fixed template balances (debit % = credit %)', t.ad, t.ac USING ERRCODE = 'check_violation';
  END IF;
  IF m = 'PERCENT' AND (t.pd <> 100 OR t.pc <> 100) THEN
    RAISE EXCEPTION 'JOURNAL_TEMPLATE: the percentages of each side sum to 100 (debit %, credit %)', t.pd, t.pc USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_template_balanced AFTER INSERT OR UPDATE ON "JournalTemplate"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_template_balanced();
CREATE CONSTRAINT TRIGGER journal_template_balanced AFTER INSERT OR UPDATE OR DELETE ON "JournalTemplateLine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_template_balanced();

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "RecurringSchedule" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "refNo" SERIAL NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "kind" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "templateId" TEXT,
  "sourceEntryId" TEXT,
  "sourceInvoiceId" TEXT,
  "totalAmount" DECIMAL(18,2),
  "payload" JSONB NOT NULL,
  "frequency" TEXT NOT NULL,
  "interval" INTEGER NOT NULL DEFAULT 1,
  "startDate" DATE NOT NULL,
  "endDate" DATE,
  "maxOccurrences" INTEGER,
  "nextIndex" INTEGER NOT NULL DEFAULT 0,
  "nextRunDate" DATE,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "autoPost" BOOLEAN NOT NULL DEFAULT false,
  "autoPostApprovedBy" TEXT,
  "autoPostApprovedAt" TIMESTAMP(3),
  "autoPostSodBypass" BOOLEAN NOT NULL DEFAULT false,
  "pausedAt" TIMESTAMP(3),
  "pausedBy" TEXT,
  "pauseReason" TEXT,
  "lastRunAt" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecurringSchedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecurringSchedule_kind_check" CHECK (("kind" = 'JOURNAL' AND "sourceType" IN ('TEMPLATE', 'JOURNAL')) OR ("kind" = 'SALES_INVOICE' AND "sourceType" = 'SALES_INVOICE')),
  CONSTRAINT "RecurringSchedule_source_check" CHECK (("sourceType" <> 'TEMPLATE' OR "templateId" IS NOT NULL) AND ("sourceType" <> 'JOURNAL' OR "sourceEntryId" IS NOT NULL)
    AND ("sourceType" <> 'SALES_INVOICE' OR "sourceInvoiceId" IS NOT NULL) AND ("totalAmount" IS NULL OR "totalAmount" > 0) AND jsonb_typeof("payload") = 'object'),
  CONSTRAINT "RecurringSchedule_rule_check" CHECK ("frequency" IN ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') AND "interval" BETWEEN 1 AND 366
    AND ("endDate" IS NULL OR "endDate" >= "startDate") AND ("maxOccurrences" IS NULL OR "maxOccurrences" BETWEEN 1 AND 3660)
    AND "nextIndex" >= 0 AND ("maxOccurrences" IS NULL OR "nextIndex" <= "maxOccurrences") AND ("nextRunDate" IS NULL OR "nextRunDate" >= "startDate")),
  CONSTRAINT "RecurringSchedule_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED')
    AND ("status" <> 'ACTIVE' OR "nextRunDate" IS NOT NULL) AND ("status" NOT IN ('COMPLETED', 'CANCELLED') OR "nextRunDate" IS NULL)
    AND (("status" = 'PAUSED') = ("pausedAt" IS NOT NULL))
    AND ("pauseReason" IS NULL OR ("status" = 'PAUSED' AND length("pauseReason") <= 500))),
  CONSTRAINT "RecurringSchedule_autopost_check" CHECK ((NOT "autoPost" OR ("kind" = 'JOURNAL' AND "autoPostApprovedBy" IS NOT NULL AND "autoPostApprovedAt" IS NOT NULL))
    AND (NOT "autoPostSodBypass" OR "autoPost")),
  CONSTRAINT "RecurringSchedule_text_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120 AND ("description" IS NULL OR length("description") <= 500))
);
CREATE UNIQUE INDEX "RecurringSchedule_refNo_key" ON "RecurringSchedule"("refNo");
CREATE INDEX "RecurringSchedule_status_nextRunDate_idx" ON "RecurringSchedule"("status", "nextRunDate");
CREATE INDEX "RecurringSchedule_kind_status_idx" ON "RecurringSchedule"("kind", "status");
CREATE INDEX "RecurringSchedule_templateId_idx" ON "RecurringSchedule"("templateId");
ALTER TABLE "RecurringSchedule" ADD CONSTRAINT "RecurringSchedule_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "JournalTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "RecurringRun" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "scheduleId" TEXT NOT NULL,
  "occurrenceIndex" INTEGER NOT NULL,
  "dueDate" DATE NOT NULL,
  "status" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "autoPost" BOOLEAN NOT NULL DEFAULT false,
  "autoPostBy" TEXT,
  "autoPostSodBypass" BOOLEAN NOT NULL DEFAULT false,
  "journalEntryId" TEXT,
  "salesInvoiceId" TEXT,
  "skipReason" TEXT,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "trigger" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecurringRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecurringRun_status_check" CHECK (
    ("status" = 'CREATED' AND (("journalEntryId" IS NOT NULL) <> ("salesInvoiceId" IS NOT NULL)) AND "skipReason" IS NULL AND "errorCode" IS NULL)
    OR ("status" = 'POSTED' AND "journalEntryId" IS NOT NULL AND "salesInvoiceId" IS NULL AND "skipReason" IS NULL AND "errorCode" IS NULL)
    OR ("status" = 'SKIPPED' AND "journalEntryId" IS NULL AND "salesInvoiceId" IS NULL AND "skipReason" IN ('NOT_ACTIVE', 'BEFORE_GO_LIVE') AND "errorCode" IS NULL)
    OR ("status" = 'FAILED' AND "journalEntryId" IS NULL AND "salesInvoiceId" IS NULL AND "skipReason" IS NULL AND "errorCode" IS NOT NULL)),
  CONSTRAINT "RecurringRun_meta_check" CHECK ("trigger" IN ('CRON', 'MANUAL', 'RETRY') AND "attempts" >= 1 AND "occurrenceIndex" >= 0
    AND ("errorMessage" IS NULL OR length("errorMessage") <= 1000)),
  CONSTRAINT "RecurringRun_snapshot_check" CHECK (jsonb_typeof("payload") = 'object' AND (NOT "autoPost" OR "autoPostBy" IS NOT NULL)
    AND (NOT "autoPostSodBypass" OR "autoPost") AND ("status" <> 'POSTED' OR "autoPost"))
);
-- THE RUN KEY: one run per (schedule, due date). (The occurrence index is not unique: an edited rule renumbers the
-- occurrences after the last run, and a date that already has a run is never made again.)
CREATE UNIQUE INDEX "RecurringRun_scheduleId_dueDate_key" ON "RecurringRun"("scheduleId", "dueDate");
CREATE INDEX "RecurringRun_status_idx" ON "RecurringRun"("status");
CREATE INDEX "RecurringRun_journalEntryId_idx" ON "RecurringRun"("journalEntryId");
CREATE INDEX "RecurringRun_salesInvoiceId_idx" ON "RecurringRun"("salesInvoiceId");
ALTER TABLE "RecurringRun" ADD CONSTRAINT "RecurringRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "RecurringSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION recurring_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'RECURRING_KEPT: a recurring transaction and its runs are never deleted (cancel the transaction instead)' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER recurring_no_delete BEFORE DELETE ON "RecurringSchedule" FOR EACH ROW EXECUTE FUNCTION recurring_no_delete();
CREATE TRIGGER recurring_no_delete BEFORE DELETE ON "RecurringRun" FOR EACH ROW EXECUTE FUNCTION recurring_no_delete();

-- A run's key never changes; a run that made its document (or was skipped) is final; a FAILED run is retried in place.
CREATE OR REPLACE FUNCTION recurring_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."scheduleId" <> OLD."scheduleId" OR NEW."dueDate" <> OLD."dueDate" OR NEW."occurrenceIndex" <> OLD."occurrenceIndex" THEN
    RAISE EXCEPTION 'RECURRING_RUN_FINAL: a run''s schedule, due date and occurrence never change' USING ERRCODE = 'P0001';
  END IF;
  -- The snapshot taken at the first attempt never changes (a retry makes exactly what the first attempt would have) —
  -- except that auto-post may be WITHDRAWN (the authoriser lost the right): the retry then makes a draft.
  IF NEW."payload" IS DISTINCT FROM OLD."payload" OR NEW."autoPostBy" IS DISTINCT FROM OLD."autoPostBy"
     OR (NEW."autoPost" AND NOT OLD."autoPost") OR (NEW."autoPostSodBypass" AND NOT OLD."autoPostSodBypass") THEN
    RAISE EXCEPTION 'RECURRING_RUN_FINAL: a run''s snapshot (what it makes, and its auto-post authorisation) never changes; auto-post is only withdrawn' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" <> 'FAILED' THEN
    RAISE EXCEPTION 'RECURRING_RUN_FINAL: a run that created its document, posted it or was skipped is final' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."attempts" <= OLD."attempts" THEN
    RAISE EXCEPTION 'RECURRING_RUN_FINAL: a retry counts as a new attempt' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recurring_run_guard BEFORE UPDATE ON "RecurringRun" FOR EACH ROW EXECUTE FUNCTION recurring_run_guard();

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "JournalTemplate" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "JournalTemplateLine" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "RecurringSchedule" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "RecurringRun" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "RecurringSchedule" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "RecurringRun" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();

-- 5 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "JournalTemplate", "JournalTemplateLine", "RecurringSchedule", "RecurringRun" TO flowcom_app;
    GRANT USAGE, SELECT ON SEQUENCE "RecurringSchedule_refNo_seq" TO flowcom_app;
    GRANT EXECUTE ON FUNCTION journal_template_balanced(), recurring_no_delete(), recurring_run_guard() TO flowcom_app;
  END IF;
END $$;

COMMIT;
