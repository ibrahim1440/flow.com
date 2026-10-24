-- Accounting core A1 (feat/accounting-core). Owner authorisation: the accounting module and ZATCA Phase 2,
-- in five phases (A1 core · A2 sales invoicing + AR · A3 AP / inventory / production / payroll posting ·
-- A4 ZATCA · A5 reports and close). This is A1, the foundation the others plug into. The S0 tables
-- (Account, FiscalPeriod, JournalEntry, JournalEntryLine, AccountingSettings) are EXTENDED, not duplicated:
-- the HR posting bridge keeps writing the same ledger.
--
-- The database now guarantees (docs/accounting/POSTING-CONTRACT.md §7):
--   1. BALANCE — a POSTED (or REVERSED) entry has at least two lines, Σ debit = Σ credit > 0, and its header
--      totals equal its lines; checked at COMMIT by a deferred constraint trigger (ledger_entry_balanced).
--   2. IMMUTABILITY — a posted entry is never deleted and never changes; its only change is POSTED → REVERSED,
--      and only when its reversal exists. A line is never added to a posted entry after the transaction that
--      posted it, never changed, never deleted (ledger_entry_guard, ledger_line_guard).
--   3. CLOSED PERIODS — nothing posts into a CLOSED period, and an entry's date lies inside its period;
--      a CLOSED period is left only with a reason, a named person and a new reopen stamp (ledger_period_guard).
--   4. POSTABLE ACCOUNTS — a line names an active, postable leaf account; AR / AP control lines name their party.
--   5. GAPLESS NUMBERING — each posted entry gets (postingYear, postingSeq) from a counter row updated inside
--      the posting transaction (never a sequence), unique per tenant.
--   6. ENGINE ENTRIES — the posting engine ('accounting', 'sales', 'purchasing', 'inventory', 'production',
--      'payroll', 'commissions', 'pos'; AUTO / REVERSAL / OPENING; with an idempotency key, born POSTED) may
--      write while manual journals are off, but ONLY while accounting is activated (hr_manual_journal_guard is
--      replaced with that one addition; everything it refused before it still refuses). Engine entries are
--      never dated before the go-live date. One entry per idempotency key per tenant (unique index).
--   7. AUDIT — every change of the chart, roles, fiscal years, periods, settings, journal entries and the
--      opening grid is written by the database to the append-only "AccountingAuditLog" (who, when, what,
--      before / after, IP and device from the transaction's context; src/lib/accounting/audit.ts).
--   8. SETTINGS — activation needs a go-live date; the go-live date and activation are frozen once the engine
--      has posted; the opening entry, once recorded, never changes; the opening grid freezes with it.
-- tenantId TEXT NOT NULL DEFAULT 'hiqbah' on every accounting table (single tenant; RLS deliberately NOT enabled:
-- POSTING-CONTRACT.md §8).
--
-- ADDITIVE: new nullable / defaulted columns on the five S0 tables (metadata-only defaults); five new, empty
-- tables (FiscalYear, AccountRole, AccountingAuditLog, AccountingCounter, OpeningBalanceLine); CHECKs; one
-- partial index; ledger_* functions and their triggers; hr_manual_journal_guard replaced (same name, same
-- triggers) and hr_automatic_journal_module unchanged. Existing rows: Account.normalBalance is back-filled from
-- the type; FiscalYear rows are created for the years of existing periods and the periods linked to them.
-- No existing journal is rewritten; the new guards fire on NEW writes only (preflight check 16 reports
-- existing posted entries that would not satisfy them — expected 0; production holds no journal).
-- Grants: re-run scripts/release/grant-app-runtime.sql and scripts/hr/grant-hr-runtime.sql.
-- Atomic: one transaction. Rollback: docs/hr/migration-review/rollback-20261102090000_accounting_core.sql.
BEGIN;

-- ── 1 · columns on the S0 tables ──────────────────────────────────────────────────────────────────────
ALTER TABLE "Account" ADD COLUMN "allowManualJournal" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "controlType" TEXT,
ADD COLUMN "description" TEXT,
ADD COLUMN "normalBalance" TEXT NOT NULL DEFAULT 'AUTO',
ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'hiqbah';

ALTER TABLE "AccountingSettings" ADD COLUMN "accountingActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "activatedAt" TIMESTAMP(3),
ADD COLUMN "activatedBy" TEXT,
ADD COLUMN "coaSeededAt" TIMESTAMP(3),
ADD COLUMN "coaSeededBy" TEXT,
ADD COLUMN "coaTemplate" TEXT,
ADD COLUMN "goLiveDate" DATE,
ADD COLUMN "openingEntryId" TEXT,
ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'hiqbah';

ALTER TABLE "FiscalPeriod" ADD COLUMN "fiscalYearId" TEXT,
ADD COLUMN "reopenCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reopenReason" TEXT,
ADD COLUMN "reopenedAt" TIMESTAMP(3),
ADD COLUMN "reopenedBy" TEXT,
ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'hiqbah';

ALTER TABLE "JournalEntry" ADD COLUMN "attachments" JSONB,
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "payloadHash" TEXT,
ADD COLUMN "postingSeq" INTEGER,
ADD COLUMN "postingYear" INTEGER,
ADD COLUMN "rejectReason" TEXT,
ADD COLUMN "rejectedAt" TIMESTAMP(3),
ADD COLUMN "rejectedBy" TEXT,
ADD COLUMN "reversedAt" TIMESTAMP(3),
ADD COLUMN "reversedBy" TEXT,
ADD COLUMN "roundingAmount" DECIMAL(18,2),
ADD COLUMN "sodBypass" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sourceEvent" TEXT,
ADD COLUMN "sourceId" TEXT,
ADD COLUMN "sourceType" TEXT,
ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'hiqbah';

ALTER TABLE "JournalEntryLine" ADD COLUMN "branchId" TEXT,
ADD COLUMN "costCenterId" TEXT,
ADD COLUMN "itemId" TEXT,
ADD COLUMN "itemType" TEXT,
ADD COLUMN "lineNo" INTEGER,
ADD COLUMN "partyId" TEXT,
ADD COLUMN "partyType" TEXT,
ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'hiqbah';

-- ── 2 · new tables ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "FiscalYear" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "year" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalYear_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FiscalYear_status_check" CHECK ("status" IN ('OPEN', 'CLOSED')),
    CONSTRAINT "FiscalYear_dates_check" CHECK ("startDate" <= "endDate" AND "year" BETWEEN 2000 AND 2200)
);

