-- «بيع أصل ثابت» — selling a fixed asset through a sales-invoice line (BATCH 22 WP-F; FOLLOWUPS «qd-assets», council F1,
-- confirmed with refinements by BATCH22-DESIGN §WP-F). Any disposal for value — a sale, or scrap sold to a dealer — is a
-- taxable supply: it goes on an ordinary e-invoiced tax invoice (cleared / reported by ZATCA like any other, so VAT return
-- box 1 sees it), and the register's disposal clears it.
--
--   1. The posting role FA_DISPOSAL_CLEARING «تسوية بيع الأصول الثابتة» (a CLEARING liability): on a chart seeded from the
--      default template (its parent 2100 exists) the account 2195 is added when the code is free and the role mapped when it
--      is not mapped yet — never changing an account or a mapping that exists (the supplier-shortfall pattern). Otherwise
--      the accountant maps it («ربط الحسابات»; the readiness lists it). Its balance is the issued sale lines not yet matched
--      by a disposal (the close check).
--   2. "SalesInvoiceLine"."kind" ITEM | FIXED_ASSET_SALE (NOT NULL DEFAULT 'ITEM': a constant default, metadata only),
--      "fixedAssetId" (FK → "FixedAsset", RESTRICT) and "disposalKind" (SALE | SCRAP: the disposal it will make); a CHECK
--      requires both exactly when the kind is FIXED_ASSET_SALE. Every existing row is ITEM with neither.
--   3. "FixedAssetDisposal"."salesInvoiceLineId" (FK → "SalesInvoiceLine", RESTRICT) with a partial unique index: one live
--      (POSTED) disposal per invoice line.
--   4. "FixedAssetDisposal_values_check" REPLACED (same name): the F1 clause «proceedsNet = 0 AND vat = 0» becomes
--      «proceedsNet = 0 OR salesInvoiceLineId IS NOT NULL», and vat stays 0 (the invoice carried the VAT); a disposal from
--      a line needs no proceeds account (it debits the clearing role). Every existing row has proceedsNet = 0 and vat = 0,
--      so the new CHECK holds for all of them (it is validated here, not NOT VALID).
--   5. The guards (all P0001 'FA_SALE: …'):
--      fa_sale_line_guard        a FIXED_ASSET_SALE line only on an INVOICE, for an ACTIVE / FULLY_DEPRECIATED asset without
--                                a live disposal; a credit-note line on a sale line is refused while that line has a live
--                                disposal (cancel the disposal first, then credit);
--      fa_sale_line_unique       (deferred, at commit, under the asset's row lock) one live sale line per asset: lines of
--                                DRAFT invoices and of ISSUED invoices not fully credited — two drafts never sell one asset;
--      fa_sale_invoice_guard     a credit note is not issued, and an invoice is not cancelled, while a sale line it
--                                touches has a live disposal;
--      fa_sale_disposal_guard    a disposal from a line names an ISSUED invoice's sale line of THIS asset, is dated on or
--                                after its supply date, takes the line's net as its proceeds and the line's disposal kind,
--                                carries no VAT, and never changes its line.
--   6. The runtime role (flowcom_app), when it exists, is granted the guard functions (the columns need no new grant).
--
-- ADDITIVE except the CHECK replaced in 4 (the design's «check 60's clause replaced»). Nothing posted before go-live: both
-- the invoice entry and the disposal entry follow the existing skipped-entry pattern.
-- Atomic: one transaction. Rollback: docs/hr/migration-review/rollback-20261128090000_fa_sale_invoice.sql.
BEGIN;

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SalesInvoiceLine"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'ITEM',
  ADD COLUMN "fixedAssetId" TEXT,
  ADD COLUMN "disposalKind" TEXT;
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_kind_check" CHECK (
  "kind" IN ('ITEM', 'FIXED_ASSET_SALE')
  AND (("kind" = 'FIXED_ASSET_SALE') = ("fixedAssetId" IS NOT NULL))
  AND (("kind" = 'FIXED_ASSET_SALE') = ("disposalKind" IS NOT NULL))
  AND ("disposalKind" IS NULL OR "disposalKind" IN ('SALE', 'SCRAP'))
  AND ("kind" = 'ITEM' OR ("quantity" = 1 AND "orderItemId" IS NULL AND "deliveryId" IS NULL AND "productSkuId" IS NULL)));
