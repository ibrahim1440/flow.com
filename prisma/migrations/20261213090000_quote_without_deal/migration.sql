-- «مسار المحاسب» (owner decision, 1 Nov 2026): the accountant issues quotations from the accounting section WITHOUT a
-- deal — the customer is the quote's own; no opportunity, so nothing of it can ever reach the sales pipeline or the
-- commissions (which are computed from deals and their collections). Sales reps keep the deal-based flow unchanged.
-- Additive: every existing quotation has a deal and is channel SALES.
--   · "Quote"."opportunityId" nullable; a quotation names a deal or a customer (CHECK).
--   · "Quote"."channel": SALES (default; on a deal) | ACCOUNTING (no deal, a customer) (CHECK).
BEGIN;

ALTER TABLE "Quote" ALTER COLUMN "opportunityId" DROP NOT NULL;
ALTER TABLE "Quote" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'SALES';
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_channel_check" CHECK (
  ("channel" = 'SALES' AND "opportunityId" IS NOT NULL)
  OR ("channel" = 'ACCOUNTING' AND "opportunityId" IS NULL AND "customerId" IS NOT NULL)
);

COMMIT;
