-- «الخطط والأهداف» (owner decision, 3 Nov 2026): one table for a rep's plan of a day, a week or a month.
--   · source ADMIN: a management goal (sales › lead_assign — the same people who set the monthly target), a WEEK or a
--     MONTH, one per (rep, period, metric, label); the rep reads it locked.
--   · source SELF: the rep's own goals and checklist items, private to the rep (the supervisor only reads them).
--   · kind GOAL: a metric and a target. VISITS · CALLS · QUOTES · COLLECTION · NEW_CUSTOMERS · SAMPLES are counted by
--     the system from the rep's own records; CUSTOM carries a label and a progress the rep enters (`manualDone`).
--   · kind CHECK: a SELF item ticked by hand (`checkedAt`).
-- Additive: a new table, granted to the runtime role.
BEGIN;

CREATE TABLE "SalesPlanItem" (
  "id"          TEXT NOT NULL,
  "employeeId"  TEXT NOT NULL,
  "period"      TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "source"      TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "metric"      TEXT,
  "label"       TEXT,
  "target"      DECIMAL(18,2),
  "manualDone"  DECIMAL(18,2),
  "checkedAt"   TIMESTAMP(3),
  "position"    INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesPlanItem_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "SalesPlanItem" ADD CONSTRAINT "SalesPlanItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesPlanItem" ADD CONSTRAINT "SalesPlanItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesPlanItem" ADD CONSTRAINT "SalesPlanItem_shape_check" CHECK (
  "period" IN ('DAY', 'WEEK', 'MONTH') AND "source" IN ('ADMIN', 'SELF') AND "kind" IN ('GOAL', 'CHECK')
  AND ("source" = 'SELF' OR ("kind" = 'GOAL' AND "period" IN ('WEEK', 'MONTH')))
  AND (
    ("kind" = 'GOAL' AND "metric" IN ('VISITS', 'CALLS', 'QUOTES', 'COLLECTION', 'NEW_CUSTOMERS', 'SAMPLES', 'CUSTOM')
      AND "target" IS NOT NULL AND "target" > 0 AND "checkedAt" IS NULL
      AND ("metric" <> 'CUSTOM' OR length(btrim(coalesce("label", ''))) BETWEEN 2 AND 80)
      AND ("metric" = 'CUSTOM' OR "manualDone" IS NULL))
    OR ("kind" = 'CHECK' AND "source" = 'SELF' AND "metric" IS NULL AND "target" IS NULL AND "manualDone" IS NULL
      AND length(btrim(coalesce("label", ''))) BETWEEN 2 AND 200)
  )
);
CREATE INDEX "SalesPlanItem_employee_period_idx" ON "SalesPlanItem"("employeeId", "period", "periodStart");
CREATE UNIQUE INDEX "SalesPlanItem_admin_goal_key" ON "SalesPlanItem"("employeeId", "period", "periodStart", "metric", (coalesce("label", ''))) WHERE "source" = 'ADMIN';

GRANT SELECT, INSERT, UPDATE, DELETE ON "SalesPlanItem" TO flowcom_app;

COMMIT;
