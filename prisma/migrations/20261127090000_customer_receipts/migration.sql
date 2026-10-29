-- «سند قبض» — collection confirmation by the accountant (BATCH22 WP-D, the accounting council's design; owner answer 2 and
-- the owner's approval of 2026-10-29 for receipts against invoices with no deal). ADDITIVE, one transaction
-- (PostgreSQL 16 / 17). No table is created; no existing row changes value.
--
--   1. "SalesCollection" gains the voucher columns. A collection Sales recorded (source SALES, the default: every
--      existing row) stays what it was; the accountant confirms it with `accounting › receipts_confirm` (or the old
--      `commissions › collection_verify`). At confirmation the accountant chooses:
--        · "depositAccountId" — the cash / bank / card-clearing account the money went to (FK "Account", RESTRICT; a
--          postable, active account of controlType CASH / BANK / CLEARING — sales_collection_receipt_guard), frozen once
--          the collection is decided;
--        · "receiptMemo" — the voucher's description.
--      and the database numbers the voucher: "receiptNumber" «RCT-YYYY-NNNNNN» is taken from "AccountingCounter" (scope
--      CUSTOMER_RECEIPT, the Riyadh year of "collectedAt") in the confirming transaction, by the trigger and never by a
--      client — gapless among confirmed receipts (a rolled-back confirmation gives its number back). A rejection takes no
--      number; a reversal keeps it. Unique; never changes once given.
--      «إعادة للتصحيح» is a rejection with "decisionReasonCode" = RETURN_FOR_CORRECTION; «نسخ وتصحيح» creates a new
--      PENDING collection naming the one it replaces ("replacesCollectionId", unique: one correction per returned row).
--   2. A receipt the ACCOUNTANT records (source ACCOUNTANT) for an issued invoice whose customer has no open deal: no
--      deal ("opportunityId" becomes NULLABLE — the only relaxed column, every existing row keeps its value), no
--      commission event ever (SalesCollection_event_matches_status replaced: unchanged for SALES rows, collectionEventId
--      always NULL for ACCOUNTANT rows), the invoice named ("invoiceId", FK "SalesInvoice", RESTRICT). Four-eyes in the
--      database: an ACCOUNTANT receipt confirmed by the person who recorded it carries "sodBypass" = true (allowed only
--      when the SoD setting / SIMPLE MODE allows self-approval; listed in «استثناءات فصل المهام»), and only an
--      ACCOUNTANT receipt may carry the flag.
--   3. "SupplierPayment"."paidFromAccountId" («مدفوعة من / الحساب», FK "Account", RESTRICT): a postable, active cash or
--      bank account; posting credits it instead of the method's role account. Set when the payment is recorded, never
--      changed (supplier_payment_account_guard).
--   4. Audit: "SalesCollection" is audited row by row (ledger_audit_row → "AccountingAuditLog").
--   ── WP-B hook (qf-loc): the location columns ("SalesCollection"."branchId", "SupplierPayment"."branchId") belong to
--      20261125090000_location_dimension; this migration adds none.
--   5. The runtime role (flowcom_app), when it exists, is granted the two new functions.
-- Rollback: docs/hr/migration-review/rollback-20261127090000_customer_receipts.sql.
BEGIN;

-- 1, 2 ──────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SalesCollection" ALTER COLUMN "opportunityId" DROP NOT NULL;
ALTER TABLE "SalesCollection"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'SALES',
  ADD COLUMN "invoiceId" TEXT,
  ADD COLUMN "receiptNumber" TEXT,
  ADD COLUMN "depositAccountId" TEXT,
  ADD COLUMN "receiptMemo" TEXT,
  ADD COLUMN "decisionReasonCode" TEXT,
  ADD COLUMN "replacesCollectionId" TEXT,
  ADD COLUMN "sodBypass" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_source_check" CHECK (
  ("source" = 'SALES' AND "opportunityId" IS NOT NULL AND "invoiceId" IS NULL)
  OR ("source" = 'ACCOUNTANT' AND "opportunityId" IS NULL AND "customerId" IS NOT NULL AND "invoiceId" IS NOT NULL));

