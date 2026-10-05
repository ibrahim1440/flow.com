-- CreateEnum
CREATE TYPE "AdvanceVatTreatment" AS ENUM ('AT_RECEIPT', 'NOT_AT_RECEIPT');

-- CreateEnum
CREATE TYPE "SalesDocKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "SalesInvoiceStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "AdvanceApplicationStatus" AS ENUM ('POSTED', 'REVERSED');

-- AlterTable
ALTER TABLE "AccountingSettings" ADD COLUMN     "advanceVatTreatment" "AdvanceVatTreatment";

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "crNumber" TEXT,
ADD COLUMN     "creditLimit" DECIMAL(18,2),
ADD COLUMN     "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "vatNumber" TEXT;

-- CreateTable
CREATE TABLE "SalesInvoice" (
    "id" TEXT NOT NULL,
    "invoiceNo" SERIAL NOT NULL,
    "kind" "SalesDocKind" NOT NULL DEFAULT 'INVOICE',
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "originalInvoiceId" TEXT,
    "issueDate" DATE NOT NULL,
    "supplyDate" DATE,
    "dueDate" DATE NOT NULL,
    "branchId" TEXT,
    "description" TEXT,
    "reason" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "status" "SalesInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "totalNet" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalVat" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalGross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "postedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "reversedBy" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,

    CONSTRAINT "SalesInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productSkuId" TEXT,
    "orderItemId" TEXT,
    "accountId" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(18,2) NOT NULL,
    "taxCategoryId" TEXT,
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "vat" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "gross" DECIMAL(18,2) NOT NULL,
    "costCenterId" TEXT,

    CONSTRAINT "SalesInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerReceipt" (
    "id" TEXT NOT NULL,
    "receiptNo" SERIAL NOT NULL,
    "bankTransactionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "salesCollectionId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "arAmount" DECIMAL(18,2) NOT NULL,
    "advanceAmount" DECIMAL(18,2) NOT NULL,
    "advanceVat" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArAllocation" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "receiptId" TEXT,
    "creditNoteId" TEXT,
    "applicationId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "allocatedOn" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "removedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvanceApplication" (
    "id" TEXT NOT NULL,
    "applicationNo" SERIAL NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "vatPortion" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "appliedOn" DATE NOT NULL,
    "status" "AdvanceApplicationStatus" NOT NULL DEFAULT 'POSTED',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedBy" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,

    CONSTRAINT "AdvanceApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesInvoice_invoiceNo_key" ON "SalesInvoice"("invoiceNo");

-- CreateIndex
CREATE INDEX "SalesInvoice_status_idx" ON "SalesInvoice"("status");

-- CreateIndex
CREATE INDEX "SalesInvoice_customerId_issueDate_idx" ON "SalesInvoice"("customerId", "issueDate");

-- CreateIndex
CREATE INDEX "SalesInvoice_orderId_idx" ON "SalesInvoice"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesInvoiceLine_invoiceId_lineNo_key" ON "SalesInvoiceLine"("invoiceId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerReceipt_receiptNo_key" ON "CustomerReceipt"("receiptNo");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerReceipt_bankTransactionId_key" ON "CustomerReceipt"("bankTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerReceipt_salesCollectionId_key" ON "CustomerReceipt"("salesCollectionId");

-- CreateIndex
CREATE INDEX "CustomerReceipt_customerId_idx" ON "CustomerReceipt"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ArAllocation_applicationId_key" ON "ArAllocation"("applicationId");

-- CreateIndex
CREATE INDEX "ArAllocation_invoiceId_idx" ON "ArAllocation"("invoiceId");

-- CreateIndex
CREATE INDEX "ArAllocation_receiptId_idx" ON "ArAllocation"("receiptId");

-- CreateIndex
CREATE INDEX "ArAllocation_creditNoteId_idx" ON "ArAllocation"("creditNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceApplication_applicationNo_key" ON "AdvanceApplication"("applicationNo");

-- CreateIndex
CREATE INDEX "AdvanceApplication_customerId_idx" ON "AdvanceApplication"("customerId");

-- AddForeignKey
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_originalInvoiceId_fkey" FOREIGN KEY ("originalInvoiceId") REFERENCES "SalesInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerReceipt" ADD CONSTRAINT "CustomerReceipt_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArAllocation" ADD CONSTRAINT "ArAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArAllocation" ADD CONSTRAINT "ArAllocation_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "CustomerReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArAllocation" ADD CONSTRAINT "ArAllocation_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "SalesInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArAllocation" ADD CONSTRAINT "ArAllocation_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "AdvanceApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceApplication" ADD CONSTRAINT "AdvanceApplication_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceApplication" ADD CONSTRAINT "AdvanceApplication_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Receivables (stage 3) database controls. Same shape as the supplier bill guards.
-- ─────────────────────────────────────────────────────────────────────────────

-- One live invoice per order (a reversed one frees the order for a corrected invoice).
CREATE UNIQUE INDEX "SalesInvoice_one_live_invoice_per_order" ON "SalesInvoice"("orderId")
  WHERE "kind" = 'INVOICE' AND "status" <> 'REVERSED' AND "orderId" IS NOT NULL;

CREATE OR REPLACE FUNCTION acc_guard_sales_invoice() RETURNS trigger AS $$
DECLARE
  n int; s_net numeric; s_vat numeric; s_gross numeric; o record; credited numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only a draft sales document can be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."kind" = 'CREDIT_NOTE') <> (NEW."originalInvoiceId" IS NOT NULL) THEN
    RAISE EXCEPTION 'A credit note names the invoice it credits; an invoice names none' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'A sales document starts as a draft' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('POSTED', 'REVERSED') THEN
    IF OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED'
       AND NEW."reversedBy" IS NOT NULL AND NEW."reversedAt" IS NOT NULL AND length(coalesce(NEW."reversalReason", '')) >= 5
       AND (NEW."kind", NEW."customerId", NEW."orderId", NEW."originalInvoiceId", NEW."issueDate", NEW."dueDate", NEW."totalNet", NEW."totalVat", NEW."totalGross",
            NEW."approvedBy", NEW."postedBy", NEW."postedAt", NEW."createdBy")
           IS NOT DISTINCT FROM
           (OLD."kind", OLD."customerId", OLD."orderId", OLD."originalInvoiceId", OLD."issueDate", OLD."dueDate", OLD."totalNet", OLD."totalVat", OLD."totalGross",
            OLD."approvedBy", OLD."postedBy", OLD."postedAt", OLD."createdBy") THEN
      IF EXISTS (SELECT 1 FROM "ArAllocation" WHERE ("invoiceId" = NEW."id" OR "creditNoteId" = NEW."id") AND "active") THEN
        RAISE EXCEPTION 'Receipts, credits or advances are allocated to this document; release them before reversing it' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "SalesInvoice" WHERE "originalInvoiceId" = NEW."id" AND "status" IN ('SUBMITTED', 'APPROVED', 'POSTED')) THEN
        RAISE EXCEPTION 'A credit note exists for this invoice; reverse it first' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A posted sales document cannot be changed; reverse it or issue a credit note' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" = 'SUBMITTED') OR
       (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('DRAFT', 'APPROVED')) OR
       (OLD."status" = 'APPROVED' AND NEW."status" = 'POSTED')) THEN
    RAISE EXCEPTION 'Sales document cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (NEW."kind", NEW."customerId", NEW."orderId", NEW."originalInvoiceId", NEW."issueDate", NEW."dueDate", NEW."totalNet", NEW."totalVat", NEW."totalGross", NEW."createdBy")
       IS DISTINCT FROM (OLD."kind", OLD."customerId", OLD."orderId", OLD."originalInvoiceId", OLD."issueDate", OLD."dueDate", OLD."totalNet", OLD."totalVat", OLD."totalGross", OLD."createdBy") THEN
    RAISE EXCEPTION 'A submitted sales document cannot be edited; reject it back to draft first' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'APPROVED' AND (NEW."approvedBy" IS NULL OR NEW."approvedBy" = NEW."createdBy" OR NEW."approvedBy" = NEW."submittedBy") THEN
    RAISE EXCEPTION 'A sales document must be approved by someone other than the person who prepared or submitted it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IN ('SUBMITTED', 'APPROVED', 'POSTED') THEN
    SELECT count(*), coalesce(sum("net"), 0), coalesce(sum("vat"), 0), coalesce(sum("gross"), 0)
      INTO n, s_net, s_vat, s_gross FROM "SalesInvoiceLine" WHERE "invoiceId" = NEW."id";
    IF n = 0 OR NEW."totalGross" <= 0 OR s_net <> NEW."totalNet" OR s_vat <> NEW."totalVat" OR s_gross <> NEW."totalGross"
       OR NEW."totalNet" + NEW."totalVat" <> NEW."totalGross" THEN
      RAISE EXCEPTION 'Sales document totals do not equal its lines' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW."status" = 'POSTED' THEN
    IF NEW."postedBy" IS NULL OR NEW."postedAt" IS NULL THEN
      RAISE EXCEPTION 'A posted sales document records who posted it and when' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."kind" = 'CREDIT_NOTE' THEN
      SELECT "kind", "status", "customerId", "totalGross" INTO o FROM "SalesInvoice" WHERE "id" = NEW."originalInvoiceId" FOR UPDATE;
      IF o."kind" <> 'INVOICE' OR o."status" <> 'POSTED' OR o."customerId" <> NEW."customerId" THEN
        RAISE EXCEPTION 'A credit note credits a posted invoice of the same customer' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT coalesce(sum("totalGross"), 0) INTO credited FROM "SalesInvoice"
        WHERE "originalInvoiceId" = NEW."originalInvoiceId" AND "status" = 'POSTED' AND "id" <> NEW."id";
      IF credited + NEW."totalGross" > o."totalGross" THEN
        RAISE EXCEPTION 'Credit notes cannot exceed the invoice they credit (% already credited of %)', credited, o."totalGross" USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SalesInvoice_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SalesInvoice"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_sales_invoice();

CREATE OR REPLACE FUNCTION acc_guard_sales_invoice_line() RETURNS trigger AS $$
DECLARE st "SalesInvoiceStatus";
BEGIN
  SELECT "status" INTO st FROM "SalesInvoice" WHERE "id" = COALESCE(NEW."invoiceId", OLD."invoiceId");
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of a submitted or posted sales document cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."net" + NEW."vat" <> NEW."gross" OR NEW."net" < 0 OR NEW."vat" < 0 THEN
    RAISE EXCEPTION 'Sales line: net + VAT must equal gross, and neither may be negative' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SalesInvoiceLine_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SalesInvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_sales_invoice_line();

-- Outbox: posting or reversing an invoice / credit note is exactly one event (per customer order).
CREATE OR REPLACE FUNCTION acc_emit_sales_invoice_event() RETURNS trigger AS $$
DECLARE et text; at timestamp; k text := CASE WHEN NEW."kind" = 'CREDIT_NOTE' THEN 'credit_note' ELSE 'invoice' END;
BEGIN
  IF NEW."status" = 'POSTED' AND OLD."status" <> 'POSTED' THEN et := 'ar.' || k || '.posted'; at := NEW."issueDate"::timestamp;
  ELSIF NEW."status" = 'REVERSED' AND OLD."status" <> 'REVERSED' THEN et := 'ar.' || k || '.reversed'; at := NEW."reversedAt";
  ELSE RETURN NULL;
  END IF;
  INSERT INTO "AccountingEvent" ("id", "eventType", "sourceModule", "sourceDocumentId", "sourceEventId",
    "idempotencyKey", "occurredAt", "payload", "status", "partyKey", "createdAt", "updatedAt")
  VALUES ('ae_' || replace(gen_random_uuid()::text, '-', ''), et, 'receivables', NEW."id", NEW."id" || ':' || et,
    'receivables:' || NEW."id" || ':' || et, at,
    jsonb_build_object('invoiceId', NEW."id", 'invoiceNo', NEW."invoiceNo", 'customerId', NEW."customerId", 'totalGross', NEW."totalGross"::text),
    'PENDING', 'CUSTOMER:' || NEW."customerId", now(), now())
  ON CONFLICT ("idempotencyKey") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SalesInvoice_accounting_outbox" AFTER UPDATE OF "status" ON "SalesInvoice"
  FOR EACH ROW EXECUTE FUNCTION acc_emit_sales_invoice_event();

-- Customer receipts: the split between receivables and advances is fixed once the bank line posts.
CREATE OR REPLACE FUNCTION acc_guard_customer_receipt() RETURNS trigger AS $$
DECLARE t text := COALESCE(NEW."bankTransactionId", OLD."bankTransactionId");
BEGIN
  PERFORM 1 FROM "BankTransaction" WHERE "id" = t FOR UPDATE;
  IF TG_OP <> 'DELETE' AND (NEW."arAmount" + NEW."advanceAmount" <> NEW."amount" OR abs(NEW."advanceVat") > abs(NEW."advanceAmount")
       OR sign(NEW."arAmount") * sign(NEW."amount") < 0 OR sign(NEW."advanceAmount") * sign(NEW."amount") < 0) THEN
    RAISE EXCEPTION 'Customer receipt: receivables part + advance part must equal the amount, with the same sign' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF acc_bank_txn_posted(t) THEN
    IF TG_OP = 'UPDATE' AND NOT OLD."voided" AND NEW."voided"
       AND (NEW."customerId", NEW."amount", NEW."arAmount", NEW."advanceAmount", NEW."advanceVat", NEW."bankTransactionId")
           IS NOT DISTINCT FROM (OLD."customerId", OLD."amount", OLD."arAmount", OLD."advanceAmount", OLD."advanceVat", OLD."bankTransactionId")
       AND EXISTS (SELECT 1 FROM "BankTransaction" WHERE "id" = t AND "status" = 'VOID') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'The bank line of this customer receipt has posted; correct it through Accounting → Bank corrections' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CustomerReceipt_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CustomerReceipt"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_customer_receipt();

-- Allocations: never deleted; only switched off (once). Amount positive; invoice is a posted
-- INVOICE of the same customer as its source; never more than the invoice is owed.
CREATE OR REPLACE FUNCTION acc_guard_ar_allocation() RETURNS trigger AS $$
DECLARE inv record; src_customer text; used numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Allocations are part of the audit trail; switch them off instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."active" AND NOT NEW."active" AND NEW."removedAt" IS NOT NULL
       AND (NEW."invoiceId", NEW."receiptId", NEW."creditNoteId", NEW."applicationId", NEW."amount", NEW."allocatedOn")
           IS NOT DISTINCT FROM (OLD."invoiceId", OLD."receiptId", OLD."creditNoteId", OLD."applicationId", OLD."amount", OLD."allocatedOn") THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'An allocation cannot be edited; switch it off and allocate again' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF ((NEW."receiptId" IS NOT NULL)::int + (NEW."creditNoteId" IS NOT NULL)::int + (NEW."applicationId" IS NOT NULL)::int) <> 1 OR NEW."amount" <= 0 THEN
    RAISE EXCEPTION 'An allocation has exactly one source and a positive amount' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT "kind", "status", "customerId", "totalGross" INTO inv FROM "SalesInvoice" WHERE "id" = NEW."invoiceId" FOR UPDATE;
  IF inv."kind" <> 'INVOICE' OR inv."status" <> 'POSTED' THEN
    RAISE EXCEPTION 'Only a posted invoice can receive an allocation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."receiptId" IS NOT NULL THEN SELECT "customerId" INTO src_customer FROM "CustomerReceipt" WHERE "id" = NEW."receiptId";
  ELSIF NEW."creditNoteId" IS NOT NULL THEN SELECT "customerId" INTO src_customer FROM "SalesInvoice" WHERE "id" = NEW."creditNoteId" AND "kind" = 'CREDIT_NOTE' AND "status" = 'POSTED';
  ELSE SELECT "customerId" INTO src_customer FROM "AdvanceApplication" WHERE "id" = NEW."applicationId" AND "status" = 'POSTED';
  END IF;
  IF src_customer IS NULL OR src_customer <> inv."customerId" THEN
    RAISE EXCEPTION 'An allocation joins documents of the same customer (and a posted source)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT coalesce(sum("amount"), 0) INTO used FROM "ArAllocation" WHERE "invoiceId" = NEW."invoiceId" AND "active";
  IF used + NEW."amount" > inv."totalGross" THEN
    RAISE EXCEPTION 'The invoice is owed only % more', inv."totalGross" - used USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ArAllocation_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ArAllocation"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_ar_allocation();

-- Advance applications: immutable except POSTED → REVERSED; each is one posting event.
CREATE OR REPLACE FUNCTION acc_guard_advance_application() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Advance applications are part of the audit trail and cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'POSTED' OR NEW."amount" <= 0 OR NEW."vatPortion" < 0 OR NEW."vatPortion" > NEW."amount" THEN
      RAISE EXCEPTION 'An advance application is posted with a positive amount' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED' AND NEW."reversedBy" IS NOT NULL AND NEW."reversedAt" IS NOT NULL
     AND length(coalesce(NEW."reversalReason", '')) >= 5
     AND (NEW."customerId", NEW."invoiceId", NEW."amount", NEW."vatPortion", NEW."appliedOn", NEW."createdBy")
         IS NOT DISTINCT FROM (OLD."customerId", OLD."invoiceId", OLD."amount", OLD."vatPortion", OLD."appliedOn", OLD."createdBy") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An advance application cannot be changed; reverse it instead' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AdvanceApplication_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AdvanceApplication"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_advance_application();

CREATE OR REPLACE FUNCTION acc_emit_advance_application_event() RETURNS trigger AS $$
DECLARE et text; at timestamp;
BEGIN
  IF TG_OP = 'INSERT' THEN et := 'ar.advance.applied'; at := NEW."appliedOn"::timestamp;
  ELSIF NEW."status" = 'REVERSED' AND OLD."status" <> 'REVERSED' THEN et := 'ar.advance.reversed'; at := NEW."reversedAt";
  ELSE RETURN NULL;
  END IF;
  INSERT INTO "AccountingEvent" ("id", "eventType", "sourceModule", "sourceDocumentId", "sourceEventId",
    "idempotencyKey", "occurredAt", "payload", "status", "partyKey", "createdAt", "updatedAt")
  VALUES ('ae_' || replace(gen_random_uuid()::text, '-', ''), et, 'receivables', NEW."id", NEW."id" || ':' || et,
    'receivables:' || NEW."id" || ':' || et, at,
    jsonb_build_object('applicationId', NEW."id", 'customerId', NEW."customerId", 'amount', NEW."amount"::text),
    'PENDING', 'CUSTOMER:' || NEW."customerId", now(), now())
  ON CONFLICT ("idempotencyKey") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AdvanceApplication_accounting_outbox" AFTER INSERT OR UPDATE OF "status" ON "AdvanceApplication"
  FOR EACH ROW EXECUTE FUNCTION acc_emit_advance_application_event();
