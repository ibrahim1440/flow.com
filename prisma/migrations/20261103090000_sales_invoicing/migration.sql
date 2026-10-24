-- Sales invoicing + accounts receivable — accounting phase A2 (feat/accounting-invoicing), on top of the
-- accounting core A1 (20261102090000_accounting_core). Owner authorisation: the accounting module and ZATCA
-- Phase 2. ZATCA-ready data model, no signing (A4 fills the zatca* columns).
--
-- The database guarantees (docs/accounting/POSTING-CONTRACT.md §7a):
--   1. LIFECYCLE — a document is born DRAFT; DRAFT → ISSUED or DRAFT → CANCELLED; nothing else. An ISSUED
--      document never changes (only the A4 ZATCA columns may be written) and is never deleted; a CANCELLED
--      one never changes. Its UUID never changes. A line of an issued / cancelled document is never added,
--      changed or deleted (sinv_invoice_guard, sinv_line_guard).
--   2. GAPLESS NUMBERING — at issue the database takes the next value of the series' counter
--      (SalesDocumentCounter, updated inside the issue transaction — never a sequence; a rollback consumes no
--      number) and writes seq and number = series || '-' || lpad(seq, 6). A number written by hand is refused.
--   3. E-10 TOTALS — at issue: each line's net = round(qty × price) − discount, discount = round(gross × %);
--      the document's VAT = Σ over (category, rate) of round(Σ net × rate), NOT Σ line VAT; taxable = Σ net;
--      payable = taxable + VAT > 0. Category S has a rate > 0; Z / E / O have rate 0 and an exemption reason.
--   4. PARTICULARS — at issue: the seller snapshot (name, VAT number 3…3 of 15 digits); a STANDARD invoice's
--      buyer VAT number (15 digits, 3…3) and the supply date; issue day = the Riyadh day of issuedAt.
--   5. NOTES — a credit / debit note names an ISSUED invoice of the same customer and family, a reason code and
--      a reason; a credit note line names a line of that invoice; Σ credited net per original line ≤ its net,
--      each credited quantity ≤ its quantity; Σ issued credit notes ≤ the invoice + its issued debit notes.
--   6. OVER-INVOICING — Σ invoiced quantity (DRAFT + ISSUED invoices) per order line ≤ the ordered quantity,
--      checked at COMMIT under a row lock on the order line (sinv_order_cap).
--   7. AR MATCHING — an application names an ISSUED invoice / debit note and an APPROVED receipt or an ISSUED
--      credit note of the same customer; Σ applied ≤ what the invoice owes, ≤ the receipt / the credit; never
--      deleted; its only change is APPLIED → REVERSED with who / when / why (sinv_ar_guard, row locks).
--   8. AUDIT — every change of a document or an application is written to "AccountingAuditLog" by the A1
--      trigger ledger_audit_row (who, when, before / after, IP, device).
--
-- ADDITIVE: four new, empty tables; nullable columns on "SystemConfig"; CHECKs on the new rows (and on the new
-- SystemConfig columns, NULL in every existing row); sinv_* functions and their triggers on the new tables only.
-- No existing row is read or rewritten. Customer / order / order line / delivery are plain ids (no foreign keys):
-- like the ledger, an issued invoice outlives a reset of operational data; the resets do not touch these tables.
-- Grants: re-run scripts/hr/grant-hr-runtime.sql (tables + sinv_* functions).
-- Atomic: one transaction. Rollback: docs/hr/migration-review/rollback-20261103090000_sales_invoicing.sql.
BEGIN;

-- AlterTable
ALTER TABLE "SystemConfig" ADD COLUMN     "creditNotePrefix" TEXT,
ADD COLUMN     "debitNotePrefix" TEXT,
ADD COLUMN     "invoiceDefaultTermsDays" INTEGER,
ADD COLUMN     "invoicePrefix" TEXT,
ADD COLUMN     "invoicingPoint" TEXT,
ADD COLUMN     "sellerAdditionalNo" TEXT,
ADD COLUMN     "sellerBuildingNo" TEXT,
ADD COLUMN     "sellerCity" TEXT,
ADD COLUMN     "sellerDistrict" TEXT,
ADD COLUMN     "sellerPostalCode" TEXT,
ADD COLUMN     "sellerStreet" TEXT;

