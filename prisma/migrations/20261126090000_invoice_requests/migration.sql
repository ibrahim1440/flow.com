-- «طلب فاتورة ضريبية» — the tax invoice request workflow (BATCH 22 WP-C; owner split 2026-10-29: Sales REQUESTS a tax
-- invoice, the accountant ISSUES it, Sales prints it). Council rulings Q-F3 (the accountant corrects compliance fields
-- only; a commercial term goes back to Sales with a reason) and Q-F5 (a draft has no number; the number, the ICV and the
-- PIH are taken at issue only).
--
-- There is NO new invoice status: a request is a DRAFT with request columns. The lifecycle trigger of
-- 20261103090000_sales_invoicing (sinv_invoice_guard) is untouched.
--   1. "SalesInvoice" gains "requestedAt", "requestedById", "requestNote" (nullable). A draft is in the accountant's queue
--      while status = 'DRAFT' AND "requestedAt" IS NOT NULL (index on (status, requestedAt)). A CHECK keeps the queue
--      honest: "requestedAt" is set only on a DRAFT, always with its requester; an issued or cancelled document has none
--      ("requestedById" stays: the issue notifies the requester and the history names them).
--   2. "SalesInvoiceRequestEvent" — the request history, APPEND-ONLY (sinv_request_event_guard refuses UPDATE and
--      DELETE; sinv_no_truncate refuses TRUNCATE), audited (ledger_audit_row): REQUESTED | WITHDRAWN | RETURNED |
--      EDITED_BY_ACCOUNTANT | ISSUED | CANCELLED, who, when, the return's reason code + reason (≥ 10 characters, CHECK) and
--      the field diff of an accountant's correction.
--   3. The runtime role (flowcom_app), when it exists, is granted the event table and the guard function.
--
-- ADDITIVE: three nullable columns (every existing row NULL: the CHECK holds for all of them), one index, one new empty
-- table, one function and its triggers on the new table only. No existing row is read or rewritten; ZATCA untouched.
-- Atomic: one transaction. Rollback: docs/hr/migration-review/rollback-20261126090000_invoice_requests.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SalesInvoice"
  ADD COLUMN "requestedAt" TIMESTAMP(3),
  ADD COLUMN "requestedById" TEXT,
  ADD COLUMN "requestNote" TEXT;
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_request_check" CHECK (
  ("requestedAt" IS NULL OR ("status" = 'DRAFT' AND "requestedById" IS NOT NULL))
  AND ("requestNote" IS NULL OR length("requestNote") <= 1000));
CREATE INDEX "SalesInvoice_status_requestedAt_idx" ON "SalesInvoice"("status", "requestedAt");

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "SalesInvoiceRequestEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "invoiceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "reasonCode" TEXT,
  "reason" TEXT,
  "diff" JSONB,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesInvoiceRequestEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SalesInvoiceRequestEvent_kind_check" CHECK ("kind" IN ('REQUESTED', 'WITHDRAWN', 'RETURNED', 'EDITED_BY_ACCOUNTANT', 'ISSUED', 'CANCELLED')),
  -- Q-F3: a return names its reason code and explains it (≥ 10 characters); only a return carries a reason code.
  CONSTRAINT "SalesInvoiceRequestEvent_reason_check" CHECK (
    ("kind" <> 'RETURNED' OR ("reasonCode" IN ('PRICE', 'QTY', 'CUSTOMER_DATA', 'DUPLICATE', 'OTHER') AND length(btrim(coalesce("reason", ''))) >= 10))
    AND ("kind" = 'RETURNED' OR "reasonCode" IS NULL)
    AND ("reason" IS NULL OR length("reason") <= 1000)
    AND ("kind" = 'EDITED_BY_ACCOUNTANT' OR "diff" IS NULL)
    AND length(btrim("actorId")) > 0)
);
CREATE INDEX "SalesInvoiceRequestEvent_invoiceId_at_idx" ON "SalesInvoiceRequestEvent"("invoiceId", "at");
ALTER TABLE "SalesInvoiceRequestEvent" ADD CONSTRAINT "SalesInvoiceRequestEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION sinv_request_event_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SINV: the invoice request history is append-only' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sinv_request_event_guard BEFORE UPDATE OR DELETE ON "SalesInvoiceRequestEvent"
  FOR EACH ROW EXECUTE FUNCTION sinv_request_event_guard();
CREATE TRIGGER sinv_no_truncate BEFORE TRUNCATE ON "SalesInvoiceRequestEvent" FOR EACH STATEMENT EXECUTE FUNCTION sinv_no_truncate();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "SalesInvoiceRequestEvent" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SalesInvoiceRequestEvent" TO flowcom_app;
    GRANT EXECUTE ON FUNCTION sinv_request_event_guard() TO flowcom_app;
  END IF;
END $$;

COMMIT;
