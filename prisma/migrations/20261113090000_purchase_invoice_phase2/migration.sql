-- Unified inventory, phase 2 — the one-step purchase invoice («فاتورة مشتريات»). ADDITIVE ONLY, one transaction
-- (PostgreSQL 16 / 17; no enum value is added, nothing here needs to run outside a transaction block).
--
--   1. A never-posted invoice can be CANCELLED (who, when, why) instead of deleted: the one-step invoice receives stock
--      before it is approved, and a document that moved stock is never deleted; its SINV number stays issued.
--      "SupplierInvoice_lifecycle_check" WIDENED: a CANCELLED row is a posted one (postedBy / postedAt, as before) or a
--      never-posted one (postedBy, postedAt and journalEntryId all NULL). Every row it accepted, it still accepts.
--   2. ledger_ap_invoice_guard() replaced in place (same trigger): everything it refused it still refuses, and a POSTED
--      → CANCELLED transition of an invoice with a journal entry now requires that entry to be REVERSED already.
--   3. Purchase VAT categories (accounting council: chief accountant + tax + architect). The EXISTING "TaxCategory"
--      gains "appliesTo" (SALES | PURCHASES | BOTH, default BOTH: the existing rows keep their meaning),
--      "inputVatTreatment" and "vatReturnBox" (CHECKs), and seven purchase codes are seeded (deterministic ids,
--      ON CONFLICT (code) DO NOTHING): P-S15, P-S15-NR, P-Z0, P-E0, P-O, P-IMP15, P-RC15. The box numbers follow the
--      ZATCA VAT return form as generally published — CHECK THEM against zatca.gov.sa before filing. A DO block right
--      after the seed proves every code has its meaning (a code already taken with another meaning stops the migration).
--   4. "Supplier"."isNonResident" (NOT NULL DEFAULT false): the reverse charge (P-RC15) is for a non-resident supplier.
--   5. "SupplierInvoice"."customsDeclarationNo" / "customsDeclarationDate" (nullable, both or neither): import VAT paid
--      at customs (P-IMP15) is claimed on the customs declaration.
--   6. "SupplierInvoiceLine": "taxCategoryId" (FK RESTRICT, indexed), "taxSnapshot" (JSONB, written when the invoice is
--      posted — later changes to the category never change a posted line), "customsValue" (the customs value an
--      import-VAT line is computed on) and "selfAssessedVat" (the VAT of a reverse-charge line, not payable to the
--      supplier); the kind CHECK widened by 'IMPORT_VAT' (a VAT-only line on a customs / broker bill).
--   7. Back-fill: every existing line gets the purchase code of its rate (15 → P-S15, 0 → P-Z0; any other rate is left
--      NULL — verifier check 38 lists them); a line of a posted invoice also gets its snapshot (marked backfilled).
--      One DO block: drafts' lines are updated with the line guard on; only if lines of posted / cancelled invoices
--      exist is the guard (posted lines are frozen) switched off for their UPDATE and on again, inside the block. The
--      accounting audit trigger records every row it touches, attributed to this migration.
--   8. Permission purchases › received_change («إلغاء/تعديل فاتورة مستلمة»): granted (written true) to every stored
--      permission document — accounts ("Employee") and role templates ("AccessRole") — that today can cancel or edit
--      a received invoice (the draft writer — purchases › invoices or accounting › ap — who also holds inventory ›
--      receive), so nobody loses access on deploy. A document that is not valid JSON is left untouched.
--   9. (council review of 6d6d10e7) "SupplierInvoice"."origin" ('PURCHASES' | 'AP', NOT NULL DEFAULT 'AP': every
--      existing row is an accounts-payable bill; a row whose receipts name it as their source line — `SINV:<id>`, the
--      one-step invoice — is 'PURCHASES'), "receivedDate" (the day its goods were received; NULL for a bill that
--      received nothing); "Supplier"."kind" (GOODS_SERVICES default | CUSTOMS | CLEARING_AGENT: import VAT is billed
--      by customs or a clearing agent only); line kind 'LANDED_COST' with "targetPurchaseRecordId" (FK RESTRICT to the
--      receipt it is capitalised onto, of any supplier) and "landedCostType" (FREIGHT | DUTY | CLEARANCE | INSURANCE).
--  10. Guards: BEFORE DELETE ON "SupplierInvoice" refuses any row that is not a DRAFT (the application cancels
--      instead — the number stays issued); the seven P-* codes are frozen (code, rate, categoryType, appliesTo,
--      inputVatTreatment; never deleted) and "TaxCategory" joins the accounting audit (ledger_audit_row); the person
--      audit "AuthAuditLog" becomes append-only (UPDATE / DELETE / TRUNCATE refused, except on a throwaway test
--      database whose provisioning sets hiqbah.audit_purge = 'test-cleanup' — never set in production; verifier
--      check 41 proves it). The exception is never honoured for the runtime role flowcom_app (a session can SET the
--      setting itself), and the runtime role loses UPDATE / DELETE on the table altogether when it exists (the
--      application only creates and reads audit rows) — scripts/release/grant-app-runtime.sql keeps it so; check 42.
-- Every statement stands on its own (the file is also applied statement by statement, BEGIN / COMMIT stripped,
-- through one outer transaction): what needs a context or a trigger switched off is one atomic DO block.
-- Rollback: docs/hr/migration-review/rollback-20261113090000_purchase_invoice_phase2.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SupplierInvoice" DROP CONSTRAINT "SupplierInvoice_lifecycle_check";
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_lifecycle_check" CHECK (
  ("status" IN ('DRAFT', 'SUBMITTED') OR ("postedBy" IS NOT NULL AND "postedAt" IS NOT NULL)
     OR ("status" = 'CANCELLED' AND "postedBy" IS NULL AND "postedAt" IS NULL AND "journalEntryId" IS NULL))
  AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancelledBy" IS NOT NULL AND length(btrim(coalesce("cancelReason", ''))) >= 3))
  AND ("status" <> 'SUBMITTED' OR ("submittedBy" IS NOT NULL AND "submittedAt" IS NOT NULL)));

