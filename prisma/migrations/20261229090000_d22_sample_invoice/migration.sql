-- 20261229090000_d22_sample_invoice — «إرسال عيّنة» from the tax invoice page (owner-approved design D22, 11 Nov 2026):
--   1. sinv_invoice_guard (20261103090000_sales_invoicing) is replaced with TWO changes, both at DRAFT → ISSUED:
--      a. the totals check refused every document whose grandTotal <= 0; a free sample's tax invoice — kind INVOICE,
--         channel 'SAMPLE' (the 100 % discount) whose externalOrderRef names an existing "SampleShipment" that is not
--         CANCELLED and needs no manager's approval or has it — may now total EXACTLY zero. A negative total, a note, any
--         other channel, or a SAMPLE document naming no such sample is refused as before;
--      b. any SAMPLE invoice (at any total) issues only while the sample it names is such a sample (gate R2-L1, أبو فهد B1:
--         no tax invoice for a supply that is cancelled or still waiting for the manager).
--      The rest of the function is byte-for-byte the 20261103090000 body (numbering, immutability, particulars, E-10, notes).
--   2. "SystemConfig"."salesSampleVatAlertSar": «حد تنبيه ضريبة العيّنات» — the list value of one customer's free samples in a
--      calendar year above which a holder of sales › samples_vat_alert sees the deemed-supply alert. NULL = the built-in
--      200 SAR. CHECK 0 – 1,000,000. An alert only: no tax is computed or posted from it.
-- Additive: one nullable column, one CHECK, one function body. No row is read or written. The runtime role holds
-- table-level rights on "SystemConfig" (column-level grants, if ever used there, get the new column — the guarded grant
-- below) and runs the trigger as the table owner's function (no EXECUTE grant needed for a trigger function).
-- Rollback: docs/hr/migration-review/rollback-20261229090000_d22_sample_invoice.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1 ───────────────────────────────────────────────────────────────────────────────────────────────
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
     OR NEW."grandTotal" <> t.net + t.vat
     -- D22: a free sample's tax invoice (kind INVOICE, channel SAMPLE, naming an existing SampleShipment that is not
     -- CANCELLED — gate R2-L1 — and needs no manager's approval or has it — أبو فهد B1) may total exactly zero; nothing else may.
     OR (NEW."grandTotal" <= 0 AND NOT (NEW."kind" = 'INVOICE' AND coalesce(NEW."channel", '') = 'SAMPLE' AND NEW."grandTotal" = 0
         AND EXISTS (SELECT 1 FROM "SampleShipment" s WHERE s."id" = NEW."externalOrderRef" AND s."status" <> 'CANCELLED'
                       AND (s."approvalRequired" = false OR s."approvedAt" IS NOT NULL)))) THEN
    RAISE EXCEPTION 'SINV: the document totals follow its lines (taxable %, VAT per category on the total %, payable %)', t.net, t.vat, t.net + t.vat USING ERRCODE = 'check_violation';
  END IF;
  -- D22 (أبو فهد B1): any sample's invoice (channel SAMPLE, at any total) issues only for a supply that will happen — the
  -- sample it names exists, is not CANCELLED, and needs no manager's approval or has it.
  IF NEW."kind" = 'INVOICE' AND coalesce(NEW."channel", '') = 'SAMPLE'
     AND NOT EXISTS (SELECT 1 FROM "SampleShipment" s WHERE s."id" = NEW."externalOrderRef" AND s."status" <> 'CANCELLED'
                       AND (s."approvalRequired" = false OR s."approvedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'SINV: a sample''s invoice issues only for a sample that is not cancelled and not waiting for the manager''s approval' USING ERRCODE = 'check_violation';
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

-- 2 ───────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SystemConfig" ADD COLUMN IF NOT EXISTS "salesSampleVatAlertSar" DECIMAL(12,2);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SystemConfig_sample_vat_alert_check') THEN
    ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_sample_vat_alert_check"
      CHECK ("salesSampleVatAlertSar" IS NULL OR ("salesSampleVatAlertSar" >= 0 AND "salesSampleVatAlertSar" <= 1000000));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_name = 'SystemConfig' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE')
       AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_name = 'SystemConfig' AND grantee = 'flowcom_app' AND privilege_type = 'UPDATE') THEN
      GRANT SELECT ("salesSampleVatAlertSar"), UPDATE ("salesSampleVatAlertSar") ON "SystemConfig" TO flowcom_app;
    END IF;
  END IF;
END $$;

COMMIT;
