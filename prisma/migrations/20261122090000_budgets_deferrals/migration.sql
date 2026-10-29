-- «الموازنات» and «قوالب التأجيل» (feat/budgets-deferrals, Qoyod-parity phase 4 items 4 and 5; the accounting council's
-- design). ADDITIVE ONLY, one transaction (PostgreSQL 16 / 17). Six new, empty tables; no existing row is read or changed
-- except the seed of two posting roles on a chart that exists.
--
--   1. "GlBudget" / "GlBudgetLine" («الموازنات»): amounts per P&L account per month (1–12) for one Gregorian fiscal year,
--      optionally one branch. DRAFT is edited; APPROVED is LOCKED by the database (gl_budget_guard, gl_budget_line_guard):
--      a change is a revision (same "rootId", "revisionNo" + 1; at most one DRAFT and one APPROVED per root — partial
--      unique indexes), and approving it archives the version it replaces. A budget NEVER posts to the GL: the
--      budget-vs-actual report reads the ledger through the statements service. (The finance module's cash budget —
--      "FinBudget" / "BudgetRevision" / "BudgetLine" — is a different thing and is untouched.)
--   2. "DeferralTemplate" / "DeferralSchedule" / "DeferralScheduleLine" / "DeferralRun" («قوالب التأجيل»): a prepaid
--      expense (Dr P&L / Cr prepaid) or a deferred revenue (Dr deferred revenue / Cr P&L) recognised over N months. A
--      schedule copies its template (kind, months, start rule, accounts); its lines split the amount in halalas, the
--      remainder in the last month (src/lib/accounting/deferral-math.ts). A schedule's amounts, accounts and lines never
--      change (deferral_schedule_guard, deferral_line_guard) and Σ lines = the schedule's amount at commit
--      (deferral_schedule_total_check). A monthly run recognises that month's PENDING lines with ONE balanced entry through
--      the posting engine (closed periods refused there); a line is recognised by one live run only — the run's
--      idempotency per (schedule, month) — and goes back to PENDING only when its run is REVERSED (deferral_run_guard).
--      Before go-live the run is recorded SKIPPED with no entry (the engine's NOT_ACTIVE / BEFORE_GO_LIVE pattern).
--      Never deleted, audited (ledger_audit_row), the three books tables not truncated (ledger_no_truncate).
--      Council review (F1 / F4): a schedule whose amount was booked to P&L (an invoice line, or by hand) is RECLASSified to the
--      balance sheet by one entry at its start date (initialMode / reclass*); a journal-line source sits on the balance account
--      (ON_ACCOUNT). A cancel recognises the remainder now (one entry) or keeps it on the account (cancelMode / cancel*).
--   3. The posting roles PREPAID_EXPENSES («مصروفات مدفوعة مقدماً», asset 1160 — in the default chart already) and
--      DEFERRED_REVENUE («إيرادات مؤجلة», liability 2152 under 2100): on a chart that exists (its parents 1100 / 2100), the
--      account is added when its code is free and the role mapped when it is not mapped yet — never changing an account
--      or a mapping that exists. No chart (production today): nothing is seeded; «تهيئة دليل الحسابات» maps both.
--   4. The runtime role (flowcom_app), when it exists, is granted the new tables and functions.
-- Rollback: docs/hr/migration-review/rollback-20261122090000_budgets_deferrals.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "GlBudget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "name" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "branchId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "rootId" TEXT NOT NULL,
    "revisionOfId" TEXT,
    "revisionNo" INTEGER NOT NULL DEFAULT 1,
    "revisionReason" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sodBypass" BOOLEAN NOT NULL DEFAULT false,
    "archivedBy" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "GlBudget_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GlBudget_status_check" CHECK ("status" IN ('DRAFT', 'APPROVED', 'ARCHIVED')),
    CONSTRAINT "GlBudget_text_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120 AND ("notes" IS NULL OR length("notes") <= 1000)
      AND ("branchId" IS NULL OR length("branchId") BETWEEN 1 AND 64)),
    CONSTRAINT "GlBudget_year_check" CHECK ("fiscalYear" BETWEEN 2000 AND 2200),
    CONSTRAINT "GlBudget_revision_check" CHECK ("revisionNo" >= 1 AND (("revisionNo" = 1) = ("revisionOfId" IS NULL))
      AND ("revisionNo" = 1 OR length(btrim(coalesce("revisionReason", ''))) BETWEEN 3 AND 500) AND ("revisionNo" > 1 OR "rootId" = "id")),
    CONSTRAINT "GlBudget_approval_check" CHECK (("status" <> 'APPROVED' OR ("approvedAt" IS NOT NULL AND "approvedBy" IS NOT NULL))
      AND (("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL)))
);

CREATE TABLE "GlBudgetLine" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "GlBudgetLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GlBudgetLine_month_check" CHECK ("month" BETWEEN 1 AND 12),
    CONSTRAINT "GlBudgetLine_amount_check" CHECK ("amount" <> 0)
);

CREATE INDEX "GlBudget_fiscalYear_status_idx" ON "GlBudget"("fiscalYear", "status");
CREATE UNIQUE INDEX "GlBudget_rootId_revisionNo_key" ON "GlBudget"("rootId", "revisionNo");
CREATE UNIQUE INDEX "GlBudget_one_draft" ON "GlBudget"("rootId") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "GlBudget_one_approved" ON "GlBudget"("rootId") WHERE "status" = 'APPROVED';
CREATE INDEX "GlBudgetLine_accountId_idx" ON "GlBudgetLine"("accountId");
CREATE UNIQUE INDEX "GlBudgetLine_budgetId_accountId_month_key" ON "GlBudgetLine"("budgetId", "accountId", "month");
ALTER TABLE "GlBudget" ADD CONSTRAINT "GlBudget_rootId_fkey" FOREIGN KEY ("rootId") REFERENCES "GlBudget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GlBudget" ADD CONSTRAINT "GlBudget_revisionOfId_fkey" FOREIGN KEY ("revisionOfId") REFERENCES "GlBudget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GlBudgetLine" ADD CONSTRAINT "GlBudgetLine_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "GlBudget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GlBudgetLine" ADD CONSTRAINT "GlBudgetLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An APPROVED budget is locked: only its archiving (when a revision replaces it, or by hand) changes it. An ARCHIVED one is
-- final. A budget keeps its year, branch, family and revision number; only a DRAFT is deleted (its lines with it).
CREATE OR REPLACE FUNCTION gl_budget_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'LEDGER: an approved budget is locked; change it through a revision (an approved or archived budget is never deleted)' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'ARCHIVED' THEN
    RAISE EXCEPTION 'LEDGER: an archived budget is final' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."fiscalYear" <> OLD."fiscalYear" OR NEW."branchId" IS DISTINCT FROM OLD."branchId" OR NEW."rootId" <> OLD."rootId"
     OR NEW."revisionOfId" IS DISTINCT FROM OLD."revisionOfId" OR NEW."revisionNo" <> OLD."revisionNo" OR NEW."createdBy" <> OLD."createdBy"
     OR NEW."tenantId" <> OLD."tenantId" OR NEW."id" <> OLD."id" THEN
    RAISE EXCEPTION 'LEDGER: a budget keeps its year, branch and revision' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" = 'APPROVED' AND (NEW."status" <> 'ARCHIVED' OR NEW."name" <> OLD."name" OR NEW."notes" IS DISTINCT FROM OLD."notes"
       OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."sodBypass" <> OLD."sodBypass" OR NEW."revisionReason" IS DISTINCT FROM OLD."revisionReason") THEN
    RAISE EXCEPTION 'LEDGER: an approved budget is locked; change it through a revision' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gl_budget_guard BEFORE UPDATE OR DELETE ON "GlBudget" FOR EACH ROW EXECUTE FUNCTION gl_budget_guard();