CREATE TABLE "AccountRole" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "role" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AccountRole_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AccountRole_role_check" CHECK ("role" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

CREATE TABLE "AccountingAuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AccountingAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountingCounter" (
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "scope" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountingCounter_pkey" PRIMARY KEY ("tenantId","scope","year"),
    CONSTRAINT "AccountingCounter_value_check" CHECK ("value" >= 0)
);

CREATE TABLE "OpeningBalanceLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "lineNo" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "partyType" TEXT,
    "partyId" TEXT,
    "branchId" TEXT,
    "costCenterId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "OpeningBalanceLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OpeningBalanceLine_sides_check" CHECK (("debit" > 0 AND "credit" = 0) OR ("debit" = 0 AND "credit" > 0)),
    CONSTRAINT "OpeningBalanceLine_party_check" CHECK (("partyType" IS NULL) = ("partyId" IS NULL) AND ("partyType" IS NULL OR "partyType" IN ('CUSTOMER', 'SUPPLIER', 'EMPLOYEE')))
);

CREATE UNIQUE INDEX "FiscalYear_tenantId_year_key" ON "FiscalYear"("tenantId", "year");
CREATE INDEX "AccountRole_accountId_idx" ON "AccountRole"("accountId");
CREATE UNIQUE INDEX "AccountRole_tenantId_role_key" ON "AccountRole"("tenantId", "role");
CREATE INDEX "AccountingAuditLog_entityType_entityId_at_idx" ON "AccountingAuditLog"("entityType", "entityId", "at");
CREATE INDEX "AccountingAuditLog_at_idx" ON "AccountingAuditLog"("at");
CREATE INDEX "OpeningBalanceLine_accountId_idx" ON "OpeningBalanceLine"("accountId");
CREATE INDEX "Account_controlType_idx" ON "Account"("controlType");
CREATE UNIQUE INDEX "AccountingSettings_openingEntryId_key" ON "AccountingSettings"("openingEntryId");
CREATE INDEX "FiscalPeriod_fiscalYearId_idx" ON "FiscalPeriod"("fiscalYearId");
CREATE INDEX "JournalEntry_sourceType_sourceId_idx" ON "JournalEntry"("sourceType", "sourceId");
CREATE UNIQUE INDEX "JournalEntry_tenantId_idempotencyKey_key" ON "JournalEntry"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "JournalEntry_tenantId_postingYear_postingSeq_key" ON "JournalEntry"("tenantId", "postingYear", "postingSeq");
CREATE INDEX "JournalEntryLine_accountId_journalEntryId_idx" ON "JournalEntryLine"("accountId", "journalEntryId");
CREATE INDEX "JournalEntryLine_partyType_partyId_idx" ON "JournalEntryLine"("partyType", "partyId");
-- The ledger read models (general ledger, trial balance) read posted entries by date.
CREATE INDEX "JournalEntry_posted_entryDate_idx" ON "JournalEntry"("entryDate", "id") WHERE "status" IN ('POSTED', 'REVERSED');