CREATE INDEX "SalesInvoiceLine_fixedAssetId_idx" ON "SalesInvoiceLine"("fixedAssetId");
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_fixedAssetId_fkey" FOREIGN KEY ("fixedAssetId") REFERENCES "FixedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3 / 4 ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "FixedAssetDisposal" ADD COLUMN "salesInvoiceLineId" TEXT;
CREATE UNIQUE INDEX "FixedAssetDisposal_line_live_key" ON "FixedAssetDisposal"("salesInvoiceLineId") WHERE "status" = 'POSTED' AND "salesInvoiceLineId" IS NOT NULL;
ALTER TABLE "FixedAssetDisposal" ADD CONSTRAINT "FixedAssetDisposal_salesInvoiceLineId_fkey" FOREIGN KEY ("salesInvoiceLineId") REFERENCES "SalesInvoiceLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAssetDisposal" DROP CONSTRAINT "FixedAssetDisposal_values_check";
ALTER TABLE "FixedAssetDisposal" ADD CONSTRAINT "FixedAssetDisposal_values_check" CHECK ("kind" IN ('SALE', 'SCRAP')
    AND "proceedsNet" >= 0 AND "vat" >= 0 AND "vatRate" IN (0, 15) AND ("vatRate" > 0 OR "vat" = 0)
    AND ("kind" <> 'SCRAP' OR "vat" = 0)
    -- WP-F (replaces council F1's «proceedsNet = 0 AND vat = 0»): a disposal for value takes its proceeds from an issued
    -- sales-invoice line «بيع أصل ثابت», which carried the output VAT; the disposal itself never carries VAT.
    AND ("proceedsNet" = 0 OR "salesInvoiceLineId" IS NOT NULL) AND "vat" = 0
    AND (("proceedsNet" + "vat" = 0) OR "proceedsAccountId" IS NOT NULL OR "salesInvoiceLineId" IS NOT NULL OR "glState" = 'SKIPPED')
    AND "catchUpDepreciation" >= 0 AND "costRemoved" > 0 AND "accumRemoved" >= 0 AND "accumRemoved" <= "costRemoved"
    AND "gainLoss" = "proceedsNet" - ("costRemoved" - "accumRemoved")
    AND ("buyerName" IS NULL OR length("buyerName") <= 200) AND ("taxInvoiceRef" IS NULL OR length("taxInvoiceRef") <= 60)
    AND "status" IN ('POSTED', 'CANCELLED') AND "glState" IN ('POSTED', 'SKIPPED') AND (("glState" = 'POSTED') = ("journalEntryId" IS NOT NULL))
    AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)) AND ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancelReason", ''))) >= 3));