-- CreateTable
CREATE TABLE "SalesInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL DEFAULT 'INVOICE',
    "family" TEXT NOT NULL DEFAULT 'STANDARD',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "series" TEXT,
    "seq" INTEGER,
    "number" TEXT,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "quoteId" TEXT,
    "originalInvoiceId" TEXT,
    "reasonCode" TEXT,
    "reason" TEXT,
    "issueDate" DATE,
    "issueTime" TEXT,
    "issuedAt" TIMESTAMP(3),
    "supplyDate" DATE,
    "supplyEndDate" DATE,
    "dueDate" DATE,
    "paymentTermsDays" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "lineExtensionTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxBreakdown" JSONB,
    "buyer" JSONB NOT NULL,
    "seller" JSONB,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "requestKey" TEXT,
    "createdById" TEXT NOT NULL,
    "issuedById" TEXT,
    "sodBypass" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "zatcaIcv" BIGINT,
    "zatcaPih" TEXT,
    "zatcaInvoiceHash" TEXT,
    "zatcaQr" TEXT,
    "zatcaStatus" TEXT,
    "zatcaXmlRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesInvoiceLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "orderItemId" TEXT,
    "deliveryId" TEXT,
    "productSkuId" TEXT,
    "originalLineId" TEXT,
    "description" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "skuCode" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'UNIT',
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxCategory" TEXT NOT NULL DEFAULT 'S',
    "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "exemptionReasonCode" TEXT,
    "exemptionReason" TEXT,
    "lineNet" DECIMAL(18,2) NOT NULL,
    "lineTax" DECIMAL(18,2) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDocumentCounter" (
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "series" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SalesDocumentCounter_pkey" PRIMARY KEY ("tenantId","series")
);

-- CreateTable
CREATE TABLE "ArApplication" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "collectionId" TEXT,
    "creditNoteId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "appliedDate" DATE NOT NULL,
    "atReceipt" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reverseReason" TEXT,

    CONSTRAINT "ArApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesInvoice_uuid_key" ON "SalesInvoice"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "SalesInvoice_requestKey_key" ON "SalesInvoice"("requestKey");

-- CreateIndex
CREATE INDEX "SalesInvoice_customerId_status_idx" ON "SalesInvoice"("customerId", "status");

-- CreateIndex
CREATE INDEX "SalesInvoice_orderId_idx" ON "SalesInvoice"("orderId");

-- CreateIndex
CREATE INDEX "SalesInvoice_originalInvoiceId_idx" ON "SalesInvoice"("originalInvoiceId");