ALTER TABLE "FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccountRole" ADD CONSTRAINT "AccountRole_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OpeningBalanceLine" ADD CONSTRAINT "OpeningBalanceLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 3 · back-fill (existing rows), then the CHECKs on the S0 tables ──────────────────────────────────
UPDATE "Account" SET "normalBalance" = CASE WHEN "type"::text IN ('ASSET', 'EXPENSE') THEN 'DEBIT' ELSE 'CREDIT' END
 WHERE "normalBalance" = 'AUTO';
INSERT INTO "FiscalYear" ("id", "year", "startDate", "endDate", "updatedAt")
  SELECT 'fy-' || p."year", p."year", min(p."startDate"), max(p."endDate"), now() FROM "FiscalPeriod" p GROUP BY p."year";
UPDATE "FiscalPeriod" p SET "fiscalYearId" = 'fy-' || p."year" WHERE p."fiscalYearId" IS NULL;

ALTER TABLE "Account" ADD CONSTRAINT "Account_normalBalance_check" CHECK ("normalBalance" IN ('DEBIT', 'CREDIT'));
ALTER TABLE "Account" ADD CONSTRAINT "Account_controlType_check" CHECK ("controlType" IS NULL OR "controlType" IN
  ('AR', 'AP', 'INVENTORY', 'VAT_INPUT', 'VAT_OUTPUT', 'CASH', 'BANK', 'FIXED_ASSET', 'PAYROLL', 'COMMISSION', 'CLEARING'));
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_party_check" CHECK (("partyType" IS NULL) = ("partyId" IS NULL)
  AND ("partyType" IS NULL OR "partyType" IN ('CUSTOMER', 'SUPPLIER', 'EMPLOYEE')));
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_item_check" CHECK (("itemType" IS NULL) = ("itemId" IS NULL)
  AND ("itemType" IS NULL OR "itemType" IN ('COFFEE_PRODUCT', 'PRODUCT_SKU', 'GREEN_BEAN', 'MATERIAL')));
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_source_check" CHECK (("sourceType" IS NULL) = ("sourceId" IS NULL)
  AND ("idempotencyKey" IS NULL OR "sourceType" IS NOT NULL));
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_posting_no_check" CHECK (("postingYear" IS NULL) = ("postingSeq" IS NULL)
  AND ("postingSeq" IS NULL OR "postingSeq" > 0));
