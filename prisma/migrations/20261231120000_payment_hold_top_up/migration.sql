-- 20261231120000_payment_hold_top_up — P1 payment hold, owner decision أ on top-ups (12 Nov 2026).
-- After a SHORT correction of a held direct sale's collection is approved, the rest of the money is recorded as a
-- TOP-UP collection linked to the held order; once the approved money of the sale (its own collection's «نسخ وتصحيح»
-- chain + its linked top-ups) covers the sale's gross, the hold is released in the approval's transaction.
--   "SalesCollection"."holdOrderId": the held order this collection tops up. Set ONLY by the top-up action
--   (POST /api/orders/[id]/payment-hold/top-up, services/orders/payment-hold.ts) — never read from a client body; a
--   collection recorded by hand on the deal (NULL) never counts toward a hold.
--   CHECK: a top-up pays its own order ("holdOrderId" = "orderId") — the link cannot point at another order.
-- Additive: one nullable column, one FK, one CHECK, one index. No existing row is read or written.
BEGIN;

ALTER TABLE "SalesCollection" ADD COLUMN "holdOrderId" TEXT;
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_holdOrderId_fkey" FOREIGN KEY ("holdOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_holdOrderId_check" CHECK ("holdOrderId" IS NULL OR "holdOrderId" = "orderId");
CREATE INDEX "SalesCollection_holdOrderId_idx" ON "SalesCollection"("holdOrderId");

COMMIT;
