-- 20261231140000_quote_draft_unnumbered — owner decision (13 Nov 2026, the quote-45 round, item 3): a quotation's lines are
-- kept in its draft (saved as the rep works), but the quotation takes NO number until it is issued — so an abandoned or
-- long-lived draft never burns a number, and the numbers the customers see stay consecutive.
--   · "Quote"."quoteNumber" becomes nullable; the UNIQUE index stays (several NULLs are allowed);
--   · CHECK Quote_number_issued_check: only a DRAFT may be without a number — an issued, accepted, rejected, expired or
--     superseded quotation always has one (the application assigns it at issue, under a lock, in the same transaction).
-- Additive: no row is read or written; every existing row has a number (drafts numbered before keep theirs).
BEGIN;

ALTER TABLE "Quote" ALTER COLUMN "quoteNumber" DROP NOT NULL;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_number_issued_check" CHECK ("status" = 'DRAFT' OR "quoteNumber" IS NOT NULL);

COMMIT;