ALTER TABLE "AccountingSettings" ADD CONSTRAINT "AccountingSettings_active_check" CHECK (NOT "accountingActive" OR ("goLiveDate" IS NOT NULL AND "activatedAt" IS NOT NULL));
ALTER TABLE "FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_reopen_check" CHECK ("reopenCount" >= 0
  AND ("reopenedAt" IS NULL OR ("reopenedBy" IS NOT NULL AND length(btrim(coalesce("reopenReason", ''))) >= 3)));

-- ── 4 · helpers ───────────────────────────────────────────────────────────────────────────────────────
-- The modules that post through the engine (src/lib/accounting/posting-engine.ts ENGINE_MODULES).
CREATE OR REPLACE FUNCTION ledger_engine_module(m text) RETURNS boolean AS $$
  SELECT m IS NOT NULL AND m IN ('accounting', 'sales', 'purchasing', 'inventory', 'production', 'payroll', 'commissions', 'pos')
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION ledger_accounting_active() RETURNS boolean AS $$
  SELECT coalesce((SELECT s."accountingActive" FROM "AccountingSettings" s WHERE s."id" = 'singleton'), false)
$$ LANGUAGE sql STABLE;

-- An engine entry: an engine module, an engine type, an idempotency key.
CREATE OR REPLACE FUNCTION ledger_engine_entry(m text, t text, k text) RETURNS boolean AS $$
  SELECT ledger_engine_module(m) AND t IN ('AUTO', 'REVERSAL', 'OPENING') AND k IS NOT NULL
$$ LANGUAGE sql IMMUTABLE;

-- 6 · manual journals (owner decision D1) — the same guard, now also admitting ENGINE entries while accounting
-- is activated: an engine entry is born POSTED (no draft), and afterwards only becomes REVERSED.
CREATE OR REPLACE FUNCTION hr_manual_journal_guard() RETURNS trigger AS $$
DECLARE what text; parent RECORD;
BEGIN
  IF TG_TABLE_NAME = 'JournalEntryLine' THEN
    -- At all times: a posted entry's lines are final (a correction is a reversal).
    IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."id" = OLD."journalEntryId" AND j."status"::text IN ('POSTED', 'REVERSED')) THEN
      RAISE EXCEPTION 'LEDGER: a line of a posted journal entry is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."id" = NEW."journalEntryId" AND j."status"::text IN ('POSTED', 'REVERSED')) THEN
      RAISE EXCEPTION 'LEDGER: a line of a posted journal entry is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF hr_manual_journals_enabled() THEN
      RETURN coalesce(NEW, OLD);
    END IF;
    SELECT j."sourceModule" AS m, j."type"::text AS t, j."idempotencyKey" AS k INTO parent FROM "JournalEntry" j
     WHERE j."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."journalEntryId" ELSE NEW."journalEntryId" END;
    IF NOT hr_automatic_journal_module(parent.m) AND NOT (ledger_engine_entry(parent.m, parent.t, parent.k) AND ledger_accounting_active()) THEN
      what := 'a line of a manual journal entry';
    END IF;
  ELSE
    IF hr_manual_journals_enabled() THEN
      RETURN coalesce(NEW, OLD);
    END IF;
    IF TG_OP = 'INSERT' AND NOT (
         (hr_automatic_journal_module(NEW."sourceModule") AND NEW."type"::text IN ('AUTO', 'REVERSAL'))
      OR (ledger_engine_entry(NEW."sourceModule", NEW."type"::text, NEW."idempotencyKey") AND NEW."status"::text = 'POSTED' AND ledger_accounting_active())) THEN
      what := 'creating a manual journal entry';
    ELSIF TG_OP = 'UPDATE' AND NOT (
         (hr_automatic_journal_module(OLD."sourceModule") AND hr_automatic_journal_module(NEW."sourceModule"))
      OR (ledger_engine_entry(OLD."sourceModule", OLD."type"::text, OLD."idempotencyKey") AND ledger_engine_entry(NEW."sourceModule", NEW."type"::text, NEW."idempotencyKey")
          AND OLD."status"::text = 'POSTED' AND NEW."status"::text = 'REVERSED' AND ledger_accounting_active())) THEN
      what := 'changing, approving or posting a manual journal entry';
    ELSIF TG_OP = 'DELETE' AND NOT hr_automatic_journal_module(OLD."sourceModule") THEN
      what := 'deleting a manual journal entry';
    END IF;
  END IF;
  IF what IS NOT NULL THEN
    RAISE EXCEPTION 'LEDGER: manual journals are disabled (Phase 1): % is refused', what USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ── 5 · the chart ─────────────────────────────────────────────────────────────────────────────────────