-- 1b ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SupplierInvoice" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'AP';
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_origin_check" CHECK ("origin" IN ('PURCHASES', 'AP'));
ALTER TABLE "SupplierInvoice" ADD COLUMN "receivedDate" DATE;
DO $$
BEGIN
  PERFORM set_config('hiqbah.actor_id', 'migration:20261113090000_purchase_invoice_phase2', true),
          set_config('hiqbah.audit_reason', 'origin of one-step purchase invoices (20261113090000_purchase_invoice_phase2)', true);
  UPDATE "SupplierInvoice" v SET "origin" = 'PURCHASES'
   WHERE EXISTS (SELECT 1 FROM "CostMove" m WHERE m."sourceType" = 'GRN' AND m."sourceEvent" = 'RECEIVED' AND m."lineKey" = 'SINV:' || v."id");
END $$;

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ledger_ap_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('POSTED', 'CANCELLED') THEN
    IF NEW."supplierId" <> OLD."supplierId" OR NEW."supplierRef" <> OLD."supplierRef" OR NEW."number" <> OLD."number"
       OR NEW."invoiceDate" <> OLD."invoiceDate" OR NEW."dueDate" <> OLD."dueDate" OR NEW."netTotal" <> OLD."netTotal"
       OR NEW."vatTotal" <> OLD."vatTotal" OR NEW."grossTotal" <> OLD."grossTotal" OR NEW."postedBy" IS DISTINCT FROM OLD."postedBy"
       OR NEW."postedAt" IS DISTINCT FROM OLD."postedAt" OR NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId"
       OR NEW."origin" <> OLD."origin" OR NEW."receivedDate" IS DISTINCT FROM OLD."receivedDate" THEN
      RAISE EXCEPTION 'AP_INVOICE_POSTED: a posted supplier invoice keeps its supplier, reference, dates and amounts' USING ERRCODE = 'P0001';
    END IF;
    IF OLD."status" = 'CANCELLED' AND (NEW."status" <> 'CANCELLED' OR NEW."paidTotal" <> OLD."paidTotal") THEN
      RAISE EXCEPTION 'AP_INVOICE_POSTED: a cancelled supplier invoice is final' USING ERRCODE = 'P0001';
    END IF;
    IF OLD."status" = 'POSTED' AND NEW."status" NOT IN ('POSTED', 'CANCELLED') THEN
      RAISE EXCEPTION 'AP_INVOICE_POSTED: a posted supplier invoice can only be cancelled' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."status" = 'CANCELLED' AND OLD."status" = 'POSTED' AND OLD."paidTotal" > 0 THEN
      RAISE EXCEPTION 'AP_INVOICE_PAID: a supplier invoice with payments applied is not cancelled' USING ERRCODE = 'P0001';
    END IF;
    -- Phase 2: a posted invoice is cancelled only by reversing its entry (the reversal is written first).
    IF NEW."status" = 'CANCELLED' AND OLD."status" = 'POSTED' AND OLD."journalEntryId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."id" = OLD."journalEntryId" AND j."status"::text = 'REVERSED') THEN
      RAISE EXCEPTION 'AP_INVOICE_POSTED: a posted supplier invoice is cancelled only once its entry is reversed' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Only a draft is ever deleted; anything else — submitted, posted or cancelled — keeps its row (and its number).