ALTER TABLE "SalesCollection" DROP CONSTRAINT "SalesCollection_event_matches_status";
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_event_matches_status" CHECK (
  ("source" = 'SALES' AND (
      ("status" IN ('APPROVED', 'REVERSED') AND "collectionEventId" IS NOT NULL)
      OR ("status" IN ('PENDING_VERIFICATION', 'REJECTED') AND "collectionEventId" IS NULL)))
  OR ("source" = 'ACCOUNTANT' AND "collectionEventId" IS NULL));

ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_receipt_number_check" CHECK (
  ("receiptNumber" IS NULL OR "receiptNumber" ~ '^RCT-[0-9]{4}-[0-9]{6}$')
  AND ("receiptNumber" IS NULL OR "status" IN ('APPROVED', 'REVERSED')));

ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_reason_code_check" CHECK (
  "decisionReasonCode" IS NULL OR ("decisionReasonCode" = 'RETURN_FOR_CORRECTION' AND "status" = 'REJECTED'));

ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_text_check" CHECK (
  ("receiptMemo" IS NULL OR length("receiptMemo") <= 500) AND ("replacesCollectionId" IS NULL OR "replacesCollectionId" <> "id"));

-- Four-eyes: only an ACCOUNTANT receipt may be confirmed by the person who recorded it, and only flagged.
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_four_eyes_check" CHECK (
  ("sodBypass" = false OR "source" = 'ACCOUNTANT')
  AND ("source" <> 'ACCOUNTANT' OR "status" NOT IN ('APPROVED', 'REVERSED') OR "decidedById" IS NULL
       OR "decidedById" <> "submittedById" OR "sodBypass" = true));