-- normalBalance 'AUTO' resolves from the type. Once an account has journal lines its code, type and normal
-- balance never change, and it never gets a child (a header holds no balance of its own). A parent never has lines.
CREATE OR REPLACE FUNCTION ledger_account_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."normalBalance" = 'AUTO' THEN
    NEW."normalBalance" := CASE WHEN NEW."type"::text IN ('ASSET', 'EXPENSE') THEN 'DEBIT' ELSE 'CREDIT' END;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."code" IS DISTINCT FROM OLD."code" OR NEW."type" IS DISTINCT FROM OLD."type" OR NEW."normalBalance" IS DISTINCT FROM OLD."normalBalance")
     AND EXISTS (SELECT 1 FROM "JournalEntryLine" l WHERE l."accountId" = OLD."id") THEN
    RAISE EXCEPTION 'LEDGER: an account with journal lines keeps its code, type and normal balance' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."parentId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."parentId" IS DISTINCT FROM OLD."parentId") THEN
    IF NEW."parentId" = NEW."id" THEN
      RAISE EXCEPTION 'LEDGER: an account is not its own parent' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "JournalEntryLine" l WHERE l."accountId" = NEW."parentId")
       OR EXISTS (SELECT 1 FROM "OpeningBalanceLine" o WHERE o."accountId" = NEW."parentId") THEN
      RAISE EXCEPTION 'LEDGER: an account with journal lines cannot become a parent (header) account' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- No cycle: the new parent is not a descendant of this account.
    IF TG_OP = 'UPDATE' AND EXISTS (
      WITH RECURSIVE up(id) AS (SELECT NEW."parentId" UNION SELECT a."parentId" FROM "Account" a JOIN up ON a."id" = up.id WHERE a."parentId" IS NOT NULL)
      SELECT 1 FROM up WHERE up.id = NEW."id") THEN
      RAISE EXCEPTION 'LEDGER: an account cannot be moved under its own descendant' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_account_guard BEFORE INSERT OR UPDATE ON "Account"
  FOR EACH ROW EXECUTE FUNCTION ledger_account_guard();

