-- Go-live from Qoyod (owner, 1 Nov 2026): a customer's OPENING balance — carried in from the old books at the go-live date
-- (the OPENING entry's AR line for the party) — is collected through «سندات العملاء» like an invoice. Until now an
-- ACCOUNTANT receipt had to name an issued invoice (SalesCollection_source_check, 20261127090000_customer_receipts), so an
-- opening balance could not be collected at all (AR refuses manual journals).
--   1. SalesCollection_source_check: an ACCOUNTANT receipt names its customer and EITHER an invoice OR none — a receipt for
--      the customer's opening balance. SALES rows are unchanged (a deal, never an invoice). Every existing row satisfies it.
--      The service (src/lib/services/sales/receipts.ts recordOpeningReceipt) bounds such a receipt by what the opening still
--      owes less the pending ones; at confirmation the part its invoices do not take pays the opening first (Cr AR — ar.ts
--      onCollectionApproved), the rest is a customer advance.
--   sales_collection_receipt_guard already freezes "invoiceId" after insert: unchanged.
-- Rollback: docs/hr/migration-review/rollback-20261210090000_ar_opening_receipts.sql.
BEGIN;
ALTER TABLE "SalesCollection" DROP CONSTRAINT "SalesCollection_source_check";
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_source_check" CHECK (
  ("source" = 'SALES' AND "opportunityId" IS NOT NULL AND "invoiceId" IS NULL)
  OR ("source" = 'ACCOUNTANT' AND "opportunityId" IS NULL AND "customerId" IS NOT NULL));
COMMIT;
