-- «صلاحية العقد» — a contract or price agreement on the customer file has a start and an end date, and the account
-- owner is told before it ends (batch 24 WP-C, docs: BATCH24-DESIGN WP-C). ADDITIVE ONLY, one transaction
-- (PostgreSQL 16 / 17).
--
--   "CustomerFile"."validFrom" / "validUntil" (DATE, NULL): «يبدأ من» / «ينتهي في», both optional. Calendar dates
--     (Asia/Riyadh), never timestamps. The file's bytes, name, type and hash are untouched — only these dates change.
--   "CustomerFile"."renewalNoticeDays" (INT, NULL): how many days before "validUntil" the owner is told; NULL = the
--     company default below (45).
--   CHECK "CustomerFile_valid_range_check": "validUntil" is not before "validFrom".
--   CHECK "CustomerFile_validity_category_check": only a CONTRACT or a PRICE_AGREEMENT carries validity dates or a
--     notice period.
--   CHECK "CustomerFile_notice_days_check": a notice period is 1..365 days.
--   Partial index "CustomerFile_validUntil_idx": the files that have an end date (the expiring-contracts list, the
--     daily notice run and the team overview read only those).
--   "SystemConfig"."contractRenewalNoticeDays" (INT, NULL, CHECK 1..365): the company default notice; NULL = 45.
-- Row counts touched: none (new nullable columns, no default; every existing row is NULL there and meets every CHECK).
-- No new table, so no grant: the runtime role's table grants already cover the new columns.
-- Rollback: docs/hr/migration-review/rollback-20261206100000_customer_contract_validity.sql.
BEGIN;

ALTER TABLE "CustomerFile"
  ADD COLUMN "validFrom"         DATE,
  ADD COLUMN "validUntil"        DATE,
  ADD COLUMN "renewalNoticeDays" INTEGER;

ALTER TABLE "CustomerFile" ADD CONSTRAINT "CustomerFile_valid_range_check" CHECK (
  "validFrom" IS NULL OR "validUntil" IS NULL OR "validUntil" >= "validFrom"
);

ALTER TABLE "CustomerFile" ADD CONSTRAINT "CustomerFile_validity_category_check" CHECK (
  ("validFrom" IS NULL AND "validUntil" IS NULL AND "renewalNoticeDays" IS NULL)
  OR "category" IN ('CONTRACT', 'PRICE_AGREEMENT')
);

ALTER TABLE "CustomerFile" ADD CONSTRAINT "CustomerFile_notice_days_check" CHECK (
  "renewalNoticeDays" IS NULL OR "renewalNoticeDays" BETWEEN 1 AND 365
);

CREATE INDEX "CustomerFile_validUntil_idx" ON "CustomerFile"("validUntil") WHERE "validUntil" IS NOT NULL;

ALTER TABLE "SystemConfig" ADD COLUMN "contractRenewalNoticeDays" INTEGER;
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_contract_notice_check" CHECK (
  "contractRenewalNoticeDays" IS NULL OR "contractRenewalNoticeDays" BETWEEN 1 AND 365
);

COMMIT;
