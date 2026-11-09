-- 20261225090000_sales_plan_time — D16 «خطتي» (owner-approved Figma page D16, 9 Nov 2026): «تذكير» and «موعد» are one thing
-- in the plan — an item with a time is an appointment, an item with a day only is a reminder. And a planned sample may be
-- ticked by hand («وش صار؟ › أرسلتها»), since a sample handed over in person has no shipment record to match.
--   · plannedTime: "HH:MM" (Riyadh, 24 h) on an ACTION or CHECK that has a plannedDay; NULL = no time.
--   · ACTION may carry checkedAt only for metric SAMPLES (the manual tick); every other action is still done by its record.
-- Additive and idempotent: one nullable column (no rewrite, no data written), SalesPlanItem_shape_check replaced by a wider
-- one under the same name (every existing row satisfies it), and SalesPlanItem_admin_goal_key narrowed to GOAL rows (every
-- row that met the wider index meets the narrower one). Rollback: docs/hr/migration-review/rollback-20261225090000_sales_plan_time.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "SalesPlanItem" ADD COLUMN IF NOT EXISTS "plannedTime" TEXT;

ALTER TABLE "SalesPlanItem" DROP CONSTRAINT IF EXISTS "SalesPlanItem_shape_check";
ALTER TABLE "SalesPlanItem" ADD CONSTRAINT "SalesPlanItem_shape_check" CHECK (
  "period" IN ('DAY', 'WEEK', 'MONTH') AND "source" IN ('ADMIN', 'SELF') AND "kind" IN ('GOAL', 'CHECK', 'ACTION')
  AND ("kind" <> 'GOAL' OR "source" = 'SELF' OR "period" IN ('WEEK', 'MONTH'))
  AND ("kind" = 'ACTION' OR "customerId" IS NULL)
  AND ("kind" <> 'GOAL' OR "plannedDay" IS NULL)
  AND ("plannedTime" IS NULL OR ("kind" <> 'GOAL' AND "plannedDay" IS NOT NULL AND "plannedTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
  AND (
    ("kind" = 'GOAL' AND "metric" IN ('VISITS', 'CALLS', 'QUOTES', 'COLLECTION', 'NEW_CUSTOMERS', 'SAMPLES', 'CUSTOM')
      AND "target" IS NOT NULL AND "target" > 0 AND "checkedAt" IS NULL
      AND ("metric" <> 'CUSTOM' OR length(btrim(coalesce("label", ''))) BETWEEN 2 AND 80)
      AND ("metric" = 'CUSTOM' OR "manualDone" IS NULL))
    OR ("kind" = 'CHECK' AND "metric" IS NULL AND "target" IS NULL AND "manualDone" IS NULL
      AND length(btrim(coalesce("label", ''))) BETWEEN 2 AND 200)
    OR ("kind" = 'ACTION' AND "period" = 'WEEK' AND "metric" IN ('VISITS', 'CALLS', 'QUOTES', 'COLLECTION', 'SAMPLES')
      AND "customerId" IS NOT NULL AND "target" IS NULL AND "manualDone" IS NULL
      AND ("checkedAt" IS NULL OR "metric" = 'SAMPLES')
      AND ("label" IS NULL OR length(btrim("label")) BETWEEN 2 AND 200))
  )
);

-- The supervisor's uniqueness index (20261215090000) is for their TARGETS: one number per rep, period, kind (and label).
-- Since 20261216090000 the supervisor also puts actions in a rep's plan, which the index wrongly limited to one per kind per
-- week (two supervisor visits to different customers were refused). D16 (gate, 9 Nov): GOAL rows only.
DROP INDEX IF EXISTS "SalesPlanItem_admin_goal_key";
CREATE UNIQUE INDEX "SalesPlanItem_admin_goal_key" ON "SalesPlanItem"("employeeId", "period", "periodStart", "metric", (coalesce("label", '')))
  WHERE "source" = 'ADMIN' AND "kind" = 'GOAL';

COMMIT;