CREATE OR REPLACE FUNCTION ledger_ap_invoice_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'AP_INVOICE_DELETE: a % supplier invoice is never deleted (cancel it)', OLD."status" USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER ledger_ap_invoice_delete_guard BEFORE DELETE ON "SupplierInvoice" FOR EACH ROW EXECUTE FUNCTION ledger_ap_invoice_delete_guard();

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "TaxCategory" ADD COLUMN "appliesTo" TEXT NOT NULL DEFAULT 'BOTH';
ALTER TABLE "TaxCategory" ADD COLUMN "inputVatTreatment" TEXT;
ALTER TABLE "TaxCategory" ADD COLUMN "vatReturnBox" TEXT;
ALTER TABLE "TaxCategory" ADD CONSTRAINT "TaxCategory_appliesTo_check" CHECK ("appliesTo" IN ('SALES', 'PURCHASES', 'BOTH'));
ALTER TABLE "TaxCategory" ADD CONSTRAINT "TaxCategory_inputVatTreatment_check" CHECK ("inputVatTreatment" IS NULL OR "inputVatTreatment" IN ('RECOVERABLE', 'NON_RECOVERABLE', 'NONE', 'IMPORT', 'REVERSE_CHARGE'));
ALTER TABLE "TaxCategory" ADD CONSTRAINT "TaxCategory_vatReturnBox_check" CHECK ("vatReturnBox" IS NULL OR "vatReturnBox" IN ('7', '8', '9', '10', '11'));
INSERT INTO "TaxCategory" ("id", "code", "nameAr", "nameEn", "rate", "categoryType", "isDefault", "isActive", "zatcaTaxCategoryCode", "appliesTo", "inputVatTreatment", "vatReturnBox", "createdBy", "updatedBy", "updatedAt") VALUES
  ('tc_p_s15',    'P-S15',    'أساسية 15% · قابلة للاسترداد',          'Standard 15% · recoverable',              15, 'STANDARD',     false, true, 'S', 'PURCHASES', 'RECOVERABLE',     '7',  'migration', 'migration', now()),
  ('tc_p_s15_nr', 'P-S15-NR', 'أساسية 15% · غير قابلة للاسترداد',      'Standard 15% · not recoverable',          15, 'STANDARD',     false, true, 'S', 'PURCHASES', 'NON_RECOVERABLE', NULL, 'migration', 'migration', now()),
  ('tc_p_z0',     'P-Z0',     'صفرية',                               'Zero-rated',                              0,  'ZERO_RATED',   false, true, 'Z', 'PURCHASES', 'NONE',            '10', 'migration', 'migration', now()),
  ('tc_p_e0',     'P-E0',     'معفاة',                               'Exempt',                                  0,  'EXEMPT',       false, true, 'E', 'PURCHASES', 'NONE',            '11', 'migration', 'migration', now()),
  ('tc_p_o',      'P-O',      'خارج النطاق / مورد غير مسجل',          'Out of scope / supplier not registered',  0,  'OUT_OF_SCOPE', false, true, 'O', 'PURCHASES', 'NONE',            NULL, 'migration', 'migration', now()),
  ('tc_p_imp15',  'P-IMP15',  'استيراد عبر الجمارك 15%',               'Import VAT paid at customs 15%',          15, 'STANDARD',     false, true, 'S', 'PURCHASES', 'IMPORT',          '8',  'migration', 'migration', now()),
  ('tc_p_rc15',   'P-RC15',   'احتساب عكسي 15%',                      'Reverse charge 15%',                      15, 'STANDARD',     false, true, 'S', 'PURCHASES', 'REVERSE_CHARGE',  '9',  'migration', 'migration', now())
