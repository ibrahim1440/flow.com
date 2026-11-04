-- 20261219090000_direct_order_deal — owner decision (option A): an order placed WITHOUT a quotation gets a deal, so its
-- collections and commission work like a quotation-born order's. Additive only: two nullable columns on
-- "OpportunityOrder" — the direct order's value at the moment it joined the deal (VAT included, and the VAT in it).
-- A quotation-born link leaves them NULL. No backfill: the live orders with no deal are linked from the order page
-- («اربط بصفقة», audited) after the deploy. Idempotent. Rollback:
-- docs/hr/migration-review/rollback-20261219090000_direct_order_deal.sql. Verifier check 85.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "OpportunityOrder" ADD COLUMN IF NOT EXISTS "directGross" DECIMAL(18,2);
ALTER TABLE "OpportunityOrder" ADD COLUMN IF NOT EXISTS "directTax" DECIMAL(18,2);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OpportunityOrder_direct_check') THEN
    -- Both or neither; never negative; the VAT never above the total; a direct value only on a link with no quotation.
    ALTER TABLE "OpportunityOrder" ADD CONSTRAINT "OpportunityOrder_direct_check" CHECK (
      ("directGross" IS NULL AND "directTax" IS NULL)
      OR ("directGross" IS NOT NULL AND "directTax" IS NOT NULL AND "directGross" >= 0 AND "directTax" >= 0
          AND "directTax" <= "directGross" AND "quoteId" IS NULL));
  END IF;
END $$;

-- One deal per direct order: a second quotation-less link of the same order is refused by the database, whatever the
-- caller. Created only when the existing rows allow it (they do unless somebody linked an order twice by hand; then the
-- service's own check still holds and the verifier, check 85, reports the duplicate).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'OpportunityOrder_direct_orderId_key')
     AND NOT EXISTS (SELECT 1 FROM "OpportunityOrder" WHERE "quoteId" IS NULL GROUP BY "orderId" HAVING count(*) > 1) THEN
    CREATE UNIQUE INDEX "OpportunityOrder_direct_orderId_key" ON "OpportunityOrder" ("orderId") WHERE "quoteId" IS NULL;
  END IF;
END $$;

COMMIT;