-- 5 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fa_sale_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv record; a record; ol record;
BEGIN
  SELECT i."kind", i."status" INTO inv FROM "SalesInvoice" i WHERE i."id" = NEW."invoiceId";
  IF NEW."kind" = 'FIXED_ASSET_SALE' THEN
    IF inv."kind" IS DISTINCT FROM 'INVOICE' THEN
      RAISE EXCEPTION 'FA_SALE: a fixed-asset sale line belongs to a tax invoice, not a note' USING ERRCODE = 'P0001';
    END IF;
    IF TG_OP = 'INSERT' OR NEW."fixedAssetId" IS DISTINCT FROM OLD."fixedAssetId" THEN
      SELECT "status" INTO a FROM "FixedAsset" WHERE "id" = NEW."fixedAssetId";
      IF NOT FOUND OR a."status" NOT IN ('ACTIVE', 'FULLY_DEPRECIATED')
         OR EXISTS (SELECT 1 FROM "FixedAssetDisposal" d WHERE d."assetId" = NEW."fixedAssetId" AND d."status" = 'POSTED') THEN
        RAISE EXCEPTION 'FA_SALE: only an active (or fully depreciated) asset without a live disposal is sold' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  IF NEW."originalLineId" IS NOT NULL AND inv."kind" = 'CREDIT_NOTE' THEN
    SELECT l."kind" INTO ol FROM "SalesInvoiceLine" l WHERE l."id" = NEW."originalLineId";
    IF ol."kind" = 'FIXED_ASSET_SALE' AND EXISTS (SELECT 1 FROM "FixedAssetDisposal" d WHERE d."salesInvoiceLineId" = NEW."originalLineId" AND d."status" = 'POSTED') THEN
      RAISE EXCEPTION 'FA_SALE: the asset sold on this line is disposed of; cancel the disposal before crediting the line' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fa_sale_line_guard BEFORE INSERT OR UPDATE ON "SalesInvoiceLine" FOR EACH ROW EXECUTE FUNCTION fa_sale_line_guard();

CREATE OR REPLACE FUNCTION fa_sale_line_unique() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  IF NEW."kind" <> 'FIXED_ASSET_SALE' THEN RETURN NULL; END IF;
  PERFORM 1 FROM "FixedAsset" WHERE "id" = NEW."fixedAssetId" FOR UPDATE;
  SELECT count(*) INTO n FROM "SalesInvoiceLine" l JOIN "SalesInvoice" i ON i."id" = l."invoiceId"
   WHERE l."fixedAssetId" = NEW."fixedAssetId" AND l."kind" = 'FIXED_ASSET_SALE'
     AND (i."status" = 'DRAFT'
          OR (i."status" = 'ISSUED' AND l."lineNet" > coalesce((SELECT sum(c."lineNet") FROM "SalesInvoiceLine" c JOIN "SalesInvoice" ci ON ci."id" = c."invoiceId"
                                                                 WHERE c."originalLineId" = l."id" AND ci."kind" = 'CREDIT_NOTE' AND ci."status" = 'ISSUED'), 0)));
  IF n > 1 THEN
    RAISE EXCEPTION 'FA_SALE: this asset is already on another open sale line (a draft or an issued, uncredited invoice)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fa_sale_line_unique AFTER INSERT OR UPDATE ON "SalesInvoiceLine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fa_sale_line_unique();

CREATE OR REPLACE FUNCTION fa_sale_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUED' AND NEW."kind" = 'CREDIT_NOTE'
     AND EXISTS (SELECT 1 FROM "SalesInvoiceLine" c JOIN "FixedAssetDisposal" d ON d."salesInvoiceLineId" = c."originalLineId" AND d."status" = 'POSTED'
                  WHERE c."invoiceId" = NEW."id") THEN
    RAISE EXCEPTION 'FA_SALE: the asset sold on the credited line is disposed of; cancel the disposal before issuing the credit note' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."status" = 'CANCELLED' AND OLD."status" IS DISTINCT FROM 'CANCELLED'
     AND EXISTS (SELECT 1 FROM "SalesInvoiceLine" l JOIN "FixedAssetDisposal" d ON d."salesInvoiceLineId" = l."id" AND d."status" = 'POSTED' WHERE l."invoiceId" = NEW."id") THEN
    RAISE EXCEPTION 'FA_SALE: an invoice whose sale line has a live disposal is not cancelled' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fa_sale_invoice_guard BEFORE UPDATE OF "status" ON "SalesInvoice" FOR EACH ROW EXECUTE FUNCTION fa_sale_invoice_guard();