ON CONFLICT ("code") DO NOTHING;
-- The seed never skips silently: a code that existed before with another meaning stops the migration here.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(v.code, ', ') INTO bad FROM (VALUES
    ('P-S15', 15, 'STANDARD', 'RECOVERABLE', '7'), ('P-S15-NR', 15, 'STANDARD', 'NON_RECOVERABLE', NULL), ('P-Z0', 0, 'ZERO_RATED', 'NONE', '10'),
    ('P-E0', 0, 'EXEMPT', 'NONE', '11'), ('P-O', 0, 'OUT_OF_SCOPE', 'NONE', NULL), ('P-IMP15', 15, 'STANDARD', 'IMPORT', '8'),
    ('P-RC15', 15, 'STANDARD', 'REVERSE_CHARGE', '9')) v(code, rate, ctype, t, box)
   WHERE NOT EXISTS (SELECT 1 FROM "TaxCategory" c WHERE c."code" = v.code AND c."rate" = v.rate AND c."categoryType"::text = v.ctype
                       AND c."appliesTo" = 'PURCHASES' AND c."inputVatTreatment" = v.t AND c."vatReturnBox" IS NOT DISTINCT FROM v.box AND c."isActive");
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'purchase VAT codes already taken with another meaning: % — resolve before applying 20261113090000_purchase_invoice_phase2', bad;
  END IF;
END $$;
-- The P-* system codes are frozen: their code, rate, type, scope and input-VAT treatment never change and they are never
-- deleted (a posted line keeps its snapshot either way; the live code must keep its meaning for every new line). The
-- names, the active flag and the return box (should ZATCA renumber it) stay editable — and audited.
CREATE OR REPLACE FUNCTION tax_category_purchase_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."code" IN ('P-S15', 'P-S15-NR', 'P-Z0', 'P-E0', 'P-O', 'P-IMP15', 'P-RC15') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'TAX_CATEGORY_FROZEN: the purchase VAT code % is a system code and is never deleted', OLD."code" USING ERRCODE = 'P0001';
    END IF;
    IF NEW."code" <> OLD."code" OR NEW."rate" <> OLD."rate" OR NEW."categoryType" <> OLD."categoryType" OR NEW."appliesTo" <> OLD."appliesTo"
       OR NEW."inputVatTreatment" IS DISTINCT FROM OLD."inputVatTreatment" OR NEW."isDefault" THEN
      RAISE EXCEPTION 'TAX_CATEGORY_FROZEN: the purchase VAT code % keeps its code, rate, type, scope and treatment', OLD."code" USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."code" LIKE 'P-%' AND (TG_OP = 'INSERT' OR OLD."code" <> NEW."code") AND NEW."appliesTo" <> 'PURCHASES' THEN
    RAISE EXCEPTION 'TAX_CATEGORY_FROZEN: codes P-* are reserved for purchase VAT categories' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER tax_category_purchase_freeze BEFORE INSERT OR UPDATE OR DELETE ON "TaxCategory" FOR EACH ROW EXECUTE FUNCTION tax_category_purchase_freeze();
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "TaxCategory" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Supplier" ADD COLUMN "isNonResident" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Supplier" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'GOODS_SERVICES';
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_kind_check" CHECK ("kind" IN ('GOODS_SERVICES', 'CUSTOMS', 'CLEARING_AGENT'));

-- 5 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SupplierInvoice" ADD COLUMN "customsDeclarationNo" TEXT;
ALTER TABLE "SupplierInvoice" ADD COLUMN "customsDeclarationDate" DATE;
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_customs_check" CHECK (("customsDeclarationNo" IS NULL) = ("customsDeclarationDate" IS NULL) AND ("customsDeclarationNo" IS NULL OR length(btrim("customsDeclarationNo")) > 0));

