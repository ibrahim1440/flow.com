-- BATCH22 release-gate fixes (BATCH22-GATE.md S2, S6) — ONE transaction, additive (PostgreSQL 16 / 17). Migrations A–K
-- (20261124 … 20261202) are untouched.
--
-- S6 · sales_collection_receipt_guard() replaced in place: a receipt's deposit account is a postable, active leaf CASH /
--      BANK account, or the CLEARING account MAPPED to the CARD_CLEARING role — never another clearing account (e.g.
--      FA_DISPOSAL_CLEARING 2195, a liability). Everything else in the function is 20261127090000_customer_receipts'.
--      Only a NEW deposit account is checked (as before), so no stored row is re-validated.
-- S2 · "FinAttachment": the evidence of a supplier invoice is kept once relied on. fin_attachment_evidence_guard refuses a
--      DELETE (P0001 AP_EVIDENCE_KEPT) of an attachment of a SupplierInvoice that is POSTED or CANCELLED, or of a SIMPLE
--      invoice ever posted ("postedAt" set); fin_attachment_no_truncate refuses TRUNCATE. No ledger_audit_row here (it
--      would copy the bytes into the audit log): the application writes a metadata-only ATTACHMENT_DELETED row.
-- Grants: EXECUTE on the functions to flowcom_app, when it exists. Verifier check 71.
-- Rollback: docs/hr/migration-review/rollback-20261203090000_b22_gate_fixes.sql.
BEGIN;

-- 1 (S6) ──────────────────────────────────────────────────────────────────────────────────────────
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
    -- BATCH22 gate S6: a clearing account only when it is the one mapped to CARD_CLEARING (never FA_DISPOSAL_CLEARING).
    IF NOT FOUND OR acc."controlType" IS NULL OR acc."controlType" NOT IN ('CASH', 'BANK', 'CLEARING') OR NOT acc."allowPosting" OR NOT acc."isActive" OR acc.kids > 0
       OR (acc."controlType" = 'CLEARING' AND NOT EXISTS (SELECT 1 FROM "AccountRole" r WHERE r."accountId" = NEW."depositAccountId" AND r."role" = 'CARD_CLEARING')) THEN
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

-- 2 (S2) ──────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fin_attachment_evidence_guard() RETURNS trigger AS $$
DECLARE inv record;
BEGIN
  IF OLD."entityType" = 'SUPPLIER_INVOICE' THEN
    SELECT i."status", i."kind", i."postedAt" INTO inv FROM "SupplierInvoice" i WHERE i."id" = OLD."entityId";
    IF FOUND AND (inv."status" IN ('POSTED', 'CANCELLED') OR (inv."kind" = 'SIMPLE' AND inv."postedAt" IS NOT NULL)) THEN
      RAISE EXCEPTION 'AP_EVIDENCE_KEPT: the attachment of a posted or cancelled supplier invoice (or of a simple invoice once posted) is its evidence and is never deleted' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fin_attachment_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AP_EVIDENCE_KEPT: % holds evidence and is never truncated', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fin_attachment_evidence_guard BEFORE DELETE ON "FinAttachment" FOR EACH ROW EXECUTE FUNCTION fin_attachment_evidence_guard();
CREATE TRIGGER fin_attachment_no_truncate BEFORE TRUNCATE ON "FinAttachment" FOR EACH STATEMENT EXECUTE FUNCTION fin_attachment_no_truncate();

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT EXECUTE ON FUNCTION sales_collection_receipt_guard(), fin_attachment_evidence_guard(), fin_attachment_no_truncate() TO flowcom_app;
  END IF;
END $$;

COMMIT;