-- ── 6 · journal lines ─────────────────────────────────────────────────────────────────────────────────
-- Named ledger_* so they fire AFTER the hr_* / HrA* guards on the same tables (PostgreSQL fires BEFORE
-- triggers in name order): the existing refusals keep their wording.
CREATE OR REPLACE FUNCTION ledger_line_guard() RETURNS trigger AS $$
DECLARE parent RECORD; acc RECORD;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT j."status"::text AS status INTO parent FROM "JournalEntry" j WHERE j."id" = OLD."journalEntryId";
    IF parent.status IN ('POSTED', 'REVERSED') THEN
      RAISE EXCEPTION 'LEDGER: a line of a posted journal entry is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  END IF;
  SELECT j."status"::text AS status, j."xmin"::text AS xmin INTO parent FROM "JournalEntry" j WHERE j."id" = NEW."journalEntryId";
  IF parent.status = 'REVERSED' OR (parent.status = 'POSTED' AND (TG_OP = 'UPDATE' OR parent.xmin <> (txid_current() % 4294967296)::text)) THEN
    RAISE EXCEPTION 'LEDGER: a line is never added to a posted journal entry after it was posted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT a."isActive", a."allowPosting", a."controlType",
         EXISTS (SELECT 1 FROM "Account" c WHERE c."parentId" = a."id") AS has_children
    INTO acc FROM "Account" a WHERE a."id" = NEW."accountId";
  IF NOT FOUND OR NOT acc."isActive" OR NOT acc."allowPosting" OR acc.has_children THEN
    RAISE EXCEPTION 'LEDGER: a journal line names an active, postable leaf account (not a header, inactive or non-postable account)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF acc."controlType" IN ('AR', 'AP') AND NEW."partyId" IS NULL THEN
    RAISE EXCEPTION 'LEDGER: a line on an AR / AP control account names its customer or supplier' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "JournalEntryLine"
  FOR EACH ROW EXECUTE FUNCTION ledger_line_guard();

-- ── 7 · journal entries: immutability, closed periods, go-live, gapless numbering ───────────────────
CREATE OR REPLACE FUNCTION ledger_entry_guard() RETURNS trigger AS $$
DECLARE p RECORD; s RECORD; seq integer; yr integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::text IN ('POSTED', 'REVERSED') THEN
      RAISE EXCEPTION 'LEDGER: a posted journal entry is never deleted (a correction is a reversal)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status"::text IN ('POSTED', 'REVERSED') THEN
    IF NOT (OLD."status"::text = 'POSTED' AND NEW."status"::text = 'REVERSED'
            AND (to_jsonb(NEW) - ARRAY['status', 'updatedAt', 'reversedAt', 'reversedBy']) = (to_jsonb(OLD) - ARRAY['status', 'updatedAt', 'reversedAt', 'reversedBy'])) THEN
      RAISE EXCEPTION 'LEDGER: a posted journal entry never changes; its only change is POSTED to REVERSED (a correction is a reversal)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "JournalEntry" r WHERE r."reversesEntryId" = OLD."id" AND r."status"::text = 'POSTED') THEN
      RAISE EXCEPTION 'LEDGER: a journal entry is marked REVERSED only once its posted reversal exists' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status"::text = 'REVERSED' THEN
    RAISE EXCEPTION 'LEDGER: a journal entry is never created or edited into REVERSED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status"::text = 'POSTED' THEN
    -- Becoming POSTED (inserted posted, or posted from a draft / approval).
    SELECT fp."status"::text AS status, fp."startDate", fp."endDate" INTO p FROM "FiscalPeriod" fp WHERE fp."id" = NEW."fiscalPeriodId";
    IF p.status = 'CLOSED' THEN
      RAISE EXCEPTION 'LEDGER: the fiscal period is closed: posting into it is refused' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."entryDate" < p."startDate" OR NEW."entryDate" > p."endDate" THEN
      RAISE EXCEPTION 'LEDGER: the entry date lies outside its fiscal period' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF ledger_engine_module(NEW."sourceModule") THEN
      SELECT st."goLiveDate" INTO s FROM "AccountingSettings" st WHERE st."id" = 'singleton';
      IF s."goLiveDate" IS NOT NULL AND NEW."entryDate" < s."goLiveDate" THEN
        RAISE EXCEPTION 'LEDGER: an engine entry is never dated before the accounting go-live date' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    IF NEW."postingSeq" IS NOT NULL THEN
      RAISE EXCEPTION 'LEDGER: the posting number is assigned by the database' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    yr := extract(year FROM NEW."entryDate")::integer;
    INSERT INTO "AccountingCounter" ("tenantId", "scope", "year", "value") VALUES (NEW."tenantId", 'JE', yr, 1)
      ON CONFLICT ("tenantId", "scope", "year") DO UPDATE SET "value" = "AccountingCounter"."value" + 1
      RETURNING "value" INTO seq;
    NEW."postingYear" := yr;
    NEW."postingSeq" := seq;
    NEW."postedAt" := coalesce(NEW."postedAt", now());
  ELSIF NEW."postingSeq" IS NOT NULL OR NEW."postingYear" IS NOT NULL THEN
    RAISE EXCEPTION 'LEDGER: the posting number is assigned by the database' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_guard();

