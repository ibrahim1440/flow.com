-- 20261227090000_customer_phone_last9_idx — D17 follow-up (owner, 9 Nov 2026): «أضف عميل محتمل» from a field round checks
-- whether the phone already belongs to a CUSTOMER by its last nine digits (src/app/api/sales/leads/route.ts). This index is
-- on exactly that expression, so the check is an index lookup instead of a scan as "Customer" grows.
--   · Expression: right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) — both functions IMMUTABLE; partial on phone IS NOT NULL.
--   · Not in schema.prisma (Prisma cannot express an expression index — same as SalesPlanItem_admin_goal_key).
--   · A plain CREATE INDEX inside the transaction with a lock timeout (no CONCURRENTLY anywhere in this repo's migrations, and
--     "Customer" is small): it holds a SHARE lock (reads go on; writes to "Customer" wait) for the seconds it takes.
-- Additive and idempotent; no data written. Rollback: docs/hr/migration-review/rollback-20261227090000_customer_phone_last9_idx.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "Customer_phone_last9_idx" ON "Customer" ((right(regexp_replace("phone", '[^0-9]', '', 'g'), 9))) WHERE "phone" IS NOT NULL;

COMMIT;
