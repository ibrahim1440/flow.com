-- 20261231230000_product_accounts — the accountant's request: revenue and cost of sales by SALES ACTIVITY and product.
-- (Never applied anywhere before this text: the first draft put the accounts on the category and the SKU alone; the
--  same SKU is sold by the roastery, the web shop and the café, so the account is decided by activity first.)
--
--   "SalesAccountRule"      (activity, category | SKU | neither) → revenue account, cost-of-sales account.
--                           Looked up when an entry is posted: (activity, SKU), (activity, category), (activity),
--                           then the general posting role. No rule exists after this migration: nothing changes
--                           until one is made.
--   "Order"."salesActivity", "SalesInvoice"."salesActivity"   ROASTERY_B2B | WEBSITE | CAFE. NULL on every existing
--                           row: an older document's activity is never guessed.
--   "SalesInvoiceLine"."salesCategoryId"   the line's own sales category — a café drink, a sweet, a retail item
--                           that is not a SKU of the system still reaches its category's accounts.
--   "SalesInvoiceLine"."generalAccount*"   the recorded decision (who, when, why) that a line no category rule
--                           covers posts to the general account; without it such a document is not issued.
--   "JournalEntryLine"."salesActivity" / "salesCategoryId" / "channel" / "accountBasis"   snapshots written with the
--                           line when it is posted.
--   "Account"."referenceCode"   the accountant's own number of an account, apart from "code" (which the ledger guard
--                           freezes on an account with posted lines). Reference only: it decides nothing. NOT unique:
--                           several system accounts may answer to one number of the accountant's chart (the system
--                           keeps VAT output / input / net and the stages of stock apart) — matched by function,
--                           with no account merged and no balance moved.
-- Additive: one table, nullable columns, foreign keys, CHECKs, indexes and one audit trigger. No existing row is read
-- or written; no posted line, balance or movement changes; ledger_line_guard and ledger_account_guard are not
-- touched and cover the new columns like every other column.
BEGIN;

ALTER TABLE "Account" ADD COLUMN "referenceCode" TEXT;
CREATE INDEX "Account_referenceCode_idx" ON "Account"("referenceCode");
ALTER TABLE "Account" ADD CONSTRAINT "Account_referenceCode_check" CHECK ("referenceCode" IS NULL OR "referenceCode" ~ '^[0-9A-Za-z._-]{1,20}$');

ALTER TABLE "Order" ADD COLUMN "salesActivity" TEXT;
ALTER TABLE "Order" ADD CONSTRAINT "Order_salesActivity_check" CHECK ("salesActivity" IS NULL OR "salesActivity" IN ('ROASTERY_B2B', 'WEBSITE', 'CAFE'));
ALTER TABLE "SalesInvoice" ADD COLUMN "salesActivity" TEXT;
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_salesActivity_check" CHECK ("salesActivity" IS NULL OR "salesActivity" IN ('ROASTERY_B2B', 'WEBSITE', 'CAFE'));

CREATE TABLE "SalesAccountRule" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "activity" TEXT NOT NULL,
  "categoryId" TEXT,
  "productSkuId" TEXT,
  "revenueAccountId" TEXT,
  "cogsAccountId" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesAccountRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SalesAccountRule_activity_check" CHECK ("activity" IN ('ROASTERY_B2B', 'WEBSITE', 'CAFE')),
  CONSTRAINT "SalesAccountRule_scope_check" CHECK ("categoryId" IS NULL OR "productSkuId" IS NULL),
  CONSTRAINT "SalesAccountRule_account_check" CHECK ("revenueAccountId" IS NOT NULL OR "cogsAccountId" IS NOT NULL),
  CONSTRAINT "SalesAccountRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CatalogCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SalesAccountRule_productSkuId_fkey" FOREIGN KEY ("productSkuId") REFERENCES "ProductSKU"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SalesAccountRule_revenueAccountId_fkey" FOREIGN KEY ("revenueAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SalesAccountRule_cogsAccountId_fkey" FOREIGN KEY ("cogsAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- One rule per scope: (activity), (activity, category), (activity, SKU).