CREATE OR REPLACE FUNCTION fa_sale_disposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l record; credited numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."salesInvoiceLineId" IS DISTINCT FROM OLD."salesInvoiceLineId" THEN
      RAISE EXCEPTION 'FA_SALE: a disposal never changes its invoice line' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."salesInvoiceLineId" IS NULL THEN RETURN NEW; END IF;
  SELECT sl."kind", sl."fixedAssetId", sl."disposalKind", sl."lineNet", i."status", i."kind" AS ikind, i."supplyDate"
    INTO l FROM "SalesInvoiceLine" sl JOIN "SalesInvoice" i ON i."id" = sl."invoiceId" WHERE sl."id" = NEW."salesInvoiceLineId" FOR SHARE OF i;
  IF NOT FOUND OR l."kind" <> 'FIXED_ASSET_SALE' OR l."fixedAssetId" <> NEW."assetId" OR l."status" <> 'ISSUED' OR l.ikind <> 'INVOICE' THEN
    RAISE EXCEPTION 'FA_SALE: a disposal for value names an issued invoice''s sale line of this asset' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum(c."lineNet"), 0) INTO credited FROM "SalesInvoiceLine" c JOIN "SalesInvoice" ci ON ci."id" = c."invoiceId"
   WHERE c."originalLineId" = NEW."salesInvoiceLineId" AND ci."kind" = 'CREDIT_NOTE' AND ci."status" = 'ISSUED';
  IF credited > 0 THEN
    RAISE EXCEPTION 'FA_SALE: the sale line was credited; record the disposal against a corrected invoice' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."disposalDate" < l."supplyDate" OR NEW."proceedsNet" <> l."lineNet" OR NEW."kind" <> l."disposalKind" OR NEW."vat" <> 0 THEN
    RAISE EXCEPTION 'FA_SALE: the disposal takes the line''s net (no VAT) and kind, on or after its supply date' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fa_sale_disposal_guard BEFORE INSERT OR UPDATE ON "FixedAssetDisposal" FOR EACH ROW EXECUTE FUNCTION fa_sale_disposal_guard();

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE p text; a text;
BEGIN
  -- FA_DISPOSAL_CLEARING → 2195 under 2100 (current liabilities); fed by the invoice and the disposal (no manual journal).
  IF NOT EXISTS (SELECT 1 FROM "AccountRole" WHERE "tenantId" = 'hiqbah' AND "role" = 'FA_DISPOSAL_CLEARING') THEN
    SELECT "id" INTO p FROM "Account" WHERE "code" = '2100';
    IF p IS NOT NULL THEN
      SELECT "id" INTO a FROM "Account" WHERE "code" = '2195' AND "type"::text = 'LIABILITY' AND "allowPosting" AND "isActive";
      IF a IS NULL AND NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '2195') THEN
        a := 'acc_' || replace(gen_random_uuid()::text, '-', '');
        INSERT INTO "Account" ("id", "code", "nameAr", "nameEn", "parentId", "type", "allowPosting", "isActive", "allowManualJournal", "controlType", "createdBy", "updatedBy", "updatedAt")
        VALUES (a, '2195', 'تسوية بيع الأصول الثابتة', 'Fixed-asset sale clearing', p, 'LIABILITY', true, true, false, 'CLEARING', 'migration', 'migration', now());
      END IF;
      IF a IS NOT NULL THEN
        INSERT INTO "AccountRole" ("id", "tenantId", "role", "accountId", "updatedBy", "updatedAt") VALUES ('ar_' || replace(gen_random_uuid()::text, '-', ''), 'hiqbah', 'FA_DISPOSAL_CLEARING', a, 'migration', now());
      END IF;
    END IF;
  END IF;
END $$;

-- 6 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT EXECUTE ON FUNCTION fa_sale_line_guard(), fa_sale_line_unique(), fa_sale_invoice_guard(), fa_sale_disposal_guard() TO flowcom_app;
  END IF;
END $$;

COMMIT;
