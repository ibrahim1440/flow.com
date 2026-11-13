-- 20261231100000_direct_sale_payment_hold — P1 ERR-02, owner decision on the «fake cash» risk (أ, 12 Nov 2026).
-- A cash / card direct sale is exempt from the credit-limit block because it is paid at the time of sale (owner Q1 = أ).
-- When that exemption is what let the sale through — the customer was OVER the limit — the order is HELD: it is not
-- released to preparation, roasting, dispatch or fulfilment until the accountant verifies (APPROVED) the sale's own
-- paid-now collection.
--   "Order"."paymentHold": NULL (no hold: every order before this and every sale within the limit) · PENDING (held, the
--   collection waits for the accountant) · REJECTED (held, the collection was rejected — the order proceeds only through
--   the normal credit check or a supervisor's DIRECT_SALE override) · RELEASED (the exemption WAS used and the hold is
--   over). A non-NULL value is the record that the exemption was used on the order.
--   Trigger "Order_payment_hold_guard": while the hold is PENDING / REJECTED the order stays in «Waiting Approval» (the
--   pre-preparation status the automatic preparation, the stations and the deliveries never take) or is cancelled — every
--   path that moves it on (status updates, preparation, approval, a station, an automatic advance) is refused here,
--   whatever the application does (SQLSTATE P0001, ORDER_AWAITING_PAYMENT).
-- Additive: one nullable column, one CHECK, one trigger. No existing row is read or written.
BEGIN;

ALTER TABLE "Order" ADD COLUMN "paymentHold" TEXT;
ALTER TABLE "Order" ADD CONSTRAINT "Order_paymentHold_check" CHECK ("paymentHold" IS NULL OR "paymentHold" IN ('PENDING', 'REJECTED', 'RELEASED'));
CREATE INDEX "Order_paymentHold_idx" ON "Order"("paymentHold") WHERE "paymentHold" IN ('PENDING', 'REJECTED');

CREATE OR REPLACE FUNCTION order_payment_hold_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."paymentHold" IN ('PENDING', 'REJECTED') AND NEW."status" NOT IN ('Waiting Approval', 'Cancelled') THEN
    RAISE EXCEPTION 'ORDER_AWAITING_PAYMENT: order % is held until its paid-now collection is verified', NEW."id" USING ERRCODE = 'P0001';
  END IF;
  -- Once the exemption is recorded it stays recorded (a hold ends as RELEASED, never NULL).
  IF TG_OP = 'UPDATE' AND OLD."paymentHold" IS NOT NULL AND NEW."paymentHold" IS NULL THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_HOLD_KEPT: the payment hold of order % is never erased', NEW."id" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "Order_payment_hold_guard" BEFORE INSERT OR UPDATE OF "status", "paymentHold" ON "Order"
  FOR EACH ROW EXECUTE FUNCTION order_payment_hold_guard();

COMMIT;
