-- Accounting audit fixes (Oct 2026 accounting audit: F-1, F-2; F-3 is application-only). Additive only: two new
-- functions and new triggers; no table, column, constraint or existing function changes, no data is read or written.
--
-- F-2 · TRUNCATE. Row triggers never fire on TRUNCATE, and AccountingAuditLog records nothing for it, so a single
--   `TRUNCATE "JournalEntry" CASCADE` erased the posted ledger without trace. Every book-of-record table of the
--   accounting module now refuses TRUNCATE, as AccountingAuditLog, SalesInvoice / ArApplication, CostMove,
--   PeriodCloseReview and the ZATCA tables already do. A disposable-database fixture that wipes with TRUNCATE turns the
--   triggers off for its own transaction first (SET LOCAL session_replication_role = replica), as the HR, workspace and
--   marketing fixtures already do. HR's own tables (HrJournalLink…) keep HR's controls and are not touched here.
CREATE OR REPLACE FUNCTION ledger_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER: % is part of the books and is never truncated', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "JournalEntry" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "JournalEntryLine" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "AccountingCounter" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "OpeningBalanceLine" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "FiscalPeriod" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "FiscalYear" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "Account" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "AccountRole" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "AccountingSettings" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "SalesInvoiceLine" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "SalesDocumentCounter" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "CostItem" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "SupplierInvoice" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "SupplierInvoiceLine" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "SupplierPayment" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "SupplierPaymentAllocation" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();

-- F-1 · A closed fiscal year takes no posting. closeYear closes December only; the other eleven months stay LOCKED, and
--   unlockFiscalPeriod used to reopen them, so P&L postings landed after the year's CLOSING entry (its retained
--   earnings no longer matched the P&L). The application now refuses that unlock (YEAR_CLOSED); here the database
--   refuses any entry BECOMING POSTED in a period of a CLOSED year. The CLOSING entry itself is posted before its year
--   is marked CLOSED, in the same transaction, so it passes. BEFORE triggers fire in name order, so it runs before
--   ledger_entry_guard (and after the HrA* guards); it only reads and refuses, so the order changes nothing — a refusal
--   rolls back whatever the other guards did (including the posting number, which is never consumed).
CREATE OR REPLACE FUNCTION ledger_closed_year_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."status"::text = 'POSTED' AND (TG_OP = 'INSERT' OR OLD."status"::text IS DISTINCT FROM 'POSTED')
     AND EXISTS (SELECT 1 FROM "FiscalPeriod" p JOIN "FiscalYear" y ON y."id" = p."fiscalYearId"
                  WHERE p."id" = NEW."fiscalPeriodId" AND y."status"::text = 'CLOSED') THEN
    RAISE EXCEPTION 'LEDGER: the fiscal year is closed: posting into it is refused' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_closed_year_guard BEFORE INSERT OR UPDATE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_closed_year_guard();