-- A line is written only while its budget is a DRAFT (the budget row is read FOR SHARE: an approval waits for a line write
-- in flight, and a line write waits for an approval). A line deleted with its draft (ON DELETE CASCADE) finds no budget.
CREATE OR REPLACE FUNCTION gl_budget_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."budgetId" <> OLD."budgetId" THEN
    RAISE EXCEPTION 'LEDGER: a budget line stays in its budget' USING ERRCODE = 'P0001';
  END IF;
  SELECT "status" INTO s FROM "GlBudget" WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."budgetId" ELSE NEW."budgetId" END FOR SHARE;
  IF TG_OP = 'DELETE' THEN
    IF s IS NOT NULL AND s <> 'DRAFT' THEN
      RAISE EXCEPTION 'LEDGER: an approved budget is locked; change it through a revision' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF s IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'LEDGER: an approved budget is locked; change it through a revision' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gl_budget_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "GlBudgetLine" FOR EACH ROW EXECUTE FUNCTION gl_budget_line_guard();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "GlBudget" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "GlBudgetLine" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "DeferralTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "kind" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "startRule" TEXT NOT NULL DEFAULT 'START_MONTH',
    "balanceAccountId" TEXT,
    "plAccountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,

    CONSTRAINT "DeferralTemplate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeferralTemplate_kind_check" CHECK ("kind" IN ('PREPAID_EXPENSE', 'DEFERRED_REVENUE')),
    CONSTRAINT "DeferralTemplate_rule_check" CHECK ("startRule" IN ('START_MONTH', 'NEXT_MONTH', 'DAILY_PRORATA') AND "months" BETWEEN 1 AND 120),
    CONSTRAINT "DeferralTemplate_text_check" CHECK (length(btrim("nameAr")) BETWEEN 1 AND 120 AND ("nameEn" IS NULL OR length("nameEn") <= 120))
);

