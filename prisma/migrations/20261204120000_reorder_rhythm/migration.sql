-- «متابعة إعادة الشراء» (sales CRM optimization, P2). Additive and nullable: every existing row reads
-- "not set" and the built-in values apply (services/customers/reorder.ts).

-- A customer whose rhythm the history does not show (or shows wrongly): the agreed interval, in days.
ALTER TABLE "Customer" ADD COLUMN "reorderIntervalDays" INTEGER;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_reorderIntervalDays_check"
  CHECK ("reorderIntervalDays" IS NULL OR ("reorderIntervalDays" BETWEEN 1 AND 365));

-- The organisation's two factors on a customer's own interval: «متأخر» after interval × late factor,
-- «منقطع» after interval × inactive factor. NULL = the built-in 1.3 and 2.5.
ALTER TABLE "SystemConfig" ADD COLUMN "reorderLateFactor" DECIMAL(4,2);
ALTER TABLE "SystemConfig" ADD COLUMN "reorderInactiveFactor" DECIMAL(4,2);
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_reorder_factors_check"
  CHECK (("reorderLateFactor" IS NULL OR "reorderLateFactor" BETWEEN 1 AND 5)
     AND ("reorderInactiveFactor" IS NULL OR "reorderInactiveFactor" BETWEEN 1 AND 10)
     AND ("reorderLateFactor" IS NULL OR "reorderInactiveFactor" IS NULL OR "reorderInactiveFactor" > "reorderLateFactor"));
