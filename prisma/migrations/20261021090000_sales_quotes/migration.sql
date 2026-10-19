-- Quotations & collections (batch "Sales", track A; Figma 181:1609, 1230:121651, 1230:139687).
-- ADDITIVE ONLY: nullable columns on "Quote" and "SystemConfig" (no default, so no existing row is
-- rewritten and nothing reads differently until somebody writes them), one new table
-- "SalesQuoteAudit", three new indexes and two CHECK constraints (one on a new column, one on the
-- new table). Nothing is dropped, renamed, retyped, made NOT NULL or back-filled.
--   Quote.discountApprovedPercent (DECIMAL(9,6)) / discountRejectedById / discountRejectedAt /
--     discountRejectionNote: the discount-approval decision taken on a draft;
--   Quote.customerNotes: notes to the customer, printed on the document (no effect on any amount);
--   SystemConfig.quoteDiscountApprovalPercent (DECIMAL(5,2), CHECK 0–60): the owner's discount
--     threshold. NULL = the built-in 10% applies, exactly as today;
--   SystemConfig.sellerLegalNameAr / sellerLegalNameEn / sellerAddressAr / sellerAddressEn /
--     sellerVatNumber / sellerCrNumber / sellerPhone: the seller block of the quotation document;
--   SystemConfig.sellerBankName / sellerBankAccountName / sellerIban: the bank transfer details
--     printed on the quotation (the IBAN stored normalised, SA + 22 digits, validated by the API);
--   SalesQuoteAudit: append-only trail of discount approvals / rejections and quotation settings
--     changes (no foreign keys, audit convention);
--   Quote_status_createdAt_idx: the list's per-status counts and newest-first order.
-- Atomic: the whole file runs in one transaction. ADD COLUMN without a default is metadata-only;
-- the CHECK on the new column validates against NULLs only; CREATE INDEX on "Quote" takes a SHARE
-- lock for the time of the build (a small table). Totals, VAT and quotation numbering are untouched.
-- Rollback: docs/hr/migration-review/rollback-20261021090000_sales_quotes.sql.
BEGIN;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "customerNotes" TEXT,
ADD COLUMN     "discountApprovedPercent" DECIMAL(9,6),
ADD COLUMN     "discountRejectedAt" TIMESTAMP(3),
ADD COLUMN     "discountRejectedById" TEXT,
ADD COLUMN     "discountRejectionNote" TEXT;

-- AlterTable
ALTER TABLE "SystemConfig" ADD COLUMN     "quoteDiscountApprovalPercent" DECIMAL(5,2),
ADD COLUMN     "sellerAddressAr" TEXT,
ADD COLUMN     "sellerAddressEn" TEXT,
ADD COLUMN     "sellerBankAccountName" TEXT,
ADD COLUMN     "sellerBankName" TEXT,
ADD COLUMN     "sellerCrNumber" TEXT,
ADD COLUMN     "sellerIban" TEXT,
ADD COLUMN     "sellerLegalNameAr" TEXT,
ADD COLUMN     "sellerLegalNameEn" TEXT,
ADD COLUMN     "sellerPhone" TEXT,
ADD COLUMN     "sellerVatNumber" TEXT;

-- The threshold is a percentage no approval can exceed anyway (DISCOUNT_MAX = 60).
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_quoteDiscountApprovalPercent_check"
  CHECK ("quoteDiscountApprovalPercent" IS NULL OR ("quoteDiscountApprovalPercent" >= 0 AND "quoteDiscountApprovalPercent" <= 60));

-- CreateTable
CREATE TABLE "SalesQuoteAudit" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "quoteId" TEXT,
    "quoteNumber" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesQuoteAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SalesQuoteAudit_action_check" CHECK ("action" IN ('DISCOUNT_APPROVED', 'DISCOUNT_REJECTED', 'QUOTE_SETTINGS_UPDATED'))
);

-- CreateIndex
CREATE INDEX "SalesQuoteAudit_quoteId_createdAt_idx" ON "SalesQuoteAudit"("quoteId", "createdAt");

-- CreateIndex
CREATE INDEX "SalesQuoteAudit_action_createdAt_idx" ON "SalesQuoteAudit"("action", "createdAt");

-- CreateIndex
CREATE INDEX "Quote_status_createdAt_idx" ON "Quote"("status", "createdAt");

COMMIT;
