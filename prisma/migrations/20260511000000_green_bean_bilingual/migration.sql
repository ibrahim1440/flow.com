-- AlterTable: add bilingual fields and isActive to GreenBean
-- Safe for existing records: nullable AR fields, isActive defaults true
ALTER TABLE "GreenBean" ADD COLUMN "beanTypeAr" TEXT;
ALTER TABLE "GreenBean" ADD COLUMN "countryAr"  TEXT;
ALTER TABLE "GreenBean" ADD COLUMN "regionAr"   TEXT;
ALTER TABLE "GreenBean" ADD COLUMN "processAr"  TEXT;
ALTER TABLE "GreenBean" ADD COLUMN "isActive"   BOOLEAN NOT NULL DEFAULT true;