CREATE TABLE "DeferralSchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "number" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "startRule" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "balanceAccountId" TEXT NOT NULL,
    "plAccountId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "branchId" TEXT,
    "costCenterId" TEXT,
    "initialMode" TEXT NOT NULL DEFAULT 'ON_ACCOUNT',
    "reclassAccountId" TEXT,
    "reclassStatus" TEXT,
    "reclassEntryId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelMode" TEXT,
    "cancelDate" DATE,
    "cancelAccountId" TEXT,
    "cancelAmount" DECIMAL(18,2),
    "cancelStatus" TEXT,
    "cancelEntryId" TEXT,

    CONSTRAINT "DeferralSchedule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeferralSchedule_kind_check" CHECK ("kind" IN ('PREPAID_EXPENSE', 'DEFERRED_REVENUE')),
    CONSTRAINT "DeferralSchedule_rule_check" CHECK ("startRule" IN ('START_MONTH', 'NEXT_MONTH', 'DAILY_PRORATA') AND "months" BETWEEN 1 AND 120),
    CONSTRAINT "DeferralSchedule_amount_check" CHECK ("totalAmount" > 0 AND "balanceAccountId" <> "plAccountId"),
    CONSTRAINT "DeferralSchedule_number_check" CHECK ("number" ~ '^DEF-[0-9]{4}-[0-9]{6}$'),
    CONSTRAINT "DeferralSchedule_text_check" CHECK (length(btrim("description")) BETWEEN 1 AND 300),
    CONSTRAINT "DeferralSchedule_source_check" CHECK ("sourceType" IN ('MANUAL', 'JOURNAL_LINE', 'SUPPLIER_INVOICE_LINE', 'SALES_INVOICE_LINE')
      AND (("sourceType" = 'MANUAL') = ("sourceId" IS NULL))),
    CONSTRAINT "DeferralSchedule_status_check" CHECK ("status" IN ('ACTIVE', 'COMPLETED', 'CANCELLED')
      AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL))
      AND ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancelReason", ''))) >= 3)),
    -- Council F1: an invoice line's amount was booked to P&L → RECLASS; a journal line sits on the balance account → ON_ACCOUNT.
    CONSTRAINT "DeferralSchedule_reclass_check" CHECK ("initialMode" IN ('ON_ACCOUNT', 'RECLASS')
      AND (("initialMode" = 'RECLASS') = ("reclassAccountId" IS NOT NULL)) AND (("initialMode" = 'RECLASS') = ("reclassStatus" IS NOT NULL))
      AND ("reclassStatus" IS NULL OR "reclassStatus" IN ('POSTED', 'SKIPPED')) AND (("reclassStatus" IS NOT DISTINCT FROM 'POSTED') = ("reclassEntryId" IS NOT NULL))
      AND ("reclassAccountId" IS NULL OR "reclassAccountId" <> "balanceAccountId")
      AND ("sourceType" NOT IN ('SUPPLIER_INVOICE_LINE', 'SALES_INVOICE_LINE') OR "initialMode" = 'RECLASS')
      AND ("sourceType" <> 'JOURNAL_LINE' OR "initialMode" = 'ON_ACCOUNT')),
    -- Council F4: a cancel recognises the remainder now (one entry) or keeps it on the account (the reason is the note).
    CONSTRAINT "DeferralSchedule_cancel_check" CHECK ((("status" = 'CANCELLED') = ("cancelMode" IS NOT NULL))
      AND ("cancelMode" IS NULL OR ("cancelMode" IN ('RECOGNIZE_NOW', 'KEEP') AND "cancelDate" IS NOT NULL AND "cancelAmount" >= 0
        AND "cancelStatus" IN ('POSTED', 'SKIPPED', 'NONE')))
      AND ("cancelMode" IS DISTINCT FROM 'KEEP' OR ("cancelAccountId" IS NULL AND "cancelStatus" = 'NONE'))
      AND (("cancelStatus" IS NOT DISTINCT FROM 'POSTED') = ("cancelEntryId" IS NOT NULL))
      AND ("cancelAccountId" IS NULL OR "cancelAccountId" <> "balanceAccountId"))
);