-- 6 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SupplierInvoiceLine" ADD COLUMN "taxCategoryId" TEXT;
ALTER TABLE "SupplierInvoiceLine" ADD COLUMN "taxSnapshot" JSONB;
ALTER TABLE "SupplierInvoiceLine" ADD COLUMN "customsValue" DECIMAL(18,2);
ALTER TABLE "SupplierInvoiceLine" ADD COLUMN "selfAssessedVat" DECIMAL(18,2);
ALTER TABLE "SupplierInvoiceLine" ADD COLUMN "targetPurchaseRecordId" TEXT;
ALTER TABLE "SupplierInvoiceLine" ADD COLUMN "landedCostType" TEXT;
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_targetPurchaseRecordId_fkey" FOREIGN KEY ("targetPurchaseRecordId") REFERENCES "PurchaseRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "SupplierInvoiceLine_targetPurchaseRecordId_idx" ON "SupplierInvoiceLine"("targetPurchaseRecordId");
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_landed_check" CHECK (
  (("kind" = 'LANDED_COST') = ("targetPurchaseRecordId" IS NOT NULL)) AND (("kind" = 'LANDED_COST') = ("landedCostType" IS NOT NULL))
  AND ("landedCostType" IS NULL OR "landedCostType" IN ('FREIGHT', 'DUTY', 'CLEARANCE', 'INSURANCE')));
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_taxCategoryId_fkey" FOREIGN KEY ("taxCategoryId") REFERENCES "TaxCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "SupplierInvoiceLine_taxCategoryId_idx" ON "SupplierInvoiceLine"("taxCategoryId");
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_tax_amounts_check" CHECK (("customsValue" IS NULL OR "customsValue" >= 0) AND ("selfAssessedVat" IS NULL OR "selfAssessedVat" >= 0));
ALTER TABLE "SupplierInvoiceLine" DROP CONSTRAINT "SupplierInvoiceLine_kind_check";
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_kind_check" CHECK (
  ("kind" = 'GRN' AND "purchaseRecordId" IS NOT NULL AND "stockItemId" IS NULL AND "expenseCategoryId" IS NULL)
  OR ("kind" = 'STOCK' AND "stockKind" IN ('GREEN_BEAN', 'MATERIAL') AND "stockItemId" IS NOT NULL AND "purchaseRecordId" IS NULL AND "expenseCategoryId" IS NULL)
  OR ("kind" = 'EXPENSE' AND "expenseCategoryId" IS NOT NULL AND "purchaseRecordId" IS NULL AND "stockItemId" IS NULL)
  OR ("kind" = 'IMPORT_VAT' AND "customsValue" IS NOT NULL AND "purchaseRecordId" IS NULL AND "stockItemId" IS NULL AND "expenseCategoryId" IS NULL)
  OR ("kind" = 'LANDED_COST' AND "targetPurchaseRecordId" IS NOT NULL AND "purchaseRecordId" IS NULL AND "stockItemId" IS NULL AND "expenseCategoryId" IS NULL));

