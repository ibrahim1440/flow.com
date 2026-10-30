-- Batch 24 council fix round 2: two settings «يومي» needs. ADDITIVE ONLY, one transaction (PostgreSQL 16 / 17).
--
--   "SystemConfig"."callAwaitDays" (INT, NULL, CHECK 1..30) — «كلّمته — بانتظار الطلب» (item 7): after a rep contacts a
--     LATE customer, the customer stays on the call list marked as called and awaiting the order for this many days or
--     until an order arrives; then it is a late customer to call again. NULL = 3 (the owner's default). Edited by the
--     admin in «إعدادات المبيعات › تصنيف العملاء ويومي», audited like the other thresholds.
--   "Employee"."homePreference" (TEXT, NULL, CHECK 'my-day' | 'classic') — «صفحتي الرئيسية» (item 11): the sales
--     person's own choice of home, kept apart from "defaultRoute" (the landing page the ADMINISTRATOR sets), so the
--     preference never overwrites an admin's choice. NULL = «يومي». Every change is audited (settings trail).
-- Row counts touched: none (two new nullable columns, no default; every existing row is NULL there and meets the CHECKs).
-- No new table, so no grant: the runtime role's table grants already cover the new columns.
-- Rollback: docs/hr/migration-review/rollback-20261206110000_sales_call_await_home.sql.
BEGIN;

ALTER TABLE "SystemConfig" ADD COLUMN "callAwaitDays" INTEGER;
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_call_await_days_check" CHECK (
  "callAwaitDays" IS NULL OR "callAwaitDays" BETWEEN 1 AND 30
);

ALTER TABLE "Employee" ADD COLUMN "homePreference" TEXT;
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_home_preference_check" CHECK (
  "homePreference" IS NULL OR "homePreference" IN ('my-day', 'classic')
);

COMMIT;
