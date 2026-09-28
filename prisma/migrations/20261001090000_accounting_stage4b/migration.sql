-- Stage 4b (2026-10-01): cost-of-sales status and retries, operational stock integration,
-- conversion-cost pools, customer returns separate from invoice corrections, supplier credit notes,
-- traced cost adjustments. No backfill: no environment with accounting inventory data exists
-- outside disposable test databases.
-- CreateEnum
CREATE TYPE "SupplierDocKind" AS ENUM ('BILL', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "SalesLineStock" AS ENUM ('GOODS', 'NON_STOCK');

-- CreateEnum
CREATE TYPE "SalesCreditType" AS ENUM ('RETURN_OF_GOODS', 'PRICE_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "InvCostingStatus" AS ENUM ('PENDING', 'AWAITING_POLICY', 'AWAITING_DISPATCH', 'COSTED', 'NOT_REQUIRED', 'BLOCKED', 'FAILED', 'CANCELLED', 'UNCOSTED');

-- CreateEnum
CREATE TYPE "InvOpsStatus" AS ENUM ('PENDING', 'PROCESSING', 'POSTED', 'HELD', 'BLOCKED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "InvCostPoolKind" AS ENUM ('DIRECT_LABOUR', 'PRODUCTION_OVERHEAD');

-- CreateEnum
CREATE TYPE "InvCostBasis" AS ENUM ('PER_KG_INPUT', 'PER_KG_OUTPUT', 'PER_UNIT_OUTPUT', 'PER_BATCH', 'PER_LABOUR_HOUR', 'PER_MACHINE_HOUR');

-- CreateEnum
CREATE TYPE "CustomerReturnStatus" AS ENUM ('DRAFT', 'RECEIVED', 'APPROVED', 'POSTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BillLineKind" ADD VALUE 'STOCK_RETURN';
ALTER TYPE "BillLineKind" ADD VALUE 'STOCK_PRICE_ADJUSTMENT';

-- AlterEnum
ALTER TYPE "InvDocType" ADD VALUE 'SUPPLIER_CREDIT';
ALTER TYPE "InvDocType" ADD VALUE 'SALE_REVERSAL';

-- AlterTable
ALTER TABLE "AccountingSettings" ADD COLUMN     "salesCostTiming" TEXT;

-- AlterTable
ALTER TABLE "InvDocLine" ADD COLUMN     "lotId" TEXT,
ADD COLUMN     "orderItemId" TEXT,
ADD COLUMN     "salesInvoiceLineId" TEXT;

-- AlterTable
ALTER TABLE "InvDocument" ADD COLUMN     "labourHours" DECIMAL(10,2),
ADD COLUMN     "lateReason" TEXT,
ADD COLUMN     "machineHours" DECIMAL(10,2),
ADD COLUMN     "originalDate" DATE,
ADD COLUMN     "process" TEXT,
ADD COLUMN     "salesInvoiceId" TEXT;

-- AlterTable
ALTER TABLE "InvLocation" ADD COLUMN     "accountRole" TEXT,
ADD COLUMN     "isDelivered" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "InvMove" ADD COLUMN     "poolId" TEXT,
ADD COLUMN     "role" TEXT,
ADD COLUMN     "traceDocumentId" TEXT;

-- AlterTable
ALTER TABLE "SalesInvoice" ADD COLUMN     "creditType" "SalesCreditType",
ADD COLUMN     "customerReturnId" TEXT,
ADD COLUMN     "fulfilmentLocationId" TEXT,
ADD COLUMN     "replacesInvoiceId" TEXT;

-- AlterTable
ALTER TABLE "SalesInvoiceLine" ADD COLUMN     "invItemId" TEXT,
ADD COLUMN     "stockTreatment" "SalesLineStock",
ADD COLUMN     "unit" TEXT;

-- AlterTable
ALTER TABLE "SupplierBill" ADD COLUMN     "kind" "SupplierDocKind" NOT NULL DEFAULT 'BILL',
ADD COLUMN     "originalBillId" TEXT,
ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "SupplierBillLine" ADD COLUMN     "invDocLineId" TEXT,
ADD COLUMN     "invDocumentId" TEXT;

-- CreateTable
CREATE TABLE "InvCosting" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "status" "InvCostingStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "costedAt" TIMESTAMP(3),
    "cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvCosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvOpsEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "occurredOn" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "userId" TEXT,
    "txid" BIGINT,
    "status" "InvOpsStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "documentId" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvOpsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvCostPool" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "kind" "InvCostPoolKind" NOT NULL,
    "process" TEXT NOT NULL,
    "basis" "InvCostBasis" NOT NULL,
    "budgetAmount" DECIMAL(18,2) NOT NULL,
    "normalCapacity" DECIMAL(18,4) NOT NULL,
    "rate" DECIMAL(18,4) NOT NULL,
    "expenseAccountId" TEXT NOT NULL,
    "status" "InvLossBandStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvCostPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerReturn" (
    "id" TEXT NOT NULL,
    "returnNo" SERIAL NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "CustomerReturnStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBy" TEXT,
    "receivedAt" TIMESTAMP(3),
    "receivedOn" DATE,
    "evidenceRef" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "postedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "documentId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerReturnLine" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "invoiceLineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "condition" TEXT NOT NULL DEFAULT 'RESALABLE',

    CONSTRAINT "CustomerReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvCosting_invoiceId_key" ON "InvCosting"("invoiceId");

-- CreateIndex
CREATE INDEX "InvCosting_status_nextAttemptAt_idx" ON "InvCosting"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "InvOpsEvent_status_nextAttemptAt_idx" ON "InvOpsEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "InvOpsEvent_txid_idx" ON "InvOpsEvent"("txid");

-- CreateIndex
CREATE UNIQUE INDEX "InvOpsEvent_kind_sourceId_seq_key" ON "InvOpsEvent"("kind", "sourceId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "InvCostPool_code_key" ON "InvCostPool"("code");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerReturn_returnNo_key" ON "CustomerReturn"("returnNo");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerReturnLine_returnId_invoiceLineId_condition_key" ON "CustomerReturnLine"("returnId", "invoiceLineId", "condition");

-- AddForeignKey
ALTER TABLE "CustomerReturnLine" ADD CONSTRAINT "CustomerReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "CustomerReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Hand-written controls ─────────────────────────────────────────────────────────────

-- Supplier credit notes are AP open items of their own.
ALTER TABLE "JournalEntryLine" DROP CONSTRAINT "JournalEntryLine_open_item_check";
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_open_item_check" CHECK (
  ("openItemType" IS NULL) = ("openItemId" IS NULL)
  AND ("openItemType" IS NULL OR "openItemType" IN ('SUPPLIER_BILL', 'SALES_INVOICE', 'CREDIT_NOTE', 'SUPPLIER_CREDIT')));

-- One "delivered, not invoiced" location; one approved pool per kind and process.
CREATE UNIQUE INDEX "InvLocation_one_delivered" ON "InvLocation" ("isDelivered") WHERE "isDelivered";
CREATE UNIQUE INDEX "InvCostPool_one_approved" ON "InvCostPool" ("kind", "process") WHERE "status" = 'APPROVED';
CREATE UNIQUE INDEX "InvDocument_one_customer_return" ON "InvDocument" ("sourceId") WHERE "sourceType" = 'CUSTOMER_RETURN';
-- A customer return is credited by at most one live credit note.
CREATE UNIQUE INDEX "SalesInvoice_one_credit_per_return" ON "SalesInvoice" ("customerReturnId")
  WHERE "customerReturnId" IS NOT NULL AND "status" IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED');

-- Inventory documents: as before, plus one narrow allowance. A system document (cost of sales,
-- operations) that cannot be dated when it happened, because later movements already posted for
-- the same item and location, is booked on the posting day; the day it happened is kept in
-- originalDate with the reason. Nothing else about a submitted document can change.
CREATE OR REPLACE FUNCTION acc_guard_inv_document() RETURNS trigger AS $$
DECLARE wf text[] := ARRAY['status', 'submittedBy', 'submittedAt', 'approvedBy', 'approvedAt', 'postedBy', 'postedAt',
  'rejectedBy', 'rejectedAt', 'rejectedReason', 'movesSealed', 'updatedAt', 'lossBandPercent', 'costMethod', 'priceDifference', 'provisional'];
  late boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'Only a draft inventory document can be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."movesSealed" THEN RAISE EXCEPTION 'An inventory document starts as a draft' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'POSTED' THEN
    IF (to_jsonb(NEW) - 'movesSealed' - 'updatedAt') = (to_jsonb(OLD) - 'movesSealed' - 'updatedAt') AND (NEW."movesSealed" OR NOT OLD."movesSealed") THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A posted inventory document cannot be changed; post a counter document (return, count or issue) instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."movesSealed" THEN RAISE EXCEPTION 'Only a posted document has sealed moves' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" = 'SUBMITTED') OR
       (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('DRAFT', 'APPROVED')) OR
       (OLD."status" = 'APPROVED' AND NEW."status" = 'POSTED')) THEN
    RAISE EXCEPTION 'Inventory document cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  late := OLD."status" = 'APPROVED' AND NEW."status" = 'POSTED' AND OLD."sourceType" IS NOT NULL
          AND NEW."docDate" > OLD."docDate" AND NEW."originalDate" = OLD."docDate" AND OLD."originalDate" IS NULL
          AND length(coalesce(NEW."lateReason", '')) >= 5;
  IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - wf - CASE WHEN late THEN ARRAY['docDate', 'originalDate', 'lateReason'] ELSE ARRAY[]::text[] END)
     IS DISTINCT FROM (to_jsonb(OLD) - wf - CASE WHEN late THEN ARRAY['docDate', 'originalDate', 'lateReason'] ELSE ARRAY[]::text[] END) THEN
    RAISE EXCEPTION 'A submitted inventory document cannot be edited; reject it back to draft first' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IN ('APPROVED', 'POSTED') AND (NEW."approvedBy" IS NULL OR NEW."approvedBy" = NEW."createdBy" OR NEW."approvedBy" = NEW."submittedBy") THEN
    RAISE EXCEPTION 'An inventory document must be approved by someone other than the person who prepared or submitted it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'POSTED' AND (NEW."postedBy" IS NULL OR NEW."postedAt" IS NULL OR NEW."costMethod" IS NULL) THEN
    RAISE EXCEPTION 'A posted inventory document records who posted it, when, and the costing method used' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Sales documents: the stage 4b columns are fixed once the document leaves draft, and a credit
-- note for returned goods credits a posted, warehouse-confirmed return of the same invoice.
CREATE OR REPLACE FUNCTION acc_guard_sales_invoice_4b() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'DRAFT'
     AND (NEW."fulfilmentLocationId", NEW."creditType", NEW."customerReturnId", NEW."replacesInvoiceId")
         IS DISTINCT FROM (OLD."fulfilmentLocationId", OLD."creditType", OLD."customerReturnId", OLD."replacesInvoiceId") THEN
    RAISE EXCEPTION 'A submitted sales document cannot be edited; reject it back to draft first' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."kind" = 'INVOICE' AND (NEW."creditType" IS NOT NULL OR NEW."customerReturnId" IS NOT NULL) THEN
    RAISE EXCEPTION 'Only a credit note has a credit type' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."kind" = 'CREDIT_NOTE' AND NEW."creditType" = 'RETURN_OF_GOODS' AND NEW."status" = 'POSTED' THEN
    SELECT "status", "invoiceId" INTO r FROM "CustomerReturn" WHERE "id" = NEW."customerReturnId";
    IF r."status" IS DISTINCT FROM 'POSTED' OR r."invoiceId" IS DISTINCT FROM NEW."originalInvoiceId" THEN
      RAISE EXCEPTION 'A credit note for returned goods credits a posted customer return of the same invoice' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SalesInvoice_accounting_guard_4b" BEFORE INSERT OR UPDATE ON "SalesInvoice"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_sales_invoice_4b();

-- A posted invoice always has a costing record, created in the same transaction as the posting,
-- so a crash between posting and costing leaves a PENDING record for the processor.
CREATE OR REPLACE FUNCTION acc_emit_invoice_costing() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" = 'INVOICE' AND NEW."status" = 'POSTED' AND OLD."status" <> 'POSTED' THEN
    INSERT INTO "InvCosting" ("id", "invoiceId", "status", "createdAt", "updatedAt")
    VALUES ('ic_' || replace(gen_random_uuid()::text, '-', ''), NEW."id", 'PENDING', now(), now())
    ON CONFLICT ("invoiceId") DO NOTHING;
  ELSIF NEW."kind" = 'INVOICE' AND NEW."status" = 'REVERSED' AND OLD."status" = 'POSTED' THEN
    UPDATE "InvCosting" SET "status" = 'PENDING', "nextAttemptAt" = now(), "updatedAt" = now()
     WHERE "invoiceId" = NEW."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SalesInvoice_costing_outbox" AFTER UPDATE OF "status" ON "SalesInvoice"
  FOR EACH ROW EXECUTE FUNCTION acc_emit_invoice_costing();

-- Supplier bills: the stage 4b columns are fixed once the bill leaves draft; credit notes emit
-- their own event types.
CREATE OR REPLACE FUNCTION acc_guard_supplier_bill_4b() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' AND (NEW."kind", NEW."originalBillId", NEW."reason") IS DISTINCT FROM (OLD."kind", OLD."originalBillId", OLD."reason") THEN
    RAISE EXCEPTION 'A submitted supplier document cannot be edited; reject it back to draft first' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW."kind" = 'CREDIT_NOTE') <> (NEW."originalBillId" IS NOT NULL) THEN
    RAISE EXCEPTION 'A supplier credit note names the bill it credits; a bill names none' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SupplierBill_accounting_guard_4b" BEFORE UPDATE ON "SupplierBill"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_supplier_bill_4b();

CREATE OR REPLACE FUNCTION acc_emit_supplier_bill_event() RETURNS trigger AS $$
DECLARE
  et text; at timestamp; base text;
BEGIN
  base := CASE WHEN NEW."kind" = 'CREDIT_NOTE' THEN 'ap.credit_note' ELSE 'ap.bill' END;
  IF NEW."status" = 'POSTED' AND OLD."status" <> 'POSTED' THEN et := base || '.posted'; at := NEW."billDate"::timestamp;
  ELSIF NEW."status" = 'REVERSED' AND OLD."status" <> 'REVERSED' THEN et := base || '.reversed'; at := NEW."reversedAt";
  ELSE RETURN NULL;
  END IF;
  INSERT INTO "AccountingEvent" ("id", "eventType", "sourceModule", "sourceDocumentId", "sourceEventId",
    "idempotencyKey", "occurredAt", "payload", "status", "partyKey", "createdAt", "updatedAt")
  VALUES ('ae_' || replace(gen_random_uuid()::text, '-', ''), et, 'payables', NEW."id", NEW."id" || ':' || et,
    'payables:' || NEW."id" || ':' || et, at,
    jsonb_build_object('billId', NEW."id", 'billNo', NEW."billNo", 'supplierId', NEW."supplierId", 'totalGross', NEW."totalGross"::text, 'kind', NEW."kind"::text),
    'PENDING', 'BILL:' || coalesce(NEW."originalBillId", NEW."id"), now(), now())
  ON CONFLICT ("idempotencyKey") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Conversion-cost pools: approved by someone other than their author; an approved pool never
-- changes (retire it and approve another). Rate = budget / normal capacity.
CREATE OR REPLACE FUNCTION acc_guard_inv_cost_pool() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'Only a draft cost pool can be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN OLD;
  END IF;
  IF NEW."budgetAmount" < 0 OR NEW."normalCapacity" <= 0 OR NEW."rate" <> round(NEW."budgetAmount" / NEW."normalCapacity", 4) THEN
    RAISE EXCEPTION 'A cost pool rate is its budget over a positive normal capacity' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."status" <> 'DRAFT' THEN RAISE EXCEPTION 'A cost pool starts as a draft' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - 'status' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updatedAt') THEN
      RAISE EXCEPTION 'An approved cost pool cannot change; retire it and approve a new one' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED') OR (OLD."status" = 'APPROVED' AND NEW."status" = 'RETIRED')) THEN
      RAISE EXCEPTION 'Cost pool cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" = 'APPROVED' AND (NEW."approvedBy" IS NULL OR NEW."approvedBy" = NEW."createdBy") THEN
      RAISE EXCEPTION 'A cost pool must be approved by someone other than its author' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvCostPool_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvCostPool"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_inv_cost_pool();

-- Customer returns: received with warehouse evidence, approved by someone other than the person
-- who recorded or received them, posted once; nothing changes after posting.
CREATE OR REPLACE FUNCTION acc_guard_customer_return() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'Only a draft return can be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN RAISE EXCEPTION 'A customer return starts as a draft' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'POSTED' AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'A posted customer return cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" = 'RECEIVED') OR (OLD."status" = 'RECEIVED' AND NEW."status" IN ('DRAFT', 'APPROVED')) OR
       (OLD."status" = 'APPROVED' AND NEW."status" = 'POSTED')) THEN
    RAISE EXCEPTION 'Customer return cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IN ('RECEIVED', 'APPROVED', 'POSTED') AND (NEW."receivedBy" IS NULL OR NEW."receivedOn" IS NULL OR length(coalesce(NEW."evidenceRef", '')) < 3) THEN
    RAISE EXCEPTION 'A received return records who received it, when, and the warehouse evidence' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IN ('APPROVED', 'POSTED') AND (NEW."approvedBy" IS NULL OR NEW."approvedBy" IN (NEW."createdBy", NEW."receivedBy")) THEN
    RAISE EXCEPTION 'A customer return must be approved by someone other than the person who recorded or received it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (NEW."customerId", NEW."invoiceId", NEW."locationId", NEW."createdBy") IS DISTINCT FROM (OLD."customerId", OLD."invoiceId", OLD."locationId", OLD."createdBy") THEN
    RAISE EXCEPTION 'A received return cannot be edited; send it back to draft first' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CustomerReturn_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CustomerReturn"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_customer_return();

CREATE OR REPLACE FUNCTION acc_guard_customer_return_line() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT "status"::text INTO st FROM "CustomerReturn" WHERE "id" = COALESCE(NEW."returnId", OLD."returnId");
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of a received customer return cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."quantity" <= 0 THEN RAISE EXCEPTION 'A returned quantity is positive' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CustomerReturnLine_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CustomerReturnLine"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_customer_return_line();

-- Operational integration. Each operational stock write records an InvOpsEvent in its own
-- transaction (txid stamped here). Any InventoryMovement committed by a transaction that recorded
-- none becomes an UNINTEGRATED exception event: a stock writer the integration does not know about
-- is surfaced, never silently missed. This trigger only inserts; it never blocks operations.
CREATE OR REPLACE FUNCTION acc_stamp_inv_ops_event() RETURNS trigger AS $$
BEGIN
  NEW."txid" := txid_current();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvOpsEvent_txid" BEFORE INSERT ON "InvOpsEvent"
  FOR EACH ROW EXECUTE FUNCTION acc_stamp_inv_ops_event();

CREATE OR REPLACE FUNCTION acc_check_movement_integrated() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "InvOpsEvent" WHERE "txid" = txid_current() AND "kind" <> 'UNINTEGRATED') THEN
    INSERT INTO "InvOpsEvent" ("id", "kind", "sourceId", "seq", "occurredOn", "payload", "userId", "status", "lastError", "createdAt", "updatedAt")
    VALUES ('io_' || replace(gen_random_uuid()::text, '-', ''), 'UNINTEGRATED', NEW."id", 0, CURRENT_DATE,
      jsonb_build_object('type', NEW."type"::text, 'category', NEW."category"::text, 'referenceEntityId', NEW."referenceEntityId",
        'quantityChanged', NEW."quantityChanged", 'sourceDocType', NEW."sourceDocType"::text, 'sourceDocId', NEW."sourceDocId", 'notes', NEW."notes"),
      NEW."userId", 'BLOCKED', 'This stock movement was written without an accounting integration record; review it and post a document or dismiss it with a reason.', now(), now())
    ON CONFLICT ("kind", "sourceId", "seq") DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "InventoryMovement_integration_check" AFTER INSERT ON "InventoryMovement"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acc_check_movement_integrated();