CREATE UNIQUE INDEX "SalesAccountRule_scope_key" ON "SalesAccountRule"("tenantId", "activity", coalesce("categoryId", ''), coalesce("productSkuId", ''));
CREATE INDEX "SalesAccountRule_activity_idx" ON "SalesAccountRule"("activity");
CREATE INDEX "SalesAccountRule_categoryId_idx" ON "SalesAccountRule"("categoryId");
CREATE INDEX "SalesAccountRule_productSkuId_idx" ON "SalesAccountRule"("productSkuId");
-- Who changed a rule, when, before and after: the same audit function as the chart and the role mappings.
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "SalesAccountRule" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- The line's own sales category (a line that is not a SKU of the system), and the recorded decision that sends a line
-- no category rule covers to the general account: who, when and why — whole or none.
ALTER TABLE "SalesInvoiceLine" ADD COLUMN "salesCategoryId" TEXT, ADD COLUMN "generalAccountBy" TEXT, ADD COLUMN "generalAccountAt" TIMESTAMP(3), ADD COLUMN "generalAccountReason" TEXT, ADD COLUMN "generalAccountActivity" TEXT;
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_salesCategoryId_fkey" FOREIGN KEY ("salesCategoryId") REFERENCES "CatalogCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_generalAccount_check" CHECK (
  ("generalAccountBy" IS NULL AND "generalAccountAt" IS NULL AND "generalAccountReason" IS NULL AND "generalAccountActivity" IS NULL)
  OR ("generalAccountBy" IS NOT NULL AND "generalAccountAt" IS NOT NULL AND length(btrim("generalAccountReason")) BETWEEN 5 AND 300
      AND "generalAccountActivity" IN ('ROASTERY_B2B', 'WEBSITE', 'CAFE')));
CREATE INDEX "SalesInvoiceLine_salesCategoryId_idx" ON "SalesInvoiceLine"("salesCategoryId");

-- The same decision for the COST of sales of one order line (a delivery of a costed lot whose SKU no rule of the
-- order's activity gives a cost-of-sales account): one row per order line, for the activity it was made under.
CREATE TABLE "CostAccountDecision" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "orderItemId" TEXT NOT NULL,
  "activity" TEXT NOT NULL,
  "decidedBy" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CostAccountDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CostAccountDecision_activity_check" CHECK ("activity" IN ('ROASTERY_B2B', 'WEBSITE', 'CAFE')),
  CONSTRAINT "CostAccountDecision_reason_check" CHECK (length(btrim("reason")) BETWEEN 5 AND 300),
  CONSTRAINT "CostAccountDecision_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CostAccountDecision_orderItemId_key" ON "CostAccountDecision"("orderItemId");
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "CostAccountDecision" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

ALTER TABLE "JournalEntryLine" ADD COLUMN "salesActivity" TEXT, ADD COLUMN "salesCategoryId" TEXT, ADD COLUMN "channel" TEXT, ADD COLUMN "accountBasis" TEXT;
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_salesActivity_check" CHECK ("salesActivity" IS NULL OR "salesActivity" IN ('ROASTERY_B2B', 'WEBSITE', 'CAFE'));
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_channel_check" CHECK ("channel" IS NULL OR "channel" ~ '^[A-Z0-9_]{1,20}$');
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_accountBasis_check" CHECK ("accountBasis" IS NULL OR "accountBasis" IN ('ACTIVITY_SKU', 'ACTIVITY_CATEGORY', 'ACTIVITY', 'ROLE', 'ACTIVITY_DECISION', 'ROLE_DECISION'));
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_salesCategoryId_check" CHECK ("salesCategoryId" IS NULL OR length("salesCategoryId") BETWEEN 1 AND 64);
CREATE INDEX "JournalEntryLine_channel_idx" ON "JournalEntryLine"("channel");
CREATE INDEX "JournalEntryLine_salesActivity_idx" ON "JournalEntryLine"("salesActivity");

-- The runtime role reads and writes the rules (a rule with both accounts cleared is deleted; every change, the
-- deletion included, is recorded by ledger_audit_row above). Guarded like every other grant to the runtime role.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SalesAccountRule" TO flowcom_app;
    -- A decision is recorded and re-made, never removed by the application (it goes with its order line only).
    GRANT SELECT, INSERT, UPDATE ON "CostAccountDecision" TO flowcom_app;
    -- Where the runtime role UPDATEs a table column by column (no table-level UPDATE), the new column is granted too
    -- (the same rule as 20261224090000_station_orders_board). SELECT / INSERT are table grants and cover it already.
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema = current_schema() AND table_name = 'Order' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_schema = current_schema() AND table_name = 'Order' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
      GRANT UPDATE ("salesActivity") ON "Order" TO flowcom_app;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema = current_schema() AND table_name = 'SalesInvoice' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_schema = current_schema() AND table_name = 'SalesInvoice' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
      GRANT UPDATE ("salesActivity") ON "SalesInvoice" TO flowcom_app;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema = current_schema() AND table_name = 'Account' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_schema = current_schema() AND table_name = 'Account' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
      GRANT UPDATE ("referenceCode") ON "Account" TO flowcom_app;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema = current_schema() AND table_name = 'SalesInvoiceLine' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_schema = current_schema() AND table_name = 'SalesInvoiceLine' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
      GRANT UPDATE ("salesCategoryId", "generalAccountBy", "generalAccountAt", "generalAccountReason", "generalAccountActivity") ON "SalesInvoiceLine" TO flowcom_app;
    END IF;
  END IF;
END $$;

COMMIT;
