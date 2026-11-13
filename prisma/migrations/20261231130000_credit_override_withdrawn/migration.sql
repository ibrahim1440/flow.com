-- 20261231130000_credit_override_withdrawn — P1 ERR-02, gate R7 follow-up: the rep WITHDRAWS their own pending over-limit
-- request («اسحب الطلب») — notably one left PENDING because they released the held order themselves.
-- No existing status fits: every decided state needs a decider who is NOT the requester (CreditLimitOverride_independent_check
-- / _shape_check), and the runtime role holds no DELETE (the request is the record). So a new state:
--   WITHDRAWN — no decider (the requester closed it), the time it was withdrawn in "decidedAt", never used.
-- The two CHECKs are replaced under the same names, each a strict superset of the old one (every row valid before stays
-- valid). Additive: no existing row is read or written.
BEGIN;

ALTER TABLE "CreditLimitOverride" DROP CONSTRAINT "CreditLimitOverride_status_check";
ALTER TABLE "CreditLimitOverride" ADD CONSTRAINT "CreditLimitOverride_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'USED', 'EXPIRED', 'WITHDRAWN'));

ALTER TABLE "CreditLimitOverride" DROP CONSTRAINT "CreditLimitOverride_shape_check";
ALTER TABLE "CreditLimitOverride" ADD CONSTRAINT "CreditLimitOverride_shape_check" CHECK (
    ("status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "usedOrderId" IS NULL)
    OR ("status" = 'REJECTED' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "usedOrderId" IS NULL)
    OR ("status" IN ('APPROVED', 'EXPIRED') AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "expiresAt" IS NOT NULL
        AND length(btrim(coalesce("decisionNote", ''))) >= 5 AND "usedOrderId" IS NULL)
    OR ("status" = 'USED' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND length(btrim(coalesce("decisionNote", ''))) >= 5
        AND "usedOrderId" IS NOT NULL AND "usedAt" IS NOT NULL)
    OR ("status" = 'WITHDRAWN' AND "decidedById" IS NULL AND "decidedAt" IS NOT NULL AND "usedOrderId" IS NULL AND "expiresAt" IS NULL));

COMMIT;