CREATE UNIQUE INDEX "SalesCollection_receiptNumber_key" ON "SalesCollection"("receiptNumber");
CREATE UNIQUE INDEX "SalesCollection_replacesCollectionId_key" ON "SalesCollection"("replacesCollectionId");
CREATE INDEX "SalesCollection_invoiceId_idx" ON "SalesCollection"("invoiceId");
CREATE INDEX "SalesCollection_depositAccountId_idx" ON "SalesCollection"("depositAccountId");
CREATE INDEX "SalesCollection_source_status_idx" ON "SalesCollection"("source", "status");

ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_depositAccountId_fkey" FOREIGN KEY ("depositAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_replacesCollectionId_fkey" FOREIGN KEY ("replacesCollectionId") REFERENCES "SalesCollection"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- The voucher number, the deposit account and the immutable voucher fields.
CREATE OR REPLACE FUNCTION sales_collection_receipt_guard() RETURNS trigger AS $$
DECLARE yr int; seq int; top int; acc record; numbering boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."source" IS DISTINCT FROM OLD."source" OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
       OR NEW."replacesCollectionId" IS DISTINCT FROM OLD."replacesCollectionId" THEN
      RAISE EXCEPTION 'RCT: a collection''s source, invoice and the collection it corrects never change' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."receiptNumber" IS NOT NULL AND NEW."receiptNumber" IS DISTINCT FROM OLD."receiptNumber" THEN
      RAISE EXCEPTION 'RCT: a receipt number never changes' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'PENDING_VERIFICATION' AND (NEW."depositAccountId" IS DISTINCT FROM OLD."depositAccountId"
       OR NEW."receiptMemo" IS DISTINCT FROM OLD."receiptMemo" OR NEW."sodBypass" IS DISTINCT FROM OLD."sodBypass") THEN
      RAISE EXCEPTION 'RCT: the deposit account, memo and SoD flag are frozen once the collection is decided' USING ERRCODE = 'check_violation';
    END IF;
    numbering := NEW."status" = 'APPROVED' AND OLD."status" = 'PENDING_VERIFICATION';
    IF NOT numbering AND OLD."receiptNumber" IS NULL AND NEW."receiptNumber" IS NOT NULL THEN
      RAISE EXCEPTION 'RCT: a receipt number is given only by the confirmation' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    numbering := NEW."status" = 'APPROVED';
    IF NOT numbering AND NEW."receiptNumber" IS NOT NULL THEN
      RAISE EXCEPTION 'RCT: a receipt number is given only by the confirmation' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."depositAccountId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."depositAccountId" IS DISTINCT FROM OLD."depositAccountId") THEN
    SELECT a."controlType", a."allowPosting", a."isActive", (SELECT count(*) FROM "Account" c WHERE c."parentId" = a."id") AS kids
      INTO acc FROM "Account" a WHERE a."id" = NEW."depositAccountId";
    IF NOT FOUND OR acc."controlType" IS NULL OR acc."controlType" NOT IN ('CASH', 'BANK', 'CLEARING') OR NOT acc."allowPosting" OR NOT acc."isActive" OR acc.kids > 0 THEN
      RAISE EXCEPTION 'RCT: the deposit account is a postable, active cash / bank / card-clearing account' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF numbering THEN
    -- The confirmation's own number: the Riyadh year of the day the money arrived, from the counter, in this
    -- transaction (gapless: a rolled-back confirmation gives the number back). Never below a number already given
    -- (a counter row reset by hand cannot hand out a duplicate).
    yr := extract(year FROM NEW."collectedAt" + interval '3 hours')::int;
    INSERT INTO "AccountingCounter" ("tenantId", "scope", "year", "value") VALUES ('hiqbah', 'CUSTOMER_RECEIPT', yr, 1)
      ON CONFLICT ("tenantId", "scope", "year") DO UPDATE SET "value" = "AccountingCounter"."value" + 1
      RETURNING "value" INTO seq;
    SELECT coalesce(max(right(c."receiptNumber", 6)::int), 0) INTO top FROM "SalesCollection" c WHERE c."receiptNumber" LIKE 'RCT-' || yr || '-%';
    IF seq <= top THEN
      seq := top + 1;
      UPDATE "AccountingCounter" SET "value" = seq WHERE "tenantId" = 'hiqbah' AND "scope" = 'CUSTOMER_RECEIPT' AND "year" = yr;
    END IF;
    NEW."receiptNumber" := 'RCT-' || yr || '-' || lpad(seq::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sales_collection_receipt_guard BEFORE INSERT OR UPDATE ON "SalesCollection" FOR EACH ROW EXECUTE FUNCTION sales_collection_receipt_guard();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "SalesCollection" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SupplierPayment" ADD COLUMN "paidFromAccountId" TEXT;
CREATE INDEX "SupplierPayment_paidFromAccountId_idx" ON "SupplierPayment"("paidFromAccountId");
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_paidFromAccountId_fkey" FOREIGN KEY ("paidFromAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION supplier_payment_account_guard() RETURNS trigger AS $$
DECLARE acc record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."paidFromAccountId" IS DISTINCT FROM OLD."paidFromAccountId" THEN
      RAISE EXCEPTION 'SPAY: the account a payment was made from never changes' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."paidFromAccountId" IS NOT NULL THEN
    SELECT a."controlType", a."allowPosting", a."isActive", (SELECT count(*) FROM "Account" c WHERE c."parentId" = a."id") AS kids
      INTO acc FROM "Account" a WHERE a."id" = NEW."paidFromAccountId";
    IF NOT FOUND OR acc."controlType" IS NULL OR acc."controlType" NOT IN ('CASH', 'BANK') OR NOT acc."allowPosting" OR NOT acc."isActive" OR acc.kids > 0 THEN
      RAISE EXCEPTION 'SPAY: a payment is made from a postable, active cash or bank account' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER supplier_payment_account_guard BEFORE INSERT OR UPDATE ON "SupplierPayment" FOR EACH ROW EXECUTE FUNCTION supplier_payment_account_guard();

-- 5 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT EXECUTE ON FUNCTION sales_collection_receipt_guard(), supplier_payment_account_guard() TO flowcom_app;
  END IF;
END $$;

COMMIT;
