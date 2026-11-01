-- «عمولة عرض المحاسب» (owner decision, 1 Nov 2026): when the accountant quotes a customer that belongs to a sales rep,
-- the supervisors (sales › lead_assign, accounting › supervise) and the owner are told, and one of them decides whether
-- the rep earns the commission on it. ASSIGNED: the quotation moves onto a deal of the rep (channel SALES) and from then
-- on is the rep's deal like any other; NONE: it stays the accounting section's, with no deal and no commission.
-- Additive (nullable columns; the channel CHECK of 20261213 replaced, same name):
--   · "commissionDecision": NULL (not applicable: no rep) | PENDING | ASSIGNED | NONE;
--   · who decided, when, why, and the rep the customer belonged to when the quotation was issued.
BEGIN;

ALTER TABLE "Quote"
  ADD COLUMN "commissionDecision"    TEXT,
  ADD COLUMN "commissionRepId"       TEXT,
  ADD COLUMN "commissionDecidedById" TEXT,
  ADD COLUMN "commissionDecidedAt"   TIMESTAMP(3),
  ADD COLUMN "commissionReason"      TEXT;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_commissionRepId_fkey" FOREIGN KEY ("commissionRepId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_commissionDecidedById_fkey" FOREIGN KEY ("commissionDecidedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Quote" DROP CONSTRAINT "Quote_channel_check";
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_channel_check" CHECK (
  ("channel" = 'SALES' AND "opportunityId" IS NOT NULL AND ("commissionDecision" IS NULL OR "commissionDecision" = 'ASSIGNED'))
  OR ("channel" = 'ACCOUNTING' AND "opportunityId" IS NULL AND "customerId" IS NOT NULL
      AND ("commissionDecision" IS NULL OR "commissionDecision" IN ('PENDING', 'NONE')))
);
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_commission_check" CHECK (
  ("commissionDecision" IS NULL AND "commissionDecidedAt" IS NULL AND "commissionDecidedById" IS NULL AND "commissionReason" IS NULL)
  OR ("commissionDecision" = 'PENDING' AND "commissionDecidedAt" IS NULL AND "commissionDecidedById" IS NULL)
  OR ("commissionDecision" IN ('ASSIGNED', 'NONE') AND "commissionDecidedAt" IS NOT NULL AND "commissionDecidedById" IS NOT NULL
      AND length(btrim(coalesce("commissionReason", ''))) >= 3)
);
CREATE INDEX "Quote_commissionDecision_idx" ON "Quote"("commissionDecision") WHERE "commissionDecision" = 'PENDING';

COMMIT;