-- CreateIndex
CREATE INDEX "SalesInvoice_kind_status_createdAt_idx" ON "SalesInvoice"("kind", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SalesInvoice_status_issueDate_idx" ON "SalesInvoice"("status", "issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "SalesInvoice_tenantId_number_key" ON "SalesInvoice"("tenantId", "number");

-- CreateIndex
CREATE INDEX "SalesInvoiceLine_invoiceId_position_idx" ON "SalesInvoiceLine"("invoiceId", "position");

-- CreateIndex
CREATE INDEX "SalesInvoiceLine_orderItemId_idx" ON "SalesInvoiceLine"("orderItemId");

-- CreateIndex
CREATE INDEX "SalesInvoiceLine_originalLineId_idx" ON "SalesInvoiceLine"("originalLineId");

-- CreateIndex
CREATE INDEX "ArApplication_invoiceId_status_idx" ON "ArApplication"("invoiceId", "status");

-- CreateIndex
CREATE INDEX "ArApplication_collectionId_status_idx" ON "ArApplication"("collectionId", "status");

-- CreateIndex
CREATE INDEX "ArApplication_creditNoteId_status_idx" ON "ArApplication"("creditNoteId", "status");

-- CreateIndex
CREATE INDEX "ArApplication_customerId_status_idx" ON "ArApplication"("customerId", "status");

-- AddForeignKey
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_originalInvoiceId_fkey" FOREIGN KEY ("originalInvoiceId") REFERENCES "SalesInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_originalLineId_fkey" FOREIGN KEY ("originalLineId") REFERENCES "SalesInvoiceLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArApplication" ADD CONSTRAINT "ArApplication_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArApplication" ADD CONSTRAINT "ArApplication_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "SalesCollection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArApplication" ADD CONSTRAINT "ArApplication_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "SalesInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── CHECKs ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_invoicing_a2_check" CHECK (
      ("invoicePrefix" IS NULL OR "invoicePrefix" ~ '^[A-Z0-9]{1,10}$')
  AND ("creditNotePrefix" IS NULL OR "creditNotePrefix" ~ '^[A-Z0-9]{1,10}$')
  AND ("debitNotePrefix" IS NULL OR "debitNotePrefix" ~ '^[A-Z0-9]{1,10}$')
  AND ("invoicingPoint" IS NULL OR "invoicingPoint" IN ('MANUAL', 'ON_DELIVERY'))
  AND ("invoiceDefaultTermsDays" IS NULL OR "invoiceDefaultTermsDays" BETWEEN 0 AND 365));

ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_kind_check" CHECK ("kind" IN ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE')),
  ADD CONSTRAINT "SalesInvoice_family_check" CHECK ("family" IN ('STANDARD', 'SIMPLIFIED')),
  ADD CONSTRAINT "SalesInvoice_status_check" CHECK ("status" IN ('DRAFT', 'ISSUED', 'CANCELLED')),
  ADD CONSTRAINT "SalesInvoice_currency_check" CHECK ("currency" = 'SAR'),
  ADD CONSTRAINT "SalesInvoice_source_check" CHECK ("source" IN ('MANUAL', 'ORDER', 'DELIVERY')),
  ADD CONSTRAINT "SalesInvoice_note_check" CHECK (("kind" = 'INVOICE') = ("originalInvoiceId" IS NULL)
    AND ("kind" = 'INVOICE' OR "reasonCode" IS NOT NULL)
    AND ("reasonCode" IS NULL OR "reasonCode" IN ('RETURN', 'PRICE_ADJUSTMENT', 'DISCOUNT', 'CANCELLATION', 'AMENDMENT', 'OTHER'))),
  ADD CONSTRAINT "SalesInvoice_issued_check" CHECK (("status" = 'ISSUED') = ("number" IS NOT NULL)
    AND ("number" IS NULL) = ("seq" IS NULL) AND ("seq" IS NULL OR "seq" > 0)
    AND ("status" <> 'ISSUED' OR ("series" IS NOT NULL AND "issuedAt" IS NOT NULL AND "issueDate" IS NOT NULL AND "issueTime" IS NOT NULL AND "seller" IS NOT NULL AND "issuedById" IS NOT NULL))),
  ADD CONSTRAINT "SalesInvoice_cancel_check" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)
    AND ("cancelledAt" IS NULL OR ("cancelledById" IS NOT NULL AND length(btrim(coalesce("cancelReason", ''))) >= 3))),
  ADD CONSTRAINT "SalesInvoice_amounts_check" CHECK ("lineExtensionTotal" >= 0 AND "discountTotal" >= 0 AND "taxableTotal" >= 0 AND "taxTotal" >= 0 AND "grandTotal" >= 0),
  ADD CONSTRAINT "SalesInvoice_dates_check" CHECK (("paymentTermsDays" IS NULL OR "paymentTermsDays" BETWEEN 0 AND 365)
    AND ("issueTime" IS NULL OR "issueTime" ~ '^[0-2][0-9]:[0-5][0-9]:[0-5][0-9]$')
    AND ("supplyEndDate" IS NULL OR "supplyDate" IS NULL OR "supplyEndDate" >= "supplyDate")
    AND ("dueDate" IS NULL OR "issueDate" IS NULL OR "dueDate" >= "issueDate")),
  ADD CONSTRAINT "SalesInvoice_series_check" CHECK ("series" IS NULL OR "series" ~ '^[A-Z0-9]{1,10}$');

ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_amounts_check" CHECK ("quantity" > 0 AND "unitPrice" >= 0
    AND "discountPercent" BETWEEN 0 AND 100 AND "discountAmount" >= 0 AND "lineNet" >= 0 AND "lineTax" >= 0 AND "lineTotal" >= 0),
  ADD CONSTRAINT "SalesInvoiceLine_tax_check" CHECK ("taxCategory" IN ('S', 'Z', 'E', 'O') AND "taxRatePercent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "SalesInvoiceLine_unit_check" CHECK ("unit" IN ('UNIT', 'KG'));

ALTER TABLE "SalesDocumentCounter" ADD CONSTRAINT "SalesDocumentCounter_check" CHECK ("value" >= 0 AND "series" ~ '^[A-Z0-9]{1,10}$');

ALTER TABLE "ArApplication" ADD CONSTRAINT "ArApplication_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "ArApplication_source_check" CHECK (("collectionId" IS NULL) <> ("creditNoteId" IS NULL) AND ("creditNoteId" IS NULL OR NOT "atReceipt")),
  ADD CONSTRAINT "ArApplication_status_check" CHECK ("status" IN ('APPLIED', 'REVERSED') AND ("status" = 'REVERSED') = ("reversedAt" IS NOT NULL)
    AND ("reversedAt" IS NULL OR ("reversedById" IS NOT NULL AND length(btrim(coalesce("reverseReason", ''))) >= 3)));

-- ── 1–5 · the document: lifecycle, immutability, numbering, E-10 totals, particulars, notes ─────────
CREATE OR REPLACE FUNCTION sinv_invoice_guard() RETURNS trigger AS $$
DECLARE
  zatca text[] := ARRAY['zatcaIcv', 'zatcaPih', 'zatcaInvoiceHash', 'zatcaQr', 'zatcaStatus', 'zatcaXmlRef', 'updatedAt'];
  t RECORD; o RECORD; seqv integer; bad integer; n integer; credited numeric; debited numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'SINV: an issued or cancelled invoice is never deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."number" IS NOT NULL OR NEW."seq" IS NOT NULL OR NEW."issuedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'SINV: an invoice is created as a DRAFT, without a number' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF NEW."uuid" IS DISTINCT FROM OLD."uuid" OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION 'SINV: an invoice keeps its id and UUID' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'SINV: a cancelled draft never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'ISSUED' THEN
    IF (to_jsonb(NEW) - zatca) <> (to_jsonb(OLD) - zatca) THEN
      RAISE EXCEPTION 'SINV: an issued invoice never changes (a correction is a credit or debit note)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- OLD is a DRAFT.
  IF NEW."status" = 'DRAFT' OR NEW."status" = 'CANCELLED' THEN
    IF NEW."number" IS NOT NULL OR NEW."seq" IS NOT NULL THEN
      RAISE EXCEPTION 'SINV: the number is assigned by the database at issue' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- DRAFT → ISSUED.
  IF NEW."number" IS NOT NULL OR NEW."seq" IS NOT NULL THEN
    RAISE EXCEPTION 'SINV: the number is assigned by the database at issue' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."series" IS NULL OR NEW."issuedAt" IS NULL OR NEW."issueDate" IS NULL OR NEW."issueTime" IS NULL OR NEW."issuedById" IS NULL THEN
    RAISE EXCEPTION 'SINV: an issued invoice has its series, issue date and time and issuer' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."issueDate" <> ((NEW."issuedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Riyadh')::date THEN
    RAISE EXCEPTION 'SINV: the issue date is the Riyadh day of the issue instant' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seller" IS NULL OR length(btrim(coalesce(NEW."seller"->>'name', ''))) = 0 OR coalesce(NEW."seller"->>'vatNumber', '') !~ '^3[0-9]{13}3$' THEN
    RAISE EXCEPTION 'SINV: the seller snapshot names the seller and its VAT number (15 digits, starting and ending with 3)' USING ERRCODE = 'check_violation';
  END IF;
  IF length(btrim(coalesce(NEW."buyer"->>'name', ''))) = 0 THEN
    RAISE EXCEPTION 'SINV: the buyer snapshot names the buyer' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."family" = 'STANDARD' AND (coalesce(NEW."buyer"->>'vatNumber', '') !~ '^3[0-9]{13}3$' OR NEW."supplyDate" IS NULL) THEN
    RAISE EXCEPTION 'SINV: a standard tax invoice states the buyer VAT number (15 digits, starting and ending with 3) and the supply date' USING ERRCODE = 'check_violation';
  END IF;
  -- Lines: their own arithmetic and tax categories.
  SELECT count(*) INTO n FROM "SalesInvoiceLine" l WHERE l."invoiceId" = NEW."id";
  IF n = 0 THEN
    RAISE EXCEPTION 'SINV: an issued invoice has at least one line' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO bad FROM "SalesInvoiceLine" l WHERE l."invoiceId" = NEW."id" AND (
       l."discountAmount" <> round(round(l."quantity" * l."unitPrice", 2) * l."discountPercent" / 100, 2)
    OR l."lineNet" <> round(l."quantity" * l."unitPrice", 2) - l."discountAmount"
    OR l."lineTax" <> round(l."lineNet" * l."taxRatePercent" / 100, 2)
    OR l."lineTotal" <> l."lineNet" + l."lineTax"
    OR (l."taxCategory" = 'S' AND l."taxRatePercent" <= 0)
    OR (l."taxCategory" <> 'S' AND (l."taxRatePercent" <> 0 OR length(btrim(coalesce(l."exemptionReason", ''))) = 0)));
  IF bad > 0 THEN
    RAISE EXCEPTION 'SINV: % line(s) of the invoice do not follow the line arithmetic or the tax category rules', bad USING ERRCODE = 'check_violation';
  END IF;
  -- E-10: VAT per (category, rate) on the taxable total, rounded once.
  SELECT coalesce(sum(g.net), 0) AS net, coalesce(sum(round(g.net * g.rate / 100, 2)), 0) AS vat, coalesce(sum(g.disc), 0) AS disc INTO t
    FROM (SELECT l."taxCategory", l."taxRatePercent" AS rate, sum(l."lineNet") AS net, sum(l."discountAmount") AS disc
            FROM "SalesInvoiceLine" l WHERE l."invoiceId" = NEW."id" GROUP BY l."taxCategory", l."taxRatePercent") g;
  IF NEW."lineExtensionTotal" <> t.net OR NEW."taxableTotal" <> t.net OR NEW."taxTotal" <> t.vat OR NEW."discountTotal" <> t.disc
     OR NEW."grandTotal" <> t.net + t.vat OR NEW."grandTotal" <= 0 THEN
    RAISE EXCEPTION 'SINV: the document totals follow its lines (taxable %, VAT per category on the total %, payable %)', t.net, t.vat, t.net + t.vat USING ERRCODE = 'check_violation';
  END IF;
  -- Notes: an issued original of the same customer and family; credit capped by the original (+ its debit notes).
  IF NEW."kind" <> 'INVOICE' THEN
    SELECT i."status", i."kind", i."customerId", i."family", i."grandTotal" INTO o FROM "SalesInvoice" i WHERE i."id" = NEW."originalInvoiceId" FOR UPDATE;
    IF NOT FOUND OR o."status" <> 'ISSUED' OR o."kind" <> 'INVOICE' OR o."customerId" <> NEW."customerId" OR o."family" <> NEW."family" THEN
      RAISE EXCEPTION 'SINV: a credit or debit note names an issued invoice of the same customer and family' USING ERRCODE = 'check_violation';
    END IF;
    IF length(btrim(coalesce(NEW."reason", ''))) < 3 THEN
      RAISE EXCEPTION 'SINV: a credit or debit note states its reason' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'CREDIT_NOTE' THEN
      SELECT coalesce(sum(c."grandTotal"), 0) INTO credited FROM "SalesInvoice" c
       WHERE c."originalInvoiceId" = NEW."originalInvoiceId" AND c."kind" = 'CREDIT_NOTE' AND c."status" = 'ISSUED' AND c."id" <> NEW."id";
      SELECT coalesce(sum(c."grandTotal"), 0) INTO debited FROM "SalesInvoice" c
       WHERE c."originalInvoiceId" = NEW."originalInvoiceId" AND c."kind" = 'DEBIT_NOTE' AND c."status" = 'ISSUED';
      IF credited + NEW."grandTotal" > o."grandTotal" + debited THEN
        RAISE EXCEPTION 'SINV: the credit notes of an invoice never exceed what it (and its debit notes) charged' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  -- The number: the next value of the series' counter, inside this transaction.
  INSERT INTO "SalesDocumentCounter" ("tenantId", "series", "value") VALUES (NEW."tenantId", NEW."series", 1)
    ON CONFLICT ("tenantId", "series") DO UPDATE SET "value" = "SalesDocumentCounter"."value" + 1
    RETURNING "value" INTO seqv;
  NEW."seq" := seqv;
  NEW."number" := NEW."series" || '-' || lpad(seqv::text, 6, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sinv_invoice_guard BEFORE INSERT OR UPDATE OR DELETE ON "SalesInvoice"
  FOR EACH ROW EXECUTE FUNCTION sinv_invoice_guard();

-- A line changes only while its document is a DRAFT; a note's line names a line of the note's original.
CREATE OR REPLACE FUNCTION sinv_line_guard() RETURNS trigger AS $$
DECLARE st text; inv RECORD;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT i."status" INTO st FROM "SalesInvoice" i WHERE i."id" = OLD."invoiceId";
    IF st IS DISTINCT FROM 'DRAFT' AND st IS NOT NULL THEN
      RAISE EXCEPTION 'SINV: a line of an issued or cancelled invoice is never changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  END IF;
  SELECT i."status", i."kind", i."originalInvoiceId" INTO inv FROM "SalesInvoice" i WHERE i."id" = NEW."invoiceId";
  IF inv."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'SINV: a line is added or changed only on a draft' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF inv."kind" = 'CREDIT_NOTE' AND NEW."originalLineId" IS NULL THEN
    RAISE EXCEPTION 'SINV: a credit note line names the invoice line it credits' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."originalLineId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SalesInvoiceLine" ol WHERE ol."id" = NEW."originalLineId" AND ol."invoiceId" = inv."originalInvoiceId") THEN
    RAISE EXCEPTION 'SINV: a note line names a line of the note''s original invoice' USING ERRCODE = 'check_violation';
  END IF;
  IF inv."kind" <> 'INVOICE' AND NEW."orderItemId" IS NOT NULL THEN
    RAISE EXCEPTION 'SINV: only an invoice line invoices an order line' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sinv_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "SalesInvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION sinv_line_guard();

-- 6 · over-invoicing and 5 · the credit cap per line, at COMMIT, under a row lock (a concurrent transaction
-- waits, then reads the committed rows: each statement of a READ COMMITTED function takes a fresh snapshot).
CREATE OR REPLACE FUNCTION sinv_line_caps() RETURNS trigger AS $$
DECLARE inv RECORD; ordered numeric; invoiced numeric; orig RECORD; credited numeric;
BEGIN
  SELECT i."status", i."kind" INTO inv FROM "SalesInvoice" i WHERE i."id" = NEW."invoiceId";
  IF NOT FOUND OR inv."status" = 'CANCELLED' THEN RETURN NULL; END IF;
  IF NEW."orderItemId" IS NOT NULL AND inv."kind" = 'INVOICE' THEN
    SELECT coalesce(oi."quantityUnits"::numeric, oi."quantityKg"::numeric) INTO ordered FROM "OrderItem" oi WHERE oi."id" = NEW."orderItemId" FOR UPDATE;
    IF FOUND THEN
      SELECT coalesce(sum(l."quantity"), 0) INTO invoiced FROM "SalesInvoiceLine" l JOIN "SalesInvoice" i ON i."id" = l."invoiceId"
       WHERE l."orderItemId" = NEW."orderItemId" AND i."kind" = 'INVOICE' AND i."status" IN ('DRAFT', 'ISSUED');
      IF invoiced > round(ordered, 3) THEN
        RAISE EXCEPTION 'SINV: over-invoicing: % invoiced on an order line of % ordered', invoiced, round(ordered, 3) USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."originalLineId" IS NOT NULL AND inv."kind" = 'CREDIT_NOTE' THEN
    SELECT ol."quantity", ol."lineNet", ol."invoiceId" INTO orig FROM "SalesInvoiceLine" ol WHERE ol."id" = NEW."originalLineId";
    PERFORM 1 FROM "SalesInvoice" i WHERE i."id" = orig."invoiceId" FOR UPDATE;
    IF NEW."quantity" > orig."quantity" THEN
      RAISE EXCEPTION 'SINV: a credit note line credits at most the quantity invoiced (% > %)', NEW."quantity", orig."quantity" USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(l."lineNet"), 0) INTO credited FROM "SalesInvoiceLine" l JOIN "SalesInvoice" i ON i."id" = l."invoiceId"
     WHERE l."originalLineId" = NEW."originalLineId" AND i."kind" = 'CREDIT_NOTE' AND i."status" IN ('DRAFT', 'ISSUED');
    IF credited > orig."lineNet" THEN
      RAISE EXCEPTION 'SINV: credit notes credit at most what the invoice line charged (% > %)', credited, orig."lineNet" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER sinv_line_caps AFTER INSERT OR UPDATE ON "SalesInvoiceLine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sinv_line_caps();

-- 7 · AR matching.
CREATE OR REPLACE FUNCTION sinv_ar_guard() RETURNS trigger AS $$
DECLARE inv RECORD; src RECORD; applied numeric; used numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SINV: an AR application is never deleted (it is reversed)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NOT (OLD."status" = 'APPLIED' AND NEW."status" = 'REVERSED'
            AND (to_jsonb(NEW) - ARRAY['status', 'reversedAt', 'reversedById', 'reverseReason']) = (to_jsonb(OLD) - ARRAY['status', 'reversedAt', 'reversedById', 'reverseReason'])) THEN
      RAISE EXCEPTION 'SINV: an AR application never changes; its only change is APPLIED to REVERSED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" <> 'APPLIED' THEN
    RAISE EXCEPTION 'SINV: an AR application is created APPLIED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Lock order: the source (receipt / credit note), then the invoice.
  IF NEW."collectionId" IS NOT NULL THEN
    SELECT c."status"::text AS status, c."customerId", c."amountGross" AS total INTO src FROM "SalesCollection" c WHERE c."id" = NEW."collectionId" FOR UPDATE;
    IF NOT FOUND OR src.status <> 'APPROVED' OR (src."customerId" IS NOT NULL AND src."customerId" <> NEW."customerId") THEN
      RAISE EXCEPTION 'SINV: a receipt is applied only once approved, to its own customer''s invoices' USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(a."amount"), 0) INTO used FROM "ArApplication" a WHERE a."collectionId" = NEW."collectionId" AND a."status" = 'APPLIED';
  ELSE
    SELECT c."status", c."kind", c."customerId", c."grandTotal" AS total INTO src FROM "SalesInvoice" c WHERE c."id" = NEW."creditNoteId" FOR UPDATE;
    IF NOT FOUND OR src.status <> 'ISSUED' OR src.kind <> 'CREDIT_NOTE' OR src."customerId" <> NEW."customerId" THEN
      RAISE EXCEPTION 'SINV: a credit is applied only from an issued credit note of the same customer' USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(a."amount"), 0) INTO used FROM "ArApplication" a WHERE a."creditNoteId" = NEW."creditNoteId" AND a."status" = 'APPLIED';
  END IF;
  IF used + NEW."amount" > src.total THEN
    RAISE EXCEPTION 'SINV: an application exceeds what the receipt or credit holds (% + % > %)', used, NEW."amount", src.total USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."status", i."kind", i."customerId", i."grandTotal" INTO inv FROM "SalesInvoice" i WHERE i."id" = NEW."invoiceId" FOR UPDATE;
  IF NOT FOUND OR inv."status" <> 'ISSUED' OR inv."kind" NOT IN ('INVOICE', 'DEBIT_NOTE') OR inv."customerId" <> NEW."customerId" THEN
    RAISE EXCEPTION 'SINV: an application names an issued invoice or debit note of the same customer' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(a."amount"), 0) INTO applied FROM "ArApplication" a WHERE a."invoiceId" = NEW."invoiceId" AND a."status" = 'APPLIED';
  IF applied + NEW."amount" > inv."grandTotal" THEN
    RAISE EXCEPTION 'SINV: an application exceeds what the invoice still owes (% + % > %)', applied, NEW."amount", inv."grandTotal" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sinv_ar_guard BEFORE INSERT OR UPDATE OR DELETE ON "ArApplication"
  FOR EACH ROW EXECUTE FUNCTION sinv_ar_guard();

CREATE OR REPLACE FUNCTION sinv_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SINV: invoices and AR applications are never truncated' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sinv_no_truncate BEFORE TRUNCATE ON "SalesInvoice" FOR EACH STATEMENT EXECUTE FUNCTION sinv_no_truncate();
CREATE TRIGGER sinv_no_truncate BEFORE TRUNCATE ON "ArApplication" FOR EACH STATEMENT EXECUTE FUNCTION sinv_no_truncate();

-- 8 · the audit trail (the A1 trigger function, unchanged).
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "SalesInvoice" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "ArApplication" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

COMMIT;