CREATE TABLE "DeferralRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "periodStart" DATE NOT NULL,
    "entryDate" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "skipReason" TEXT,
    "journalEntryId" TEXT,
    "total" DECIMAL(18,2) NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedBy" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reverseReason" TEXT,
    "reversalEntryId" TEXT,

    CONSTRAINT "DeferralRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeferralRun_status_check" CHECK ("status" IN ('POSTED', 'SKIPPED', 'REVERSED')
      AND (("status" = 'REVERSED') = ("reversedAt" IS NOT NULL))
      AND ("status" <> 'REVERSED' OR length(btrim(coalesce("reverseReason", ''))) >= 3)
      AND ("status" <> 'POSTED' OR ("journalEntryId" IS NOT NULL AND "skipReason" IS NULL))
      AND ("status" <> 'SKIPPED' OR ("journalEntryId" IS NULL AND "skipReason" IN ('NOT_ACTIVE', 'BEFORE_GO_LIVE')))
      AND ("reversalEntryId" IS NULL OR ("status" = 'REVERSED' AND "journalEntryId" IS NOT NULL))),
    CONSTRAINT "DeferralRun_amount_check" CHECK ("total" > 0 AND "lineCount" >= 1),
    CONSTRAINT "DeferralRun_month_check" CHECK (extract(day FROM "periodStart") = 1
      AND "entryDate" = ("periodStart" + interval '1 month' - interval '1 day')::date)
);

CREATE TABLE "DeferralScheduleLine" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "periodStart" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "runId" TEXT,

    CONSTRAINT "DeferralScheduleLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeferralScheduleLine_amount_check" CHECK ("amount" > 0 AND "seq" >= 1 AND extract(day FROM "periodStart") = 1),
    CONSTRAINT "DeferralScheduleLine_status_check" CHECK ("status" IN ('PENDING', 'RECOGNIZED') AND (("status" = 'RECOGNIZED') = ("runId" IS NOT NULL)))
);

