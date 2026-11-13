-- 20261231090000_credit_limit_override — P1 ERR-02 (owner decisions 1أ/2أ/3أ, 12 Nov 2026): the credit limit BLOCKS.
-- A new order, a direct sale or a quotation's conversion to an order is refused (409 CREDIT_LIMIT) when the customer's
-- commitment (receivable + approved orders not yet invoiced) plus the order exceeds the customer's limit. A supervisor
-- holding customers › sales_hold may let ONE such order through: the rep asks (the order's amount and a reason), a
-- second person decides with a documented reason (a CHECK: never the requester), and the approval is consumed by the
-- first order of the requester for that customer up to its amount. Every step is audited (HrAuditLog).
--   "CreditLimitOverride": PENDING → APPROVED → USED, or PENDING → REJECTED; an approval not used lapses (EXPIRED) at
--   "expiresAt". Append-only in practice (no DELETE grant).
-- Additive: one new table. No existing row is read or written; nothing is checked retroactively.
BEGIN;

CREATE TABLE "CreditLimitOverride" (
  "id"            TEXT PRIMARY KEY,
  "customerId"    TEXT NOT NULL,
  "kind"          TEXT NOT NULL,
  "amount"        DECIMAL(14, 2) NOT NULL,
  "limitAt"       DECIMAL(14, 2) NOT NULL,
  "commitmentAt"  DECIMAL(14, 2) NOT NULL,
  "reason"        TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById"   TEXT,
  "decidedAt"     TIMESTAMP(3),
  "decisionNote"  TEXT,
  "expiresAt"     TIMESTAMP(3),
  "usedOrderId"   TEXT,
  "usedAt"        TIMESTAMP(3),
  CONSTRAINT "CreditLimitOverride_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CreditLimitOverride_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CreditLimitOverride_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CreditLimitOverride_kind_check" CHECK ("kind" IN ('ORDER', 'QUOTE_ORDER', 'DIRECT_SALE')),
  CONSTRAINT "CreditLimitOverride_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'USED', 'EXPIRED')),
  CONSTRAINT "CreditLimitOverride_amount_check" CHECK ("amount" > 0 AND "limitAt" >= 0),
  CONSTRAINT "CreditLimitOverride_reason_check" CHECK (length(btrim("reason")) BETWEEN 5 AND 500),
  -- Independent decision (owner): the overrider is never the requester.
  CONSTRAINT "CreditLimitOverride_independent_check" CHECK ("decidedById" IS NULL OR "decidedById" <> "requestedById"),
  -- The shape of each state: a decision has its decider, time and (for an approval) a documented reason of 5+; a used
  -- approval names its order.
  CONSTRAINT "CreditLimitOverride_shape_check" CHECK (
    ("status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "usedOrderId" IS NULL)
    OR ("status" = 'REJECTED' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "usedOrderId" IS NULL)
    OR ("status" IN ('APPROVED', 'EXPIRED') AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "expiresAt" IS NOT NULL
        AND length(btrim(coalesce("decisionNote", ''))) >= 5 AND "usedOrderId" IS NULL)
    OR ("status" = 'USED' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND length(btrim(coalesce("decisionNote", ''))) >= 5
        AND "usedOrderId" IS NOT NULL AND "usedAt" IS NOT NULL)),
  CONSTRAINT "CreditLimitOverride_note_check" CHECK ("decisionNote" IS NULL OR length("decisionNote") <= 500)
);
CREATE INDEX "CreditLimitOverride_customerId_status_idx" ON "CreditLimitOverride"("customerId", "status");
CREATE INDEX "CreditLimitOverride_pending_idx" ON "CreditLimitOverride"("requestedAt") WHERE "status" = 'PENDING';
-- One open request per rep and customer at a time.
CREATE UNIQUE INDEX "CreditLimitOverride_one_pending_key" ON "CreditLimitOverride"("customerId", "requestedById") WHERE "status" = 'PENDING';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "CreditLimitOverride" TO flowcom_app;
  END IF;
END $$;

COMMIT;