-- BALANCE, at COMMIT (deferred): Σ debit = Σ credit > 0, at least two lines, header totals = lines.
CREATE OR REPLACE FUNCTION ledger_entry_balanced() RETURNS trigger AS $$
DECLARE eid text; e RECORD; t RECORD;
BEGIN
  -- (Two statements, not a CASE: PL/pgSQL resolves every field reference of an expression against NEW's row type.)
  IF TG_TABLE_NAME = 'JournalEntryLine' THEN
    eid := NEW."journalEntryId";
  ELSE
    eid := NEW."id";
  END IF;
  SELECT j."status"::text AS status, j."totalDebit", j."totalCredit" INTO e FROM "JournalEntry" j WHERE j."id" = eid;
  IF NOT FOUND OR e.status NOT IN ('POSTED', 'REVERSED') THEN
    RETURN NULL;
  END IF;
  SELECT count(*) AS n, coalesce(sum(l."debit"), 0) AS d, coalesce(sum(l."credit"), 0) AS c INTO t
    FROM "JournalEntryLine" l WHERE l."journalEntryId" = eid;
  IF t.n < 2 OR t.d <> t.c OR t.d <= 0 THEN
    RAISE EXCEPTION 'LEDGER: a posted journal entry balances (debit % = credit %, at least two lines; it has %)', t.d, t.c, t.n USING ERRCODE = 'check_violation';
  END IF;
  IF e."totalDebit" <> t.d OR e."totalCredit" <> t.c THEN
    RAISE EXCEPTION 'LEDGER: a posted journal entry''s totals equal its lines' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entry_balanced AFTER INSERT OR UPDATE ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_balanced();
CREATE CONSTRAINT TRIGGER ledger_entry_balanced AFTER INSERT OR UPDATE ON "JournalEntryLine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_balanced();

-- ── 8 · fiscal periods: CLOSED is left only by a reasoned, named reopen; dates fixed once used ──────
CREATE OR REPLACE FUNCTION ledger_period_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::text <> 'OPEN' THEN
      RAISE EXCEPTION 'LEDGER: only an open, unused fiscal period is deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."startDate", NEW."endDate", NEW."year", NEW."periodNo") IS DISTINCT FROM (OLD."startDate", OLD."endDate", OLD."year", OLD."periodNo")
     AND EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."fiscalPeriodId" = OLD."id") THEN
    RAISE EXCEPTION 'LEDGER: a fiscal period with journal entries keeps its dates' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status"::text = 'CLOSED' AND NEW."status"::text <> 'CLOSED' THEN
    IF NEW."reopenedBy" IS NULL OR length(btrim(coalesce(NEW."reopenReason", ''))) < 3
       OR NEW."reopenedAt" IS NOT DISTINCT FROM OLD."reopenedAt" OR NEW."reopenCount" <> OLD."reopenCount" + 1 THEN
      RAISE EXCEPTION 'LEDGER: a closed fiscal period is reopened only with a reason, by a named person, as a new recorded reopen' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW."reopenCount" <> OLD."reopenCount" OR NEW."reopenedAt" IS DISTINCT FROM OLD."reopenedAt" THEN
    RAISE EXCEPTION 'LEDGER: the reopen record changes only when a closed period is reopened' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_period_guard BEFORE UPDATE OR DELETE ON "FiscalPeriod"
  FOR EACH ROW EXECUTE FUNCTION ledger_period_guard();

