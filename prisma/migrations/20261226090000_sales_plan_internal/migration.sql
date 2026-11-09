-- 20261226090000_sales_plan_internal — D17 «خطتي» for internal work (owner-approved Figma page D17, 9 Nov 2026): the plan's
-- free items (kind CHECK) get a category — a meeting, a field round, a report / desk work, or «شغلة ثانية» — with what each
-- one needs, and an item may repeat every week.
--   · category        MEETING | FIELD_ROUND | REPORT | OTHER, on CHECK rows only (NULL = OTHER, every existing row).
--   · durationMin     a meeting's length, 15–480 minutes.
--   · attendeeIds     a meeting's colleagues (Employee ids) — names shown in the plan; nobody is told unless invited.
--   · appointmentId   the invited meeting's WorkAppointment (the colleagues see it in their calendar / «يومي»).
--   · area, targetNew a field round's place and the number of new customers aimed for; shopsVisited its outcome.
--   · recurrenceId    the weekly rule the item was generated from (SalesPlanRecurrence).
--   · SalesPlanRecurrence      «كرّرها كل أسبوع»: one weekday, an optional time, until a day or no end, stopped or not.
--   · SalesPlanRecurrenceWeek  the weeks already generated, one row per rule and week (primary key): generation is idempotent
--                              and an item the rep removed is not generated again.
--   · Lead.fieldRoundItemId    the field round a lead was added from («أضف عميل محتمل»).
-- Additive and idempotent: nullable columns (attendeeIds NOT NULL DEFAULT '{}', a metadata-only change), two new tables,
-- SalesPlanItem_shape_check replaced by a wider one under the same name (every existing row satisfies it: category and the
-- new columns are NULL / empty). No data is written. Rollback: docs/hr/migration-review/rollback-20261226090000_sales_plan_internal.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "SalesPlanRecurrence" (
  "id"          TEXT NOT NULL,
  "employeeId"  TEXT NOT NULL,
  "category"    TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "weekday"     INTEGER NOT NULL,
  "plannedTime" TEXT,
  "durationMin" INTEGER,
  "attendeeIds" TEXT[] NOT NULL DEFAULT '{}',
  "invite"      BOOLEAN NOT NULL DEFAULT false,
  "area"        TEXT,
  "targetNew"   INTEGER,
  "startWeek"   DATE NOT NULL,
  "untilDay"    DATE,
  "stoppedAt"   TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesPlanRecurrence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SalesPlanRecurrence_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SalesPlanRecurrence_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "SalesPlanRecurrence_shape_check" CHECK (
    "category" IN ('MEETING', 'FIELD_ROUND', 'REPORT', 'OTHER')
    AND length(btrim("label")) BETWEEN 2 AND 200
    AND "weekday" BETWEEN 0 AND 6
    AND ("plannedTime" IS NULL OR "plannedTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    AND ("durationMin" IS NULL OR ("category" = 'MEETING' AND "durationMin" BETWEEN 15 AND 480))
    AND (cardinality("attendeeIds") = 0 OR "category" = 'MEETING')
    AND (NOT "invite" OR ("category" = 'MEETING' AND "plannedTime" IS NOT NULL AND cardinality("attendeeIds") > 0))
    AND (("area" IS NULL AND "targetNew" IS NULL) OR "category" = 'FIELD_ROUND')
    AND ("targetNew" IS NULL OR "targetNew" BETWEEN 1 AND 99)
    AND ("untilDay" IS NULL OR "untilDay" >= "startWeek")
  )
);
CREATE INDEX IF NOT EXISTS "SalesPlanRecurrence_employee_idx" ON "SalesPlanRecurrence"("employeeId");

CREATE TABLE IF NOT EXISTS "SalesPlanRecurrenceWeek" (
  "recurrenceId" TEXT NOT NULL,
  "weekStart"    DATE NOT NULL,
  "itemId"       TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesPlanRecurrenceWeek_pkey" PRIMARY KEY ("recurrenceId", "weekStart"),
  CONSTRAINT "SalesPlanRecurrenceWeek_recurrenceId_fkey" FOREIGN KEY ("recurrenceId") REFERENCES "SalesPlanRecurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "SalesPlanItem" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "SalesPlanItem" ADD COLUMN IF NOT EXISTS "durationMin" INTEGER;
ALTER TABLE "SalesPlanItem" ADD COLUMN IF NOT EXISTS "attendeeIds" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "SalesPlanItem" ADD COLUMN IF NOT EXISTS "appointmentId" TEXT;
ALTER TABLE "SalesPlanItem" ADD COLUMN IF NOT EXISTS "area" TEXT;
ALTER TABLE "SalesPlanItem" ADD COLUMN IF NOT EXISTS "targetNew" INTEGER;
ALTER TABLE "SalesPlanItem" ADD COLUMN IF NOT EXISTS "shopsVisited" INTEGER;
ALTER TABLE "SalesPlanItem" ADD COLUMN IF NOT EXISTS "recurrenceId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesPlanItem_appointmentId_fkey') THEN
    ALTER TABLE "SalesPlanItem" ADD CONSTRAINT "SalesPlanItem_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "WorkAppointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesPlanItem_recurrenceId_fkey') THEN
    ALTER TABLE "SalesPlanItem" ADD CONSTRAINT "SalesPlanItem_recurrenceId_fkey" FOREIGN KEY ("recurrenceId") REFERENCES "SalesPlanRecurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "SalesPlanItem_appointment_idx" ON "SalesPlanItem"("appointmentId");
CREATE INDEX IF NOT EXISTS "SalesPlanItem_recurrence_idx" ON "SalesPlanItem"("recurrenceId");

ALTER TABLE "SalesPlanItem" DROP CONSTRAINT IF EXISTS "SalesPlanItem_shape_check";
ALTER TABLE "SalesPlanItem" ADD CONSTRAINT "SalesPlanItem_shape_check" CHECK (
  "period" IN ('DAY', 'WEEK', 'MONTH') AND "source" IN ('ADMIN', 'SELF') AND "kind" IN ('GOAL', 'CHECK', 'ACTION')
  AND ("kind" <> 'GOAL' OR "source" = 'SELF' OR "period" IN ('WEEK', 'MONTH'))
  AND ("kind" = 'ACTION' OR "customerId" IS NULL)
  AND ("kind" <> 'GOAL' OR "plannedDay" IS NULL)
  AND ("plannedTime" IS NULL OR ("kind" <> 'GOAL' AND "plannedDay" IS NOT NULL AND "plannedTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
  -- D17: the internal kinds — a category only on a free item; each field only on its own kind.
  AND ("category" IS NULL OR ("kind" = 'CHECK' AND "category" IN ('MEETING', 'FIELD_ROUND', 'REPORT', 'OTHER')))
  AND ("durationMin" IS NULL OR ("category" = 'MEETING' AND "durationMin" BETWEEN 15 AND 480))
  AND (cardinality("attendeeIds") = 0 OR "category" = 'MEETING')
  AND ("appointmentId" IS NULL OR "category" = 'MEETING')
  AND (("area" IS NULL AND "targetNew" IS NULL AND "shopsVisited" IS NULL) OR "category" = 'FIELD_ROUND')
  AND ("targetNew" IS NULL OR "targetNew" BETWEEN 1 AND 99)
  AND ("shopsVisited" IS NULL OR "shopsVisited" BETWEEN 0 AND 999)
  AND ("recurrenceId" IS NULL OR "kind" = 'CHECK')
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

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "fieldRoundItemId" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_fieldRoundItemId_fkey') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_fieldRoundItemId_fkey" FOREIGN KEY ("fieldRoundItemId") REFERENCES "SalesPlanItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "Lead_fieldRoundItem_idx" ON "Lead"("fieldRoundItemId");

-- The runtime role (as 20261223090000_roast_station_v2): the two new tables are the app's to read and write. On "SalesPlanItem"
-- and "Lead" the new columns need a grant only where the role works column by column there (as 20261221090000_lead_identity);
-- with a table-level UPDATE (live today) nothing more is needed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SalesPlanRecurrence", "SalesPlanRecurrenceWeek" TO flowcom_app;
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_name = 'SalesPlanItem' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_name = 'SalesPlanItem' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
      GRANT UPDATE ("category", "durationMin", "attendeeIds", "appointmentId", "area", "targetNew", "shopsVisited", "recurrenceId") ON "SalesPlanItem" TO flowcom_app;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_name = 'Lead' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_name = 'Lead' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
      GRANT UPDATE ("fieldRoundItemId") ON "Lead" TO flowcom_app;
    END IF;
  END IF;
END $$;

COMMIT;