-- Supplier credit applied to a bill of the same supplier (AP open items): outbox events.
CREATE TABLE "ApCreditAllocation" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "allocatedOn" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    CONSTRAINT "ApCreditAllocation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ApCreditAllocation_creditNoteId_idx" ON "ApCreditAllocation"("creditNoteId");
CREATE INDEX "ApCreditAllocation_billId_idx" ON "ApCreditAllocation"("billId");
ALTER TABLE "ApCreditAllocation" ADD CONSTRAINT "ApCreditAllocation_amount_check" CHECK ("amount" > 0);

CREATE OR REPLACE FUNCTION acc_guard_ap_credit_allocation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A credit allocation is released, never deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'active' - 'removedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'active' - 'removedAt') OR (NOT OLD."active" AND NEW."active")) THEN
    RAISE EXCEPTION 'A credit allocation only changes by being released' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ApCreditAllocation_accounting_guard" BEFORE UPDATE OR DELETE ON "ApCreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_ap_credit_allocation();

CREATE OR REPLACE FUNCTION acc_emit_ap_credit_allocation() RETURNS trigger AS $$
DECLARE et text; sup text;
BEGIN
  IF TG_OP = 'INSERT' THEN et := 'ap.credit.allocated';
  ELSIF OLD."active" AND NOT NEW."active" THEN et := 'ap.credit.released';
  ELSE RETURN NULL;
  END IF;
  SELECT "supplierId" INTO sup FROM "SupplierBill" WHERE "id" = NEW."billId";
  INSERT INTO "AccountingEvent" ("id", "eventType", "sourceModule", "sourceDocumentId", "sourceEventId",
    "idempotencyKey", "occurredAt", "payload", "status", "partyKey", "createdAt", "updatedAt")
  VALUES ('ae_' || replace(gen_random_uuid()::text, '-', ''), et, 'payables', NEW."id", NEW."id" || ':' || et,
    'payables:' || NEW."id" || ':' || et, CASE WHEN et = 'ap.credit.allocated' THEN NEW."allocatedOn"::timestamp ELSE now() END,
    jsonb_build_object('allocationId', NEW."id"), 'PENDING', 'SUPPLIER:' || sup, now(), now())
  ON CONFLICT ("idempotencyKey") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ApCreditAllocation_outbox" AFTER INSERT OR UPDATE OF "active" ON "ApCreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION acc_emit_ap_credit_allocation();

