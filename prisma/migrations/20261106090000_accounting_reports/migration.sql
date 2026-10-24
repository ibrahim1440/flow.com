-- Accounting A5 — financial statements, VAT return, period / year-end close, the SoD setting (feat/accounting-reports).
-- docs/accounting/POSTING-CONTRACT.md §13. Additive only, one transaction:
--   * "AccountingSettings": two defaulted SoD toggles (sodAllowSelfApproval, sodApproverMayPost — both true: one
--     accountant today; every use is flagged and listed in the SoD exceptions report);
--   * "Account"."reportGroup" (nullable; NULL = inferred from the account's place in the chart) with a CHECK;
--   * "FiscalYear": closedAt / closedBy / closingEntryId (the year-end close);
--   * "PeriodCloseReview": the close checklist as run at each review / soft close / close / year-end (append-only);
--   * the A1 audit trigger (ledger_audit_row) on the A3 AP and costing tables, which had none (council review: who
--     changed a supplier invoice, a payment, an expense category's account, the costing policy, an opening cost, a
--     supplier's VAT number or terms);
--   * ledger_engine_entry() admits the engine's CLOSING entry (the year-end close posts through postEntry), so the
--     Phase-1 manual-journal guard keeps refusing everything else exactly as before.
-- No new index: EXPLAIN on 50,000 posted lines (tests/accounting/perf-seed.sql) shows the statements' per-account
-- aggregate is a hash join over sequential scans (~50 ms for a full year with a comparative) and a month uses the A1
-- partial index JournalEntry_posted_entryDate_idx (~12 ms); a covering line index was tried and not used.
BEGIN;

ALTER TABLE "AccountingSettings"
  ADD COLUMN "sodAllowSelfApproval" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sodApproverMayPost" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Account" ADD COLUMN "reportGroup" TEXT;
ALTER TABLE "Account" ADD CONSTRAINT "Account_reportGroup_check" CHECK ("reportGroup" IS NULL OR "reportGroup" IN (
  'CURRENT_ASSET', 'NON_CURRENT_ASSET', 'CURRENT_LIABILITY', 'NON_CURRENT_LIABILITY', 'EQUITY',
  'REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME_EXPENSE', 'ZAKAT'));

ALTER TABLE "FiscalYear"
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "closedBy" TEXT,
  ADD COLUMN "closingEntryId" TEXT;

CREATE TABLE "PeriodCloseReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "fiscalPeriodId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "results" JSONB NOT NULL,
    "blocking" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "actorId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PeriodCloseReview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PeriodCloseReview_action_check" CHECK ("action" IN ('REVIEW', 'SOFT_CLOSE', 'CLOSE', 'YEAR_END')),
    CONSTRAINT "PeriodCloseReview_counts_check" CHECK ("blocking" >= 0 AND "warnings" >= 0)
);
CREATE INDEX "PeriodCloseReview_fiscalPeriodId_at_idx" ON "PeriodCloseReview"("fiscalPeriodId", "at");
ALTER TABLE "PeriodCloseReview" ADD CONSTRAINT "PeriodCloseReview_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "FiscalPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The close record is evidence: never changed, never deleted, never truncated.
CREATE OR REPLACE FUNCTION ledger_close_review_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER: a period close review is a record: it is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_close_review_guard BEFORE UPDATE OR DELETE ON "PeriodCloseReview"
  FOR EACH ROW EXECUTE FUNCTION ledger_close_review_guard();
-- TRUNCATE is refused while the table holds a record; an empty table (a fresh disposable database a fixture resets
-- with TRUNCATE … CASCADE from "FiscalPeriod") has nothing to protect.
CREATE OR REPLACE FUNCTION ledger_close_review_no_truncate() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PeriodCloseReview") THEN
    RAISE EXCEPTION 'LEDGER: a period close review is a record: it is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_close_review_no_truncate BEFORE TRUNCATE ON "PeriodCloseReview"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_close_review_no_truncate();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "PeriodCloseReview" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- The A3 AP and costing documents join the accounting audit trail (who, when, before / after, IP, device).
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "SupplierInvoice" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "SupplierInvoiceLine" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "SupplierPayment" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "SupplierPaymentAllocation" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "ExpenseCategory" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "CostingSettings" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "InventoryOpeningCost" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
-- The supplier as an AP party (its VAT number decides whether input VAT is recoverable; its terms set due dates).
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "Supplier" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- The year-end closing entry is an engine entry (accounting · YEAR_END · <year> · CLOSED, type CLOSING).
CREATE OR REPLACE FUNCTION ledger_engine_entry(m text, t text, k text) RETURNS boolean AS $$
  SELECT ledger_engine_module(m) AND t IN ('AUTO', 'REVERSAL', 'OPENING', 'CLOSING') AND k IS NOT NULL
$$ LANGUAGE sql IMMUTABLE;

COMMIT;