-- ── 9 · settings and the opening grid ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ledger_settings_guard() RETURNS trigger AS $$
DECLARE engine_posted boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."openingEntryId" IS NOT NULL AND NEW."openingEntryId" IS DISTINCT FROM OLD."openingEntryId" THEN
      RAISE EXCEPTION 'LEDGER: the opening entry, once recorded, never changes' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."goLiveDate" IS DISTINCT FROM OLD."goLiveDate" OR (OLD."accountingActive" AND NOT NEW."accountingActive") THEN
      engine_posted := EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."idempotencyKey" IS NOT NULL AND ledger_engine_module(j."sourceModule"));
      IF engine_posted THEN
        RAISE EXCEPTION 'LEDGER: once the posting engine has posted, the go-live date and the activation never change' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."openingEntryId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."openingEntryId" IS NULL)
     AND NOT EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."id" = NEW."openingEntryId" AND j."type"::text = 'OPENING' AND j."status"::text = 'POSTED') THEN
    RAISE EXCEPTION 'LEDGER: the opening entry names a posted OPENING journal entry' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_settings_guard BEFORE INSERT OR UPDATE ON "AccountingSettings"
  FOR EACH ROW EXECUTE FUNCTION ledger_settings_guard();

CREATE OR REPLACE FUNCTION ledger_opening_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AccountingSettings" s WHERE s."id" = 'singleton' AND s."openingEntryId" IS NOT NULL) THEN
    RAISE EXCEPTION 'LEDGER: the opening balances are posted; the opening grid is final' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_opening_guard BEFORE INSERT OR UPDATE OR DELETE ON "OpeningBalanceLine"
  FOR EACH ROW EXECUTE FUNCTION ledger_opening_guard();

-- ── 10 · the audit trail ────────────────────────────────────────────────────────────────────────────
-- Who: the actor the application sets for the transaction (SET LOCAL hiqbah.actor_id …), else the row's own
-- updatedBy / createdBy, else 'system'. Context: hiqbah.audit_ip, hiqbah.audit_ua, hiqbah.audit_reason.
CREATE OR REPLACE FUNCTION ledger_audit_row() RETURNS trigger AS $$
DECLARE b jsonb; a jsonb; r jsonb; act text;
BEGIN
  b := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  a := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  r := coalesce(a, b);
  act := TG_OP;
  IF TG_OP = 'UPDATE' AND (a ? 'status') AND (a->>'status') IS DISTINCT FROM (b->>'status') THEN
    act := 'STATUS_' || (a->>'status');
  END IF;
  INSERT INTO "AccountingAuditLog" ("id", "tenantId", "at", "actorId", "action", "entityType", "entityId", "before", "after", "reason", "ip", "userAgent")
  VALUES (gen_random_uuid()::text, coalesce(r->>'tenantId', 'hiqbah'), now(),
          coalesce(nullif(current_setting('hiqbah.actor_id', true), ''), r->>'updatedBy', r->>'reopenedBy', r->>'postedBy', r->>'createdBy', 'system'),
          act, TG_TABLE_NAME, coalesce(r->>'id', r->>'role', '-'), b, a,
          nullif(current_setting('hiqbah.audit_reason', true), ''), nullif(current_setting('hiqbah.audit_ip', true), ''),
          nullif(current_setting('hiqbah.audit_ua', true), ''));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "Account" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "AccountRole" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "FiscalYear" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "FiscalPeriod" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "AccountingSettings" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "JournalEntry" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "OpeningBalanceLine" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

CREATE OR REPLACE FUNCTION ledger_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER: the accounting audit log is append-only' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AccountingAuditLog_append_only" BEFORE UPDATE OR DELETE ON "AccountingAuditLog"
  FOR EACH ROW EXECUTE FUNCTION ledger_audit_append_only();
CREATE TRIGGER "AccountingAuditLog_no_truncate" BEFORE TRUNCATE ON "AccountingAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_audit_append_only();

COMMIT;
