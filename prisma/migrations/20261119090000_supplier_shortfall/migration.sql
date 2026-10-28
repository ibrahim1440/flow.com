-- «نقص من المورد» (feat/supplier-shortfall, the accounting council's minimal design). ADDITIVE ONLY, one transaction
-- (PostgreSQL 16 / 17). Today a stock line's quantity is both what was received and what was billed, so a shortfall
-- billed in full is capitalised into the stock's cost — an abnormal loss IAS 2 does not allow. From here:
--
--   1. "SupplierInvoiceLine": the billed quantity apart from the received one — "billedQty" (NULL = as received),
--      "shortfallQty" (billed − received), "shortfallNet" (its value at the line's unit cost), "shortfallTreatment"
--      CLAIM («مطالبة المورد»: Dr SUPPLIER_CLAIMS) | LOSS («خسارة»: Dr PURCHASE_SHORTAGE, a reason ≥ 3 characters) |
--      ABSORBED (within the weight tolerance: into the cost, as IAS 2 allows) and "shortfallReason". One CHECK: all
--      NULL, or all set on a STOCK / GRN line. Every existing row is NULL there.
--   2. "SupplierInvoice"."creditedTotal" (NOT NULL DEFAULT 0, CHECK ≥ 0 and paid + credited ≤ gross —
--      true of every existing row, whose paid ≤ gross is already checked): what supplier credit notes took off the
--      bill (the open amount is gross − paid − credited). A constant default: no rewrite; the CHECK scans once.
--   3. New tables (empty): "SupplierClaim" (one open claim per CLAIM line, written when the invoice posts),
--      "SupplierClaimSettlement" (a credit note, replacement goods or an abandonment against a claim) and
--      "SupplierCreditNote" («إشعار دائن من المورد»: its own SCN number series; Dr AP / Cr SUPPLIER_CLAIMS / Cr VAT_INPUT).
--      Each never deleted (supplier_claim_no_delete), audited (ledger_audit_row) and not truncated (ledger_no_truncate);
--      their amounts are frozen (supplier_claim_guard) and a cancelled invoice's credited total too
--      (supplier_invoice_credited_guard). A credit note above what the invoice still owes carries the excess as a supplier
--      advance ("advanceAmount", Dr SUPPLIER_ADVANCES); a REFUND settlement records cash / bank received against a claim.
--      A LOSS line records the input VAT it reversed ("shortfallVatReversed", the abandonment's VAT setting).
--   4. "SystemConfig": "purchaseShortfallTolerancePercent" (NULL = 0.5 %; CHECK 0–2, council F5) and "purchaseAbandonReverseVat"
--      (NULL = on: abandoning a claim reverses its input VAT — «تحقق مع مستشارك الضريبي»). Nullable: metadata only.
--   5. The posting roles SUPPLIER_CLAIMS («مطالبات الموردين», asset 1167) and PURCHASE_SHORTAGE («خسائر نقص
--      المشتريات», expense 5420): on a chart seeded from the default template (its parents 1100 / 5000 exist), the two
--      accounts are added when their codes are free and the roles mapped when they are not mapped yet — never changing
--      an account or a mapping that exists. Otherwise the accountant maps them («ربط الحسابات»; the readiness lists them).
--   6. The runtime role (flowcom_app), when it exists, is granted the new tables and function.
-- Rollback: docs/hr/migration-review/rollback-20261119090000_supplier_shortfall.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SupplierInvoiceLine"
  ADD COLUMN "billedQty" DECIMAL(18,4),
  ADD COLUMN "shortfallQty" DECIMAL(18,4),
  ADD COLUMN "shortfallNet" DECIMAL(18,2),
  ADD COLUMN "shortfallTreatment" TEXT,
  ADD COLUMN "shortfallReason" TEXT,
  ADD COLUMN "shortfallVatReversed" DECIMAL(18,2);
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_shortfall_check" CHECK (
  ("billedQty" IS NULL AND "shortfallQty" IS NULL AND "shortfallNet" IS NULL AND "shortfallTreatment" IS NULL AND "shortfallReason" IS NULL AND "shortfallVatReversed" IS NULL)
  OR ("kind" IN ('STOCK', 'GRN') AND "billedQty" > 0 AND "shortfallQty" > 0 AND "shortfallQty" <= "billedQty" AND "shortfallNet" >= 0
      AND "shortfallTreatment" IN ('CLAIM', 'LOSS', 'ABSORBED')
      AND ("shortfallTreatment" <> 'LOSS' OR length(btrim(coalesce("shortfallReason", ''))) >= 3)
      AND ("shortfallReason" IS NULL OR length("shortfallReason") <= 500)
      AND ("shortfallVatReversed" IS NULL OR ("shortfallTreatment" = 'LOSS' AND "shortfallVatReversed" >= 0)))
);

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SupplierInvoice" ADD COLUMN "creditedTotal" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_creditedTotal_check" CHECK ("creditedTotal" >= 0 AND "paidTotal" + "creditedTotal" <= "grossTotal");

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "SupplierClaim" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "invoiceId" TEXT NOT NULL,
  "invoiceLineId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "stockKind" TEXT NOT NULL,
  "stockItemId" TEXT NOT NULL,
  "qty" DECIMAL(18,4) NOT NULL,
  "unitCost" DECIMAL(18,6) NOT NULL,
  "net" DECIMAL(18,2) NOT NULL,
  "vatRate" DECIMAL(5,2) NOT NULL,
  "vat" DECIMAL(18,2) NOT NULL,
  "settledQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "settledNet" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "settledVat" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedAt" TIMESTAMP(3),
  "voidReason" TEXT,
  CONSTRAINT "SupplierClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierClaim_status_check" CHECK ("status" IN ('OPEN', 'SETTLED', 'VOID')),
  CONSTRAINT "SupplierClaim_kind_check" CHECK ("stockKind" IN ('GREEN_BEAN', 'MATERIAL')),
  CONSTRAINT "SupplierClaim_amounts_check" CHECK ("qty" > 0 AND "unitCost" > 0 AND "net" > 0 AND "vat" >= 0 AND "vatRate" >= 0
    AND "settledQty" >= 0 AND "settledQty" <= "qty" AND "settledNet" >= 0 AND "settledNet" <= "net" AND "settledVat" >= 0 AND "settledVat" <= "vat"),
  CONSTRAINT "SupplierClaim_settled_check" CHECK ("status" <> 'SETTLED' OR "settledNet" = "net"),
  CONSTRAINT "SupplierClaim_void_check" CHECK (("status" = 'VOID') = ("voidedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "SupplierClaim_invoiceLineId_key" ON "SupplierClaim"("invoiceLineId");
CREATE INDEX "SupplierClaim_supplierId_status_idx" ON "SupplierClaim"("supplierId", "status");
CREATE INDEX "SupplierClaim_invoiceId_idx" ON "SupplierClaim"("invoiceId");
ALTER TABLE "SupplierClaim" ADD CONSTRAINT "SupplierClaim_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierClaim" ADD CONSTRAINT "SupplierClaim_invoiceLineId_fkey" FOREIGN KEY ("invoiceLineId") REFERENCES "SupplierInvoiceLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierClaim" ADD CONSTRAINT "SupplierClaim_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SupplierCreditNote" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "number" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  "supplierRef" TEXT NOT NULL,
  "noteDate" DATE NOT NULL,
  "net" DECIMAL(18,2) NOT NULL,
  "vat" DECIMAL(18,2) NOT NULL,
  "gross" DECIMAL(18,2) NOT NULL,
  "advanceAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'POSTED',
  "journalEntryId" TEXT,
  "notes" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledBy" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "cancelReason" TEXT,
  CONSTRAINT "SupplierCreditNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierCreditNote_status_check" CHECK ("status" IN ('POSTED', 'CANCELLED')),
  CONSTRAINT "SupplierCreditNote_amounts_check" CHECK ("net" > 0 AND "vat" >= 0 AND "gross" = "net" + "vat" AND "advanceAmount" >= 0 AND "advanceAmount" <= "gross"),
  CONSTRAINT "SupplierCreditNote_ref_check" CHECK (length(btrim("supplierRef")) BETWEEN 1 AND 60),
  CONSTRAINT "SupplierCreditNote_cancel_check" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL) AND ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancelReason", ''))) >= 3))
);
CREATE UNIQUE INDEX "SupplierCreditNote_number_key" ON "SupplierCreditNote"("number");
CREATE INDEX "SupplierCreditNote_supplierId_status_idx" ON "SupplierCreditNote"("supplierId", "status");
CREATE INDEX "SupplierCreditNote_invoiceId_idx" ON "SupplierCreditNote"("invoiceId");
CREATE INDEX "SupplierCreditNote_noteDate_idx" ON "SupplierCreditNote"("noteDate");
ALTER TABLE "SupplierCreditNote" ADD CONSTRAINT "SupplierCreditNote_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierCreditNote" ADD CONSTRAINT "SupplierCreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierCreditNote" ADD CONSTRAINT "SupplierCreditNote_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "SupplierClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SupplierClaimSettlement" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "claimId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "qty" DECIMAL(18,4),
  "net" DECIMAL(18,2) NOT NULL,
  "vat" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "reverseVat" BOOLEAN NOT NULL DEFAULT false,
  "creditNoteId" TEXT,
  "purchaseRecordId" TEXT,
  "journalEntryId" TEXT,
  "reason" TEXT,
  "method" TEXT,
  "reference" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedAt" TIMESTAMP(3),
  "voidedBy" TEXT,
  "voidReason" TEXT,
  CONSTRAINT "SupplierClaimSettlement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierClaimSettlement_kind_check" CHECK ("kind" IN ('CREDIT_NOTE', 'REPLACEMENT', 'ABANDON', 'REFUND')),
  CONSTRAINT "SupplierClaimSettlement_amounts_check" CHECK ("net" > 0 AND "vat" >= 0 AND ("qty" IS NULL OR "qty" > 0)),
  CONSTRAINT "SupplierClaimSettlement_link_check" CHECK (
    ("kind" = 'CREDIT_NOTE' AND "creditNoteId" IS NOT NULL) OR ("kind" = 'REPLACEMENT' AND "purchaseRecordId" IS NOT NULL AND "qty" IS NOT NULL AND "vat" = 0)
    OR ("kind" = 'ABANDON' AND length(btrim(coalesce("reason", ''))) >= 3 AND ("reverseVat" OR "vat" = 0))
    OR ("kind" = 'REFUND' AND "method" IN ('BANK_TRANSFER', 'CASH') AND ("reverseVat" OR "vat" = 0)))
);
CREATE INDEX "SupplierClaimSettlement_claimId_idx" ON "SupplierClaimSettlement"("claimId");
CREATE INDEX "SupplierClaimSettlement_purchaseRecordId_idx" ON "SupplierClaimSettlement"("purchaseRecordId");
ALTER TABLE "SupplierClaimSettlement" ADD CONSTRAINT "SupplierClaimSettlement_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "SupplierClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierClaimSettlement" ADD CONSTRAINT "SupplierClaimSettlement_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "SupplierCreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION supplier_claim_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AP_CLAIM_KEPT: a supplier claim, its settlements and supplier credit notes are never deleted (void or cancel them)' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER supplier_claim_no_delete BEFORE DELETE ON "SupplierClaim" FOR EACH ROW EXECUTE FUNCTION supplier_claim_no_delete();
CREATE TRIGGER supplier_claim_no_delete BEFORE DELETE ON "SupplierClaimSettlement" FOR EACH ROW EXECUTE FUNCTION supplier_claim_no_delete();
CREATE TRIGGER supplier_claim_no_delete BEFORE DELETE ON "SupplierCreditNote" FOR EACH ROW EXECUTE FUNCTION supplier_claim_no_delete();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "SupplierClaim" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "SupplierClaimSettlement" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "SupplierCreditNote" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "SupplierClaim" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "SupplierClaimSettlement" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "SupplierCreditNote" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- The amounts the books carry never change in place (council F7): a claim's quantity / net / VAT and its source; a
-- settlement's amounts (it is only voided); a credit note's amounts and links (POSTED → CANCELLED only, its entry set
-- once); and an invoice's "creditedTotal" once the invoice is CANCELLED.
CREATE OR REPLACE FUNCTION supplier_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'SupplierClaim' THEN
    IF NEW."qty" <> OLD."qty" OR NEW."net" <> OLD."net" OR NEW."vat" <> OLD."vat" OR NEW."unitCost" <> OLD."unitCost" OR NEW."vatRate" <> OLD."vatRate"
       OR NEW."invoiceId" <> OLD."invoiceId" OR NEW."invoiceLineId" <> OLD."invoiceLineId" OR NEW."supplierId" <> OLD."supplierId"
       OR NEW."stockKind" <> OLD."stockKind" OR NEW."stockItemId" <> OLD."stockItemId" OR OLD."status" = 'VOID' THEN
      RAISE EXCEPTION 'AP_CLAIM_FROZEN: a supplier claim''s quantity, amounts and source never change (a void claim not at all)' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'SupplierClaimSettlement' THEN
    IF NEW."claimId" <> OLD."claimId" OR NEW."kind" <> OLD."kind" OR NEW."net" <> OLD."net" OR NEW."vat" <> OLD."vat" OR NEW."reverseVat" <> OLD."reverseVat"
       OR NEW."qty" IS DISTINCT FROM OLD."qty" OR NEW."creditNoteId" IS DISTINCT FROM OLD."creditNoteId" OR NEW."purchaseRecordId" IS DISTINCT FROM OLD."purchaseRecordId"
       OR (OLD."journalEntryId" IS NOT NULL AND NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId") OR OLD."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'AP_CLAIM_FROZEN: a claim settlement''s amounts never change (it is only voided, once)' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF NEW."net" <> OLD."net" OR NEW."vat" <> OLD."vat" OR NEW."gross" <> OLD."gross" OR NEW."advanceAmount" <> OLD."advanceAmount"
       OR NEW."number" <> OLD."number" OR NEW."supplierId" <> OLD."supplierId" OR NEW."invoiceId" <> OLD."invoiceId" OR NEW."claimId" <> OLD."claimId"
       OR NEW."noteDate" <> OLD."noteDate" OR NEW."supplierRef" <> OLD."supplierRef"
       OR (OLD."journalEntryId" IS NOT NULL AND NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId")
       OR OLD."status" = 'CANCELLED' OR (NEW."status" <> OLD."status" AND NEW."status" <> 'CANCELLED') THEN
      RAISE EXCEPTION 'AP_CREDIT_NOTE_FROZEN: a posted supplier credit note''s amounts never change; it is only cancelled, once' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_claim_guard BEFORE UPDATE ON "SupplierClaim" FOR EACH ROW EXECUTE FUNCTION supplier_claim_guard();
CREATE TRIGGER supplier_claim_guard BEFORE UPDATE ON "SupplierClaimSettlement" FOR EACH ROW EXECUTE FUNCTION supplier_claim_guard();
CREATE TRIGGER supplier_claim_guard BEFORE UPDATE ON "SupplierCreditNote" FOR EACH ROW EXECUTE FUNCTION supplier_claim_guard();

CREATE OR REPLACE FUNCTION supplier_invoice_credited_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'CANCELLED' AND NEW."creditedTotal" <> OLD."creditedTotal" THEN
    RAISE EXCEPTION 'AP_INVOICE_POSTED: a cancelled supplier invoice''s credited total is frozen' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_invoice_credited_guard BEFORE UPDATE OF "creditedTotal" ON "SupplierInvoice" FOR EACH ROW EXECUTE FUNCTION supplier_invoice_credited_guard();

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SystemConfig"
  ADD COLUMN "purchaseShortfallTolerancePercent" DECIMAL(5,2),
  ADD COLUMN "purchaseAbandonReverseVat" BOOLEAN;
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_purchaseShortfall_check" CHECK ("purchaseShortfallTolerancePercent" IS NULL OR ("purchaseShortfallTolerancePercent" >= 0 AND "purchaseShortfallTolerancePercent" <= 2));

-- 5 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE p text; a text;
BEGIN
  -- SUPPLIER_CLAIMS → 1167 under 1100 (current assets); fed by the claims sub-ledger (no manual journal).
  IF NOT EXISTS (SELECT 1 FROM "AccountRole" WHERE "tenantId" = 'hiqbah' AND "role" = 'SUPPLIER_CLAIMS') THEN
    SELECT "id" INTO p FROM "Account" WHERE "code" = '1100';
    IF p IS NOT NULL THEN
      SELECT "id" INTO a FROM "Account" WHERE "code" = '1167' AND "type"::text = 'ASSET' AND "allowPosting" AND "isActive";
      IF a IS NULL AND NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '1167') THEN
        a := 'acc_' || replace(gen_random_uuid()::text, '-', '');
        INSERT INTO "Account" ("id", "code", "nameAr", "nameEn", "parentId", "type", "allowPosting", "isActive", "allowManualJournal", "createdBy", "updatedBy", "updatedAt")
        VALUES (a, '1167', 'مطالبات الموردين', 'Supplier claims', p, 'ASSET', true, true, false, 'migration', 'migration', now());
      END IF;
      IF a IS NOT NULL THEN
        INSERT INTO "AccountRole" ("id", "tenantId", "role", "accountId", "updatedBy", "updatedAt") VALUES ('ar_' || replace(gen_random_uuid()::text, '-', ''), 'hiqbah', 'SUPPLIER_CLAIMS', a, 'migration', now());
      END IF;
    END IF;
  END IF;
  p := NULL; a := NULL;
  -- PURCHASE_SHORTAGE → 5420 under 5000 (cost of sales and operations).
  IF NOT EXISTS (SELECT 1 FROM "AccountRole" WHERE "tenantId" = 'hiqbah' AND "role" = 'PURCHASE_SHORTAGE') THEN
    SELECT "id" INTO p FROM "Account" WHERE "code" = '5000';
    IF p IS NOT NULL THEN
      SELECT "id" INTO a FROM "Account" WHERE "code" = '5420' AND "type"::text = 'EXPENSE' AND "allowPosting" AND "isActive";
      IF a IS NULL AND NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '5420') THEN
        a := 'acc_' || replace(gen_random_uuid()::text, '-', '');
        INSERT INTO "Account" ("id", "code", "nameAr", "nameEn", "parentId", "type", "allowPosting", "isActive", "allowManualJournal", "createdBy", "updatedBy", "updatedAt")
        VALUES (a, '5420', 'خسائر نقص المشتريات', 'Purchase shortage losses', p, 'EXPENSE', true, true, true, 'migration', 'migration', now());
      END IF;
      IF a IS NOT NULL THEN
        INSERT INTO "AccountRole" ("id", "tenantId", "role", "accountId", "updatedBy", "updatedAt") VALUES ('ar_' || replace(gen_random_uuid()::text, '-', ''), 'hiqbah', 'PURCHASE_SHORTAGE', a, 'migration', now());
      END IF;
    END IF;
  END IF;
END $$;

-- 6 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SupplierClaim", "SupplierClaimSettlement", "SupplierCreditNote" TO flowcom_app;
    GRANT EXECUTE ON FUNCTION supplier_claim_no_delete(), supplier_claim_guard(), supplier_invoice_credited_guard() TO flowcom_app;
  END IF;
END $$;

COMMIT;
