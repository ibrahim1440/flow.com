-- 20261230090000_p0_rep_security — P0 security batch (owner-approved decisions C1–C6, 11 Nov 2026; rep QA audit):
--   1. "Quote"."discountApprovedTermsHash" (+ "approvalRequired" / "approvalBasisPercent", the draft's need as last saved): the fingerprint of the financial terms a discount / custom-line approval was given
--      on (lines, quantities, prices, discounts, VAT, validity, currency). An approval covers an issue only while the
--      quotation's fingerprint is the same (C3); NULL = no approval, or one recorded before this batch (renewed — C1).
--   2. "SalesInvoiceDraftControl": one row per direct-sale / sample invoice draft — the terms as first sent to the
--      accountant (the «تعدّلت بعد الإرسال» diff) and the supervisor's discount approval of the SAME draft after an edit
--      (C4): PENDING / APPROVED / REJECTED with the fingerprint and the percent it covers. An issued invoice is never
--      touched here (the issue reads it; the row is not changed after issue).
--   3. "TaxOverrideRequest": a change of a line's VAT treatment on a DRAFT quotation or invoice draft (C5): the proposed
--      ZATCA treatment per line with its reason code, the written reason, the requester and an INDEPENDENT decision
--      (a CHECK: the decider is never the requester). Append-only in practice (no DELETE grant).
-- Additive: three columns (two nullable, one defaulting to false), two new tables. No existing row is read or written.
-- Rollback: docs/hr/migration-review/rollback-20261230090000_p0_rep_security.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1 ───────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Quote" ADD COLUMN "discountApprovedTermsHash" TEXT;
-- The approval need of a DRAFT as its lines were last saved (SEC-01 / C2): any custom line (no SKU, or an active SKU at
-- price 0), or the highest line's effective discount against the list price above the threshold. The lists, the inbox and
-- the editor read it; the issue recomputes it from the lines. NULL basis = a draft saved before this batch.
ALTER TABLE "Quote" ADD COLUMN "approvalRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Quote" ADD COLUMN "approvalBasisPercent" DECIMAL(9,6);
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_approval_basis_check"
  CHECK ("approvalBasisPercent" IS NULL OR ("approvalBasisPercent" >= 0 AND "approvalBasisPercent" <= 100));
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_approval_hash_check"
  CHECK ("discountApprovedTermsHash" IS NULL OR "discountApprovedTermsHash" ~ '^[0-9a-f]{64}$');

-- 2 ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "SalesInvoiceDraftControl" (
  "invoiceId"        TEXT NOT NULL,
  "kind"             TEXT NOT NULL,
  "baselineTerms"    JSONB NOT NULL,
  "baselineHash"     TEXT NOT NULL,
  "approvalStatus"   TEXT,
  "approvalHash"     TEXT,
  "approvalPercent"  DECIMAL(6,2),
  "requestedById"    TEXT,
  "requestedAt"      TIMESTAMP(3),
  "decidedById"      TEXT,
  "decidedAt"        TIMESTAMP(3),
  "decisionNote"     TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesInvoiceDraftControl_pkey" PRIMARY KEY ("invoiceId"),
  CONSTRAINT "SalesInvoiceDraftControl_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SalesInvoiceDraftControl_kind_check" CHECK ("kind" IN ('DIRECT_SALE', 'SAMPLE')),
  CONSTRAINT "SalesInvoiceDraftControl_hash_check" CHECK ("baselineHash" ~ '^[0-9a-f]{64}$' AND ("approvalHash" IS NULL OR "approvalHash" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "SalesInvoiceDraftControl_status_check" CHECK ("approvalStatus" IS NULL OR "approvalStatus" IN ('PENDING', 'APPROVED', 'REJECTED')),
  -- PENDING: asked by someone; APPROVED / REJECTED: decided by someone else than the one who asked (never self).
  CONSTRAINT "SalesInvoiceDraftControl_shape_check" CHECK (
    ("approvalStatus" IS NULL AND "approvalHash" IS NULL)
    OR ("approvalStatus" = 'PENDING' AND "approvalHash" IS NOT NULL AND "requestedById" IS NOT NULL AND "decidedById" IS NULL)
    OR ("approvalStatus" IN ('APPROVED', 'REJECTED') AND "approvalHash" IS NOT NULL AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)),
  CONSTRAINT "SalesInvoiceDraftControl_percent_check" CHECK ("approvalPercent" IS NULL OR ("approvalPercent" >= 0 AND "approvalPercent" <= 100))
);
CREATE INDEX "SalesInvoiceDraftControl_status_idx" ON "SalesInvoiceDraftControl"("approvalStatus") WHERE "approvalStatus" = 'PENDING';

-- 3 ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "TaxOverrideRequest" (
  "id"            TEXT PRIMARY KEY,
  "documentType"  TEXT NOT NULL,
  "documentId"    TEXT NOT NULL,
  "lines"         JSONB NOT NULL,
  "reason"        TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById"   TEXT,
  "decidedAt"     TIMESTAMP(3),
  "decisionNote"  TEXT,
  CONSTRAINT "TaxOverrideRequest_doc_check" CHECK ("documentType" IN ('QUOTE', 'INVOICE')),
  CONSTRAINT "TaxOverrideRequest_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT "TaxOverrideRequest_reason_check" CHECK (length(btrim("reason")) BETWEEN 5 AND 1000),
  CONSTRAINT "TaxOverrideRequest_lines_check" CHECK (jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") BETWEEN 1 AND 200),
  -- Independent approval (owner, C5): the decision is never the requester's.
  CONSTRAINT "TaxOverrideRequest_independent_check" CHECK ("decidedById" IS NULL OR "decidedById" <> "requestedById"),
  CONSTRAINT "TaxOverrideRequest_decided_check" CHECK (("status" = 'PENDING') = ("decidedById" IS NULL AND "decidedAt" IS NULL))
);
CREATE INDEX "TaxOverrideRequest_documentType_documentId_status_idx" ON "TaxOverrideRequest"("documentType", "documentId", "status");
CREATE INDEX "TaxOverrideRequest_pending_idx" ON "TaxOverrideRequest"("requestedAt") WHERE "status" = 'PENDING';

-- The runtime role: the two new tables are the app's to read and write (no DELETE on the override record); the new
-- "Quote" column gets a grant only where the role works column by column there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SalesInvoiceDraftControl" TO flowcom_app;
    GRANT SELECT, INSERT, UPDATE ON "TaxOverrideRequest" TO flowcom_app;
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_name = 'Quote' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_name = 'Quote' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
      GRANT SELECT ("discountApprovedTermsHash", "approvalRequired", "approvalBasisPercent"), UPDATE ("discountApprovedTermsHash", "approvalRequired", "approvalBasisPercent") ON "Quote" TO flowcom_app;
    END IF;
  END IF;
END $$;

COMMIT;
