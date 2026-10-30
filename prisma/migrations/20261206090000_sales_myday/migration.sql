-- «يومي» — the sales rep's day (batch 24 WP-B; docs: BATCH24-DESIGN.md §WP-B).
--
--   1. ActivityType + WHATSAPP «واتساب» and EMAIL «بريد»: most contact with a café is a WhatsApp message, and «آخر تواصل»
--      would be wrong for every rep without it. Two ADD VALUE statements of their own; nothing in this migration (or any
--      later one in the batch) USES the new values, so the batch-23 lesson (55P04: a new enum value cannot be used in the
--      transaction that added it) does not arise. Recording the contact is still not sending a message.
--   2. The tier / growth / contact thresholds on "SystemConfig" (the sales settings row), with the owner's values as the
--      constant defaults (metadata only, no row rewritten) and CHECKs every default meets. Tiers are DERIVED at read time
--      (src/lib/services/sales/my-day/tiers.ts) and never stored.
--   3. "SalesCallSnooze": «أجّل لبكرة» on the phone call list — one row per (rep, customer), the date the customer comes back.
--      A per-person convenience, never a business record; deleting a customer or an employee removes its rows.
--   4. Two indexes for the page's reads (≤ 6 round-trips with 500 customers per rep): the last contact per customer
--      ("Activity" by customer and completion) and the order lines of a set of orders ("OrderItem" by order).
--   5. The runtime role (flowcom_app), when it exists, is granted the new table. Nothing for erp_app (retired).
--
-- ADDITIVE: no existing row is read or rewritten. Rollback: docs/hr/migration-review/rollback-20261206090000_sales_myday.sql
-- (the two enum values stay — PostgreSQL cannot drop them; accepted, as for every enum value before).

ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'WHATSAPP';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'EMAIL';

ALTER TABLE "SystemConfig" ADD COLUMN "tierVipTopPct"        DECIMAL(5,2)  NOT NULL DEFAULT 20;
ALTER TABLE "SystemConfig" ADD COLUMN "tierVipMinKgMonth"    DECIMAL(10,2) NOT NULL DEFAULT 40;
ALTER TABLE "SystemConfig" ADD COLUMN "tierSmallMaxKgMonth"  DECIMAL(10,2) NOT NULL DEFAULT 10;
ALTER TABLE "SystemConfig" ADD COLUMN "growthMinPct"         DECIMAL(5,2)  NOT NULL DEFAULT 20;
ALTER TABLE "SystemConfig" ADD COLUMN "growthMinKgMonth"     DECIMAL(10,2) NOT NULL DEFAULT 10;
ALTER TABLE "SystemConfig" ADD COLUMN "contactDaysVip"       INTEGER       NOT NULL DEFAULT 14;
ALTER TABLE "SystemConfig" ADD COLUMN "contactDaysRegular"   INTEGER       NOT NULL DEFAULT 30;
ALTER TABLE "SystemConfig" ADD COLUMN "contactDaysSmall"     INTEGER       NOT NULL DEFAULT 60;
ALTER TABLE "SystemConfig" ADD COLUMN "contactDaysNew"       INTEGER       NOT NULL DEFAULT 7;
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_sales_tiers_check"
  CHECK ("tierVipTopPct" > 0 AND "tierVipTopPct" <= 100
     AND "tierVipMinKgMonth" >= 0 AND "tierVipMinKgMonth" <= 100000
     AND "tierSmallMaxKgMonth" >= 0 AND "tierSmallMaxKgMonth" < "tierVipMinKgMonth"
     AND "growthMinPct" > 0 AND "growthMinPct" <= 1000
     AND "growthMinKgMonth" >= 0 AND "growthMinKgMonth" <= 100000
     AND "contactDaysVip" BETWEEN 1 AND 365 AND "contactDaysRegular" BETWEEN 1 AND 365
     AND "contactDaysSmall" BETWEEN 1 AND 365 AND "contactDaysNew" BETWEEN 1 AND 365);

CREATE TABLE "SalesCallSnooze" (
  "employeeId" TEXT         NOT NULL,
  "customerId" TEXT         NOT NULL,
  "until"      TIMESTAMP(3) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesCallSnooze_pkey" PRIMARY KEY ("employeeId", "customerId"),
  CONSTRAINT "SalesCallSnooze_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SalesCallSnooze_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Activity_customerId_completedAt_idx" ON "Activity"("customerId", "completedAt");
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SalesCallSnooze" TO flowcom_app;
  END IF;
END $$;
