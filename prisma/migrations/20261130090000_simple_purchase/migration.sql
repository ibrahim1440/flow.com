-- «فواتير بسيطة» — simple expense invoices (BATCH22 WP-H; owner answer 5, the council's best practice). ADDITIVE ONLY, one
-- transaction (PostgreSQL 16 / 17). A simple invoice is the EXISTING purchase invoice ("SupplierInvoice") with
-- kind = 'SIMPLE': the same numbering (SINV), the same posting (Dr expense / VAT input, Cr AP) and the same AP — not a new
-- document type. What qualifies (expense lines only, at most 5, at most SAR 5,000 gross a line), the VAT rule (box 7 only
-- with the vendor's VAT number and the receipt attached) and the mandatory receipt attachment are the service's
-- (src/lib/accounting/ops/simple-purchase.ts); the database holds the columns and the vendor rule.
--
--   1. "SupplierInvoice"."kind" ('STANDARD' default | 'SIMPLE', CHECK; existing rows are STANDARD — a constant default,
--      metadata only) and the one-off vendor's particulars "vendorName" / "vendorVatNumber" (nullable; the VAT number is
--      15 digits starting and ending with 3 — CHECK). Index (kind, status) for «فواتير بسيطة» (the list filtered SIMPLE).
--   2. The supplier «مورد نقدي متنوع» (id 'sup_misc_cash', code MISC-CASH in the design) is seeded: the AP party of one-off
--      vendors. Its invoices are SIMPLE and name the vendor (vendorName required); any other supplier's invoice names no
--      vendor (supplier_invoice_vendor_check, BEFORE INSERT / UPDATE).
--   3. The supplier-reference uniqueness: the existing live-invoice index ("supplierId", lower(btrim("supplierRef")))
--      is recreated for invoices without a vendor; a MISC-CASH invoice is unique per (vendor — its VAT number, else its
--      name — and reference), so two vendors' receipt numbers never collide (SupplierInvoice_vendor_ref_live_key).
--   4. The runtime role (flowcom_app), when it exists, is granted the new function (no new table).
-- Rollback: docs/hr/migration-review/rollback-20261130090000_simple_purchase.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SupplierInvoice" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "SupplierInvoice" ADD COLUMN "vendorName" TEXT;
ALTER TABLE "SupplierInvoice" ADD COLUMN "vendorVatNumber" TEXT;
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_kind_check" CHECK ("kind" IN ('STANDARD', 'SIMPLE'));
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_vendor_check" CHECK (
  ("vendorName" IS NULL OR (length(btrim("vendorName")) BETWEEN 1 AND 200))
  AND ("vendorVatNumber" IS NULL OR "vendorVatNumber" ~ '^3[0-9]{13}3$')
  AND ("vendorVatNumber" IS NULL OR "vendorName" IS NOT NULL));
CREATE INDEX "SupplierInvoice_kind_status_idx" ON "SupplierInvoice" ("kind", "status");

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
INSERT INTO "Supplier" ("id", "name", "createdAt", "kind", "isNonResident")
VALUES ('sup_misc_cash', 'مورد نقدي متنوع', now(), 'GOODS_SERVICES', false)
ON CONFLICT ("id") DO NOTHING;

CREATE OR REPLACE FUNCTION supplier_invoice_vendor_check() RETURNS trigger AS $$
BEGIN
  IF NEW."supplierId" = 'sup_misc_cash' THEN
    IF NEW."vendorName" IS NULL THEN
      RAISE EXCEPTION 'AP_VENDOR_REQUIRED: an invoice of «مورد نقدي متنوع» names its vendor' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" <> 'SIMPLE' THEN
      RAISE EXCEPTION 'AP_VENDOR_REQUIRED: «مورد نقدي متنوع» is used on a simple invoice only' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."vendorName" IS NOT NULL OR NEW."vendorVatNumber" IS NOT NULL THEN
    RAISE EXCEPTION 'AP_VENDOR_REQUIRED: only an invoice of «مورد نقدي متنوع» names a vendor' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER supplier_invoice_vendor_check BEFORE INSERT OR UPDATE OF "supplierId", "kind", "vendorName", "vendorVatNumber" ON "SupplierInvoice"
  FOR EACH ROW EXECUTE FUNCTION supplier_invoice_vendor_check();

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "SupplierInvoice_supplier_ref_live_key";
CREATE UNIQUE INDEX "SupplierInvoice_supplier_ref_live_key" ON "SupplierInvoice" ("supplierId", lower(btrim("supplierRef")))
  WHERE "status" <> 'CANCELLED' AND "vendorName" IS NULL;
CREATE UNIQUE INDEX "SupplierInvoice_vendor_ref_live_key" ON "SupplierInvoice"
  ("supplierId", coalesce("vendorVatNumber", lower(btrim("vendorName"))), lower(btrim("supplierRef")))
  WHERE "status" <> 'CANCELLED' AND "vendorName" IS NOT NULL;

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT EXECUTE ON FUNCTION supplier_invoice_vendor_check() TO flowcom_app;
  END IF;
END $$;

COMMIT;