-- 7 ─────────────────────────────────────────────────────────────────────────────────────────────
-- One atomic block: the audit context, the back-fill, and — only when there are lines of posted / cancelled invoices,
-- which the line guard freezes — the guard switched off and on again around their UPDATE. (Production has 0 lines.)
DO $$
DECLARE frozen bigint;
BEGIN
  PERFORM set_config('hiqbah.actor_id', 'migration:20261113090000_purchase_invoice_phase2', true),
          set_config('hiqbah.audit_reason', 'purchase VAT category back-fill (20261113090000_purchase_invoice_phase2)', true);
  -- Lines of drafts / submitted invoices: the guard lets them change.
  UPDATE "SupplierInvoiceLine" l SET "taxCategoryId" = c."id"
    FROM "SupplierInvoice" v, "TaxCategory" c
   WHERE v."id" = l."invoiceId" AND v."status" NOT IN ('POSTED', 'CANCELLED') AND l."taxCategoryId" IS NULL
     AND c."code" = CASE WHEN l."vatRate" = 15 THEN 'P-S15' WHEN l."vatRate" = 0 THEN 'P-Z0' END;
  SELECT count(*) INTO frozen FROM "SupplierInvoiceLine" l JOIN "SupplierInvoice" v ON v."id" = l."invoiceId"
   WHERE v."status" IN ('POSTED', 'CANCELLED') AND l."taxCategoryId" IS NULL AND l."vatRate" IN (0, 15);
  IF frozen > 0 THEN
    EXECUTE 'ALTER TABLE "SupplierInvoiceLine" DISABLE TRIGGER ledger_ap_line_guard';
    UPDATE "SupplierInvoiceLine" l SET "taxCategoryId" = c."id",
           "taxSnapshot" = CASE WHEN v."postedAt" IS NOT NULL THEN jsonb_build_object(
             'id', c."id", 'code', c."code", 'nameEn', c."nameEn", 'nameAr', c."nameAr", 'rate', c."rate"::text, 'categoryType', c."categoryType"::text,
             'zatcaTaxCategoryCode', c."zatcaTaxCategoryCode", 'appliesTo', c."appliesTo", 'inputVatTreatment', c."inputVatTreatment",
             'vatReturnBox', c."vatReturnBox", 'snapshotAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'backfilled', true) END
      FROM "SupplierInvoice" v, "TaxCategory" c
     WHERE v."id" = l."invoiceId" AND v."status" IN ('POSTED', 'CANCELLED') AND l."taxCategoryId" IS NULL
       AND c."code" = CASE WHEN l."vatRate" = 15 THEN 'P-S15' WHEN l."vatRate" = 0 THEN 'P-Z0' END;
    EXECUTE 'ALTER TABLE "SupplierInvoiceLine" ENABLE TRIGGER ledger_ap_line_guard';
  END IF;
END $$;

-- 8 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE r record; p jsonb; can boolean;
BEGIN
  FOR r IN SELECT 'Employee' AS t, "id", "permissions" FROM "Employee" UNION ALL SELECT 'AccessRole', "id", "permissions" FROM "AccessRole" LOOP
    BEGIN
      p := r."permissions"::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;  -- not JSON: left as it is (the application reads it as no access)
    END;
    IF jsonb_typeof(p) <> 'object' THEN CONTINUE; END IF;
    can := ((coalesce(p #>> '{purchases,access}', 'none') <> 'none' AND coalesce(p #>> '{purchases,sub,invoices}', 'false') = 'true')
         OR (coalesce(p #>> '{accounting,access}', 'none') <> 'none' AND coalesce(p #>> '{accounting,sub,ap}', 'false') = 'true'))
       AND coalesce(p #>> '{inventory,access}', 'none') <> 'none' AND coalesce(p #>> '{inventory,sub,receive}', 'false') = 'true';
    IF NOT can OR coalesce(p #>> '{purchases,sub,received_change}', '') <> '' THEN CONTINUE; END IF;
    -- The key lives under «purchases»: an accounts-payable holder without the module gets it at "view" (the module
    -- itself grants nothing new — the purchases screen and its invoice pages were already theirs through accounting).
    IF coalesce(p #>> '{purchases,access}', 'none') = 'none' THEN
      p := jsonb_set(p, '{purchases}', jsonb_build_object('access', 'view', 'sub', coalesce(p #> '{purchases,sub}', '{}'::jsonb)), true);
    END IF;
    IF jsonb_typeof(p #> '{purchases,sub}') IS DISTINCT FROM 'object' THEN p := jsonb_set(p, '{purchases,sub}', '{}'::jsonb, true); END IF;
    p := jsonb_set(p, '{purchases,sub,received_change}', 'true'::jsonb, true);
    IF r.t = 'Employee' THEN UPDATE "Employee" SET "permissions" = p::text WHERE "id" = r."id";
    ELSE UPDATE "AccessRole" SET "permissions" = p::text WHERE "id" = r."id"; END IF;
  END LOOP;
END $$;

-- 9 ─────────────────────────────────────────────────────────────────────────────────────────────
-- The person audit is append-only. The one exception is a throwaway test database whose provisioning (the local
-- database tooling) sets hiqbah.audit_purge = 'test-cleanup' at the database level so the test suites can clean
-- their own fixture rows; production never sets it (verifier check 41). Any session can SET that setting, so it is
-- never honoured for the runtime role (flowcom_app), which besides holds no UPDATE / DELETE on the table (below).
CREATE OR REPLACE FUNCTION auth_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'flowcom_app' AND coalesce(current_setting('hiqbah.audit_purge', true), '') = 'test-cleanup' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD WHEN TG_OP = 'UPDATE' THEN NEW ELSE NULL END;
  END IF;
  RAISE EXCEPTION 'AUTH_AUDIT_APPEND_ONLY: the person audit log is never changed or deleted (%)', TG_OP USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER auth_audit_append_only BEFORE UPDATE OR DELETE ON "AuthAuditLog" FOR EACH ROW EXECUTE FUNCTION auth_audit_append_only();
CREATE TRIGGER auth_audit_no_truncate BEFORE TRUNCATE ON "AuthAuditLog" FOR EACH STATEMENT EXECUTE FUNCTION auth_audit_append_only();
-- The runtime role only creates and reads audit rows: it loses UPDATE / DELETE (when it exists here).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    REVOKE UPDATE, DELETE ON "AuthAuditLog" FROM flowcom_app;
  END IF;
END $$;

COMMIT;
