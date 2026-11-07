-- 20261222090000_direct_sale_discount_approval — «بيع مباشر» with a discount above the threshold (owner decision, 6 Nov
-- 2026: «تشتغل مثل عرض السعر»). The rep submits the sale; it waits for a supervisor (sales › quote_approve_discount) in the
-- same approvals inbox as a quotation's discount; only on approval is the deal won, the invoice draft priced with the
-- discount and requested to the accountant, and a cash / card collection recorded (services/sales/direct-sale.ts).
-- A refusal leaves the order waiting for the rep: resubmit at or under the threshold, or cancel the order.
--   "discountApprovalStatus"   NONE (no approval needed — every existing order) | PENDING | APPROVED | REJECTED
--   "requestedDiscountPercent" the discount asked for (0 < p ≤ 100), set with PENDING
--   "discountApprovedById/At"  who approved, when;  "discountRejectedById/At", "discountRejectionNote" who refused, why
-- Additive and idempotent: one NOT NULL column with a constant default (no table rewrite, every existing row NONE), six
-- nullable columns, two CHECKs guarded by pg_constraint, one partial index for the inbox. No data is written. The runtime
-- role holds table-level UPDATE on "Order" (only "Customer" is granted column by column, check 81), so the columns need
-- no grant; the DO block grants them anyway if a column-level grant ever exists.
-- Rollback: docs/hr/migration-review/rollback-20261222090000_direct_sale_discount_approval.sql. Verifier check 88.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "discountApprovalStatus" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "requestedDiscountPercent" DECIMAL(9,6);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "discountApprovedById" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "discountApprovedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "discountRejectedById" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "discountRejectedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "discountRejectionNote" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_discountApprovalStatus_check') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_discountApprovalStatus_check"
      CHECK ("discountApprovalStatus" IN ('NONE', 'PENDING', 'APPROVED', 'REJECTED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_requestedDiscount_check') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_requestedDiscount_check" CHECK (
      ("requestedDiscountPercent" IS NULL OR ("requestedDiscountPercent" > 0 AND "requestedDiscountPercent" <= 100))
      AND ("discountApprovalStatus" = 'NONE' OR "requestedDiscountPercent" IS NOT NULL)
      AND coalesce(length("discountRejectionNote"), 0) <= 1000);
  END IF;
  -- Column-level UPDATE on "Order" for the runtime role, only where the role already works column by column there.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app')
     AND EXISTS (SELECT 1 FROM information_schema.column_privileges
                  WHERE table_name = 'Order' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges
                      WHERE table_name = 'Order' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
    GRANT UPDATE ("discountApprovalStatus", "requestedDiscountPercent", "discountApprovedById", "discountApprovedAt",
                  "discountRejectedById", "discountRejectedAt", "discountRejectionNote") ON "Order" TO flowcom_app;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Order_discountApproval_pending_idx" ON "Order" ("createdAt") WHERE "discountApprovalStatus" = 'PENDING';

COMMIT;