CREATE INDEX "DeferralTemplate_kind_isActive_idx" ON "DeferralTemplate"("kind", "isActive");
CREATE UNIQUE INDEX "DeferralSchedule_number_key" ON "DeferralSchedule"("number");
CREATE INDEX "DeferralSchedule_status_idx" ON "DeferralSchedule"("status");
CREATE INDEX "DeferralSchedule_sourceType_sourceId_idx" ON "DeferralSchedule"("sourceType", "sourceId");
CREATE INDEX "DeferralScheduleLine_periodStart_status_idx" ON "DeferralScheduleLine"("periodStart", "status");
CREATE INDEX "DeferralScheduleLine_runId_idx" ON "DeferralScheduleLine"("runId");
CREATE UNIQUE INDEX "DeferralScheduleLine_scheduleId_seq_key" ON "DeferralScheduleLine"("scheduleId", "seq");
CREATE UNIQUE INDEX "DeferralScheduleLine_scheduleId_periodStart_key" ON "DeferralScheduleLine"("scheduleId", "periodStart");
CREATE INDEX "DeferralRun_periodStart_idx" ON "DeferralRun"("periodStart");
ALTER TABLE "DeferralTemplate" ADD CONSTRAINT "DeferralTemplate_balanceAccountId_fkey" FOREIGN KEY ("balanceAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeferralTemplate" ADD CONSTRAINT "DeferralTemplate_plAccountId_fkey" FOREIGN KEY ("plAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeferralSchedule" ADD CONSTRAINT "DeferralSchedule_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DeferralTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeferralSchedule" ADD CONSTRAINT "DeferralSchedule_balanceAccountId_fkey" FOREIGN KEY ("balanceAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeferralSchedule" ADD CONSTRAINT "DeferralSchedule_plAccountId_fkey" FOREIGN KEY ("plAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeferralSchedule" ADD CONSTRAINT "DeferralSchedule_reclassAccountId_fkey" FOREIGN KEY ("reclassAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeferralSchedule" ADD CONSTRAINT "DeferralSchedule_cancelAccountId_fkey" FOREIGN KEY ("cancelAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeferralScheduleLine" ADD CONSTRAINT "DeferralScheduleLine_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "DeferralSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeferralScheduleLine" ADD CONSTRAINT "DeferralScheduleLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DeferralRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION deferral_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER: deferral templates, schedules, their lines and runs are never deleted (deactivate, cancel or reverse them)' USING ERRCODE = 'P0001';
END $$;

-- A schedule's amount, accounts, dates, source and dimensions never change; ACTIVE → COMPLETED / CANCELLED, COMPLETED →
-- ACTIVE (its last run reversed); CANCELLED is final.
CREATE OR REPLACE FUNCTION deferral_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."number" <> OLD."number" OR NEW."templateId" <> OLD."templateId" OR NEW."kind" <> OLD."kind"
     OR NEW."months" <> OLD."months" OR NEW."startRule" <> OLD."startRule" OR NEW."startDate" <> OLD."startDate"
     OR NEW."totalAmount" <> OLD."totalAmount" OR NEW."balanceAccountId" <> OLD."balanceAccountId" OR NEW."plAccountId" <> OLD."plAccountId"
     OR NEW."sourceType" <> OLD."sourceType" OR NEW."sourceId" IS DISTINCT FROM OLD."sourceId" OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."costCenterId" IS DISTINCT FROM OLD."costCenterId" OR NEW."createdBy" <> OLD."createdBy" OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."initialMode" <> OLD."initialMode" OR NEW."reclassAccountId" IS DISTINCT FROM OLD."reclassAccountId"
     OR NEW."reclassStatus" IS DISTINCT FROM OLD."reclassStatus" OR NEW."reclassEntryId" IS DISTINCT FROM OLD."reclassEntryId"
     OR OLD."status" = 'CANCELLED'
     OR (NEW."status" <> OLD."status" AND NOT ((OLD."status" = 'ACTIVE' AND NEW."status" IN ('COMPLETED', 'CANCELLED')) OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'ACTIVE'))) THEN
    RAISE EXCEPTION 'LEDGER: a deferral schedule''s amount, accounts and lines never change; it is only cancelled' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- At commit: a schedule's lines add up to its amount (written once, with the schedule).
CREATE OR REPLACE FUNCTION deferral_schedule_total_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid text; want numeric; got numeric;
BEGIN
  IF TG_TABLE_NAME = 'DeferralSchedule' THEN sid := NEW."id"; ELSE sid := NEW."scheduleId"; END IF;
  SELECT "totalAmount" INTO want FROM "DeferralSchedule" WHERE "id" = sid;
  SELECT coalesce(sum("amount"), 0) INTO got FROM "DeferralScheduleLine" WHERE "scheduleId" = sid;
  IF want IS NULL OR got <> want THEN
    RAISE EXCEPTION 'LEDGER: a deferral schedule''s lines add up to its amount (% <> %)', got, want USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

-- A line's month and amount never change. PENDING → RECOGNIZED by a live run of ITS month (POSTED / SKIPPED) while the
-- schedule is not cancelled; RECOGNIZED → PENDING only when that run is REVERSED. So a (schedule, month) is recognised by
-- one live run at a time.
CREATE OR REPLACE FUNCTION deferral_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rs text; rp date; ss text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."runId" IS NOT NULL THEN
      RAISE EXCEPTION 'LEDGER: a deferral line is written PENDING' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM "DeferralScheduleLine" WHERE "scheduleId" = NEW."scheduleId" AND "status" = 'RECOGNIZED') THEN
      RAISE EXCEPTION 'LEDGER: a deferral schedule''s amount, accounts and lines never change; it is only cancelled' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."scheduleId" <> OLD."scheduleId" OR NEW."seq" <> OLD."seq" OR NEW."periodStart" <> OLD."periodStart" OR NEW."amount" <> OLD."amount" THEN
    RAISE EXCEPTION 'LEDGER: a deferral schedule''s amount, accounts and lines never change; it is only cancelled' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."runId" IS NOT DISTINCT FROM OLD."runId" AND NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'PENDING' AND NEW."status" = 'RECOGNIZED' THEN
    SELECT "status", "periodStart" INTO rs, rp FROM "DeferralRun" WHERE "id" = NEW."runId";
    SELECT "status" INTO ss FROM "DeferralSchedule" WHERE "id" = NEW."scheduleId";
    IF rs IS NULL OR rs NOT IN ('POSTED', 'SKIPPED') OR rp <> NEW."periodStart" OR ss = 'CANCELLED' THEN
      RAISE EXCEPTION 'LEDGER: a deferral month is recognised once, by a live run of that month' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'RECOGNIZED' AND NEW."status" = 'PENDING' AND NEW."runId" IS NULL THEN
    SELECT "status" INTO rs FROM "DeferralRun" WHERE "id" = OLD."runId";
    -- A schedule whose remainder was recognised at its cancel (council F4) takes no month back: it would count twice.
    IF rs = 'REVERSED' AND NOT EXISTS (SELECT 1 FROM "DeferralSchedule" WHERE "id" = NEW."scheduleId" AND "cancelMode" = 'RECOGNIZE_NOW') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'LEDGER: a deferral month is recognised once, by a live run of that month' USING ERRCODE = 'P0001';
END $$;

-- A run's month, entry and amounts never change; POSTED / SKIPPED → REVERSED, once.
CREATE OR REPLACE FUNCTION deferral_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."periodStart" <> OLD."periodStart" OR NEW."entryDate" <> OLD."entryDate" OR NEW."total" <> OLD."total"
     OR NEW."lineCount" <> OLD."lineCount" OR NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId" OR NEW."skipReason" IS DISTINCT FROM OLD."skipReason"
     OR NEW."createdBy" <> OLD."createdBy" OR NEW."tenantId" <> OLD."tenantId" OR OLD."status" = 'REVERSED'
     OR (NEW."status" <> OLD."status" AND NEW."status" <> 'REVERSED') THEN
    RAISE EXCEPTION 'LEDGER: a deferral run never changes; it is only reversed, once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER deferral_no_delete BEFORE DELETE ON "DeferralTemplate" FOR EACH ROW EXECUTE FUNCTION deferral_no_delete();
CREATE TRIGGER deferral_no_delete BEFORE DELETE ON "DeferralSchedule" FOR EACH ROW EXECUTE FUNCTION deferral_no_delete();
CREATE TRIGGER deferral_no_delete BEFORE DELETE ON "DeferralScheduleLine" FOR EACH ROW EXECUTE FUNCTION deferral_no_delete();
CREATE TRIGGER deferral_no_delete BEFORE DELETE ON "DeferralRun" FOR EACH ROW EXECUTE FUNCTION deferral_no_delete();
CREATE TRIGGER deferral_schedule_guard BEFORE UPDATE ON "DeferralSchedule" FOR EACH ROW EXECUTE FUNCTION deferral_schedule_guard();
CREATE TRIGGER deferral_line_guard BEFORE INSERT OR UPDATE ON "DeferralScheduleLine" FOR EACH ROW EXECUTE FUNCTION deferral_line_guard();
CREATE TRIGGER deferral_run_guard BEFORE UPDATE ON "DeferralRun" FOR EACH ROW EXECUTE FUNCTION deferral_run_guard();
CREATE CONSTRAINT TRIGGER deferral_schedule_total_check AFTER INSERT ON "DeferralSchedule" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deferral_schedule_total_check();
CREATE CONSTRAINT TRIGGER deferral_schedule_total_check AFTER INSERT ON "DeferralScheduleLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deferral_schedule_total_check();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "DeferralSchedule" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "DeferralScheduleLine" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "DeferralRun" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "DeferralTemplate" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "DeferralSchedule" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "DeferralScheduleLine" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "DeferralRun" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE p text; a text;
BEGIN
  -- PREPAID_EXPENSES → 1160 under 1100 (current assets; «مصروفات مدفوعة مقدماً» is in the default chart already).
  IF NOT EXISTS (SELECT 1 FROM "AccountRole" WHERE "tenantId" = 'hiqbah' AND "role" = 'PREPAID_EXPENSES') THEN
    SELECT "id" INTO p FROM "Account" WHERE "code" = '1100';
    IF p IS NOT NULL THEN
      SELECT "id" INTO a FROM "Account" WHERE "code" = '1160' AND "type"::text = 'ASSET' AND "allowPosting" AND "isActive";
      IF a IS NULL AND NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '1160') THEN
        a := 'acc_' || replace(gen_random_uuid()::text, '-', '');
        INSERT INTO "Account" ("id", "code", "nameAr", "nameEn", "parentId", "type", "allowPosting", "isActive", "allowManualJournal", "createdBy", "updatedBy", "updatedAt")
        VALUES (a, '1160', 'مصروفات مدفوعة مقدماً', 'Prepaid expenses', p, 'ASSET', true, true, true, 'migration', 'migration', now());
      END IF;
      IF a IS NOT NULL THEN
        INSERT INTO "AccountRole" ("id", "tenantId", "role", "accountId", "updatedBy", "updatedAt") VALUES ('ar_' || replace(gen_random_uuid()::text, '-', ''), 'hiqbah', 'PREPAID_EXPENSES', a, 'migration', now());
      END IF;
    END IF;
  END IF;
  p := NULL; a := NULL;
  -- DEFERRED_REVENUE → 2152 under 2100 (current liabilities): subscriptions and orders paid in advance.
  IF NOT EXISTS (SELECT 1 FROM "AccountRole" WHERE "tenantId" = 'hiqbah' AND "role" = 'DEFERRED_REVENUE') THEN
    SELECT "id" INTO p FROM "Account" WHERE "code" = '2100';
    IF p IS NOT NULL THEN
      SELECT "id" INTO a FROM "Account" WHERE "code" = '2152' AND "type"::text = 'LIABILITY' AND "allowPosting" AND "isActive";
      IF a IS NULL AND NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '2152') THEN
        a := 'acc_' || replace(gen_random_uuid()::text, '-', '');
        INSERT INTO "Account" ("id", "code", "nameAr", "nameEn", "parentId", "type", "allowPosting", "isActive", "allowManualJournal", "createdBy", "updatedBy", "updatedAt")
        VALUES (a, '2152', 'إيرادات مؤجلة - اشتراكات وطلبات مدفوعة مقدماً', 'Deferred revenue – subscriptions & prepaid orders', p, 'LIABILITY', true, true, true, 'migration', 'migration', now());
      END IF;
      IF a IS NOT NULL THEN
        INSERT INTO "AccountRole" ("id", "tenantId", "role", "accountId", "updatedBy", "updatedAt") VALUES ('ar_' || replace(gen_random_uuid()::text, '-', ''), 'hiqbah', 'DEFERRED_REVENUE', a, 'migration', now());
      END IF;
    END IF;
  END IF;
END $$;

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "GlBudget", "GlBudgetLine", "DeferralTemplate", "DeferralSchedule", "DeferralScheduleLine", "DeferralRun" TO flowcom_app;
    GRANT EXECUTE ON FUNCTION gl_budget_guard(), gl_budget_line_guard(), deferral_no_delete(), deferral_schedule_guard(), deferral_schedule_total_check(),
      deferral_line_guard(), deferral_run_guard() TO flowcom_app;
  END IF;
END $$;

COMMIT;
