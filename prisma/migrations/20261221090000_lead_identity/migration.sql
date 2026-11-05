-- 20261221090000_lead_identity — «عميل محتمل جديد» = the customer form (owner-approved Figma page 12, 5 Nov 2026).
-- A lead now carries what a customer carries: the registration («السجل التجاري / الرقم الموحد» as commercialRegNo or
-- unifiedNumber, the VAT number) and the structured national address, so converting it never asks for them again
-- (services/sales/leads.ts copies them onto the new Customer). The contact person is optional now (owner: «اسم الشخص
-- المسؤول ورقم الجوال والبريد تكون اختياري») — "contactName" drops NOT NULL.
-- Additive and idempotent: nullable TEXT columns with no default, format CHECKs matching the Customer ones
-- (20261220090000_soon_batch, services/customers/customer-identity.ts), each guarded by pg_constraint. No data is
-- written. The runtime role holds table-level UPDATE on "Lead" (only "Customer" is granted column by column, check 81),
-- so the new columns need no grant; the DO block below grants them anyway if a column-level grant ever exists.
-- Rollback: docs/hr/migration-review/rollback-20261221090000_lead_identity.sql. Verifier check 87.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "vatNumber" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "commercialRegNo" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "unifiedNumber" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "nationalBuildingNo" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "nationalStreet" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "nationalDistrict" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "nationalCity" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "nationalPostalCode" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "nationalAdditionalNo" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "nationalShortAddress" TEXT;
ALTER TABLE "Lead" ALTER COLUMN "contactName" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_vatNumber_check') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_vatNumber_check" CHECK ("vatNumber" IS NULL OR "vatNumber" ~ '^3[0-9]{13}3$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_commercialRegNo_check') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_commercialRegNo_check" CHECK ("commercialRegNo" IS NULL OR "commercialRegNo" ~ '^[0-9]{10}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_unifiedNumber_check') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_unifiedNumber_check" CHECK ("unifiedNumber" IS NULL OR "unifiedNumber" ~ '^7[0-9]{9}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_nationalBuildingNo_check') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_nationalBuildingNo_check" CHECK ("nationalBuildingNo" IS NULL OR "nationalBuildingNo" ~ '^[0-9]{4}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_nationalPostalCode_check') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_nationalPostalCode_check" CHECK ("nationalPostalCode" IS NULL OR "nationalPostalCode" ~ '^[0-9]{5}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_nationalAdditionalNo_check') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_nationalAdditionalNo_check" CHECK ("nationalAdditionalNo" IS NULL OR "nationalAdditionalNo" ~ '^[0-9]{4}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_nationalAddress_len_check') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_nationalAddress_len_check" CHECK (
      coalesce(length("nationalStreet"), 0) <= 120 AND coalesce(length("nationalDistrict"), 0) <= 120
      AND coalesce(length("nationalCity"), 0) <= 80 AND coalesce(length("nationalShortAddress"), 0) <= 20);
  END IF;
  -- Column-level UPDATE on "Lead" for the runtime role, only where the role already works column by column there.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app')
     AND EXISTS (SELECT 1 FROM information_schema.column_privileges
                  WHERE table_name = 'Lead' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges
                      WHERE table_name = 'Lead' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
    GRANT UPDATE ("vatNumber", "commercialRegNo", "unifiedNumber", "nationalBuildingNo", "nationalStreet", "nationalDistrict",
                  "nationalCity", "nationalPostalCode", "nationalAdditionalNo", "nationalShortAddress") ON "Lead" TO flowcom_app;
  END IF;
END $$;

COMMIT;
