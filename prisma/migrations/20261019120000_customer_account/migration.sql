-- Customer account page (Figma crm-account 179:1312 / 178:1353; UI batch 3).
-- ADDITIVE ONLY: eight NULLABLE columns on "Customer" (no default, so no existing row is rewritten
-- and every existing customer reads "not set"), one new table "CustomerContact", three new
-- indexes and two new foreign keys (one from a new column, one from the new table). Nothing is
-- dropped, renamed, retyped, made NOT NULL or back-filled.
--   Customer.commercialRegNo / vatNumber / segment / city / priceList / paymentTermsDays /
--   creditLimit (DECIMAL(18,2)) / accountOwnerId (-> Employee, ON DELETE SET NULL)
--   CustomerContact (name, role, phone, email, position) -> Customer ON DELETE CASCADE
--   Activity_customerId_idx: the account timeline reads activities by customer.
-- Atomic: the whole file runs in one transaction. ADD COLUMN without a default is metadata-only;
-- the two CREATE INDEX on existing tables take a SHARE lock on "Customer" / "Activity" for the
-- time of the build (both small). The new FK on "Customer"."accountOwnerId" validates against
-- NULLs only. Rollback: docs/hr/migration-review/rollback-20261019120000_customer_account.sql.
BEGIN;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "accountOwnerId" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "commercialRegNo" TEXT,
ADD COLUMN     "creditLimit" DECIMAL(18,2),
ADD COLUMN     "paymentTermsDays" INTEGER,
ADD COLUMN     "priceList" TEXT,
ADD COLUMN     "segment" TEXT,
ADD COLUMN     "vatNumber" TEXT;

-- CreateTable
CREATE TABLE "CustomerContact" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerContact_customerId_position_idx" ON "CustomerContact"("customerId", "position");

-- CreateIndex
CREATE INDEX "Activity_customerId_idx" ON "Activity"("customerId");

-- CreateIndex
CREATE INDEX "Customer_accountOwnerId_idx" ON "Customer"("accountOwnerId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_accountOwnerId_fkey" FOREIGN KEY ("accountOwnerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerContact" ADD CONSTRAINT "CustomerContact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