-- Absorbed conversion cost is a value-only move credited to its pool's absorbed account.
ALTER TABLE "InvMove" DROP CONSTRAINT "InvMove_kind_check";
ALTER TABLE "InvMove" ADD CONSTRAINT "InvMove_kind_check" CHECK (
  ("kind" = 'IN' AND "qty" > 0 AND "value" >= 0) OR ("kind" = 'OUT' AND "qty" < 0 AND "value" <= 0) OR
  ("kind" IN ('REVALUE', 'EXPENSED') AND "qty" = 0) OR
  ("kind" = 'ABSORBED' AND "qty" = 0 AND "value" <= 0 AND "poolId" IS NOT NULL AND "role" IS NOT NULL));

-- Supplier bills: a credit note posts without a payment obligation (it reduces what is owed).
CREATE OR REPLACE FUNCTION acc_guard_supplier_bill() RETURNS trigger AS $$
DECLARE
  n int; s_net numeric; s_vat numeric; s_gross numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only a draft supplier bill can be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'A supplier bill starts as a draft' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Posted and reversed bills are history: the only permitted change is POSTED -> REVERSED.
  IF OLD."status" IN ('POSTED', 'REVERSED') THEN
    IF OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED'
       AND NEW."reversedBy" IS NOT NULL AND NEW."reversedAt" IS NOT NULL AND length(coalesce(NEW."reversalReason", '')) >= 5
       AND (NEW."supplierId", NEW."supplierInvoiceNo", NEW."billDate", NEW."dueDate", NEW."totalNet", NEW."totalVat", NEW."totalGross",
            NEW."obligationId", NEW."approvedBy", NEW."postedBy", NEW."postedAt", NEW."createdBy")
           IS NOT DISTINCT FROM
           (OLD."supplierId", OLD."supplierInvoiceNo", OLD."billDate", OLD."dueDate", OLD."totalNet", OLD."totalVat", OLD."totalGross",
            OLD."obligationId", OLD."approvedBy", OLD."postedBy", OLD."postedAt", OLD."createdBy") THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A posted supplier bill cannot be changed; reverse it instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" = 'SUBMITTED') OR
       (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('DRAFT', 'APPROVED')) OR
       (OLD."status" = 'APPROVED' AND NEW."status" = 'POSTED')) THEN
    RAISE EXCEPTION 'Supplier bill cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Content is editable only while a draft.
  IF OLD."status" <> 'DRAFT' AND (NEW."supplierId", NEW."supplierInvoiceNo", NEW."billDate", NEW."dueDate", NEW."totalNet", NEW."totalVat", NEW."totalGross", NEW."createdBy")
       IS DISTINCT FROM (OLD."supplierId", OLD."supplierInvoiceNo", OLD."billDate", OLD."dueDate", OLD."totalNet", OLD."totalVat", OLD."totalGross", OLD."createdBy") THEN
    RAISE EXCEPTION 'A submitted supplier bill cannot be edited; reject it back to draft first' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'APPROVED' AND (NEW."approvedBy" IS NULL OR NEW."approvedBy" = NEW."createdBy" OR NEW."approvedBy" = NEW."submittedBy") THEN
    RAISE EXCEPTION 'A supplier bill must be approved by someone other than the person who prepared or submitted it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IN ('SUBMITTED', 'APPROVED', 'POSTED') THEN
    SELECT count(*), coalesce(sum("net"), 0), coalesce(sum("vat"), 0), coalesce(sum("gross"), 0)
      INTO n, s_net, s_vat, s_gross FROM "SupplierBillLine" WHERE "billId" = NEW."id";
    IF n = 0 OR NEW."totalGross" <= 0 OR s_net <> NEW."totalNet" OR s_vat <> NEW."totalVat" OR s_gross <> NEW."totalGross"
       OR NEW."totalNet" + NEW."totalVat" <> NEW."totalGross" THEN
      RAISE EXCEPTION 'Supplier bill totals do not equal its lines' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW."status" = 'POSTED' AND (NEW."postedBy" IS NULL OR NEW."postedAt" IS NULL OR (NEW."kind" = 'BILL' AND NEW."obligationId" IS NULL)) THEN
    RAISE EXCEPTION 'A posted supplier bill needs its poster and its payment obligation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."kind" = 'CREDIT_NOTE' AND NEW."obligationId" IS NOT NULL THEN
    RAISE EXCEPTION 'A supplier credit note is not a payment obligation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A layer can change more than once in a transaction (a later cost traced into the same output
-- layer from two receipts). The deferred check runs once per change with that change's row
-- version, so it compares the layer as it is now, not as the change left it.
CREATE OR REPLACE FUNCTION acc_check_inv_layer() RETURNS trigger AS $$
DECLARE q numeric; v numeric; cur "InvLayer"%ROWTYPE;
BEGIN
  SELECT * INTO cur FROM "InvLayer" WHERE "id" = NEW."id";
  IF cur."id" IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM("qty"), 0), COALESCE(SUM("value"), 0) INTO q, v FROM "InvMove" WHERE "layerId" = cur."id" AND "kind" IN ('OUT', 'REVALUE');
  IF cur."qtyIn" + q <> cur."qtyLeft" OR cur."valueIn" + v <> cur."valueLeft" THEN
    RAISE EXCEPTION 'Cost layer % does not equal its moves (quantity % vs %, value % vs %)', cur."id", cur."qtyIn" + q, cur."qtyLeft", cur."valueIn" + v, cur."valueLeft"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
