-- «خطة الأسبوع v2» (owner-approved Figma page 07, 3 Nov 2026): a plan item is a concrete action — a visit, a call, a
-- quotation, a collection or a sample, for ONE customer, on a day of the week or undated — and it is DONE when the rep's
-- own record of that action for that customer exists in the item's week (services/sales/plans.ts matches them). Ticking
-- a planned visit or call records the visit or call itself; nothing is ticked by hand except the free «بند آخر» (CHECK).
-- The supervisor (sales › lead_assign) may now also put an action or a free item in a rep's plan (source ADMIN): the rep
-- sees it marked «من المشرف» and cannot delete it.
--   · kind ACTION: period WEEK, metric VISITS · CALLS · QUOTES · COLLECTION · SAMPLES, a customer, an optional day and note.
--   · kind CHECK: may now be ADMIN as well.
--   · plannedDay: the Riyadh day it is planned for (ACTION or CHECK), or NULL for «هالأسبوع».
-- Additive: two nullable columns, a wider CHECK, an index. Existing rows all satisfy the new CHECK.
BEGIN;

ALTER TABLE "SalesPlanItem" ADD COLUMN "customerId" TEXT;
ALTER TABLE "SalesPlanItem" ADD COLUMN "plannedDay" DATE;
ALTER TABLE "SalesPlanItem" ADD CONSTRAINT "SalesPlanItem_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SalesPlanItem" DROP CONSTRAINT "SalesPlanItem_shape_check";
ALTER TABLE "SalesPlanItem" ADD CONSTRAINT "SalesPlanItem_shape_check" CHECK (
  "period" IN ('DAY', 'WEEK', 'MONTH') AND "source" IN ('ADMIN', 'SELF') AND "kind" IN ('GOAL', 'CHECK', 'ACTION')
  AND ("kind" <> 'GOAL' OR "source" = 'SELF' OR "period" IN ('WEEK', 'MONTH'))
  AND ("kind" = 'ACTION' OR "customerId" IS NULL)
  AND ("kind" <> 'GOAL' OR "plannedDay" IS NULL)
  AND (
    ("kind" = 'GOAL' AND "metric" IN ('VISITS', 'CALLS', 'QUOTES', 'COLLECTION', 'NEW_CUSTOMERS', 'SAMPLES', 'CUSTOM')
      AND "target" IS NOT NULL AND "target" > 0 AND "checkedAt" IS NULL
      AND ("metric" <> 'CUSTOM' OR length(btrim(coalesce("label", ''))) BETWEEN 2 AND 80)
      AND ("metric" = 'CUSTOM' OR "manualDone" IS NULL))
    OR ("kind" = 'CHECK' AND "metric" IS NULL AND "target" IS NULL AND "manualDone" IS NULL
      AND length(btrim(coalesce("label", ''))) BETWEEN 2 AND 200)
    OR ("kind" = 'ACTION' AND "period" = 'WEEK' AND "metric" IN ('VISITS', 'CALLS', 'QUOTES', 'COLLECTION', 'SAMPLES')
      AND "customerId" IS NOT NULL AND "target" IS NULL AND "manualDone" IS NULL AND "checkedAt" IS NULL
      AND ("label" IS NULL OR length(btrim("label")) BETWEEN 2 AND 200))
  )
);
CREATE INDEX "SalesPlanItem_customer_idx" ON "SalesPlanItem"("customerId");

COMMIT;
