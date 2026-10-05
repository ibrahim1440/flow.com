-- CreateEnum
CREATE TYPE "SupplierBillStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "BillLineKind" AS ENUM ('EXPENSE', 'STOCK_RECEIPT');

-- AlterTable
ALTER TABLE "AccountingSettings" ADD COLUMN     "bankPostingFrom" DATE;

-- AlterTable
ALTER TABLE "FinCategory" ADD COLUMN     "glAccountId" TEXT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "address" TEXT,
ADD COLUMN     "crNumber" TEXT,
ADD COLUMN     "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "vatNumber" TEXT;

-- CreateTable
CREATE TABLE "SupplierBill" (
    "id" TEXT NOT NULL,
    "billNo" SERIAL NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierInvoiceNo" TEXT NOT NULL,
    "billDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "branchId" TEXT,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "status" "SupplierBillStatus" NOT NULL DEFAULT 'DRAFT',
    "totalNet" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalVat" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalGross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "purchaseObligationId" TEXT,
    "obligationId" TEXT,
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

    CONSTRAINT "SupplierBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierBillLine" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "kind" "BillLineKind" NOT NULL DEFAULT 'EXPENSE',
    "accountId" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "net" DECIMAL(18,2) NOT NULL,
    "taxCategoryId" TEXT,
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "vat" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "gross" DECIMAL(18,2) NOT NULL,
    "costCenterId" TEXT,

    CONSTRAINT "SupplierBillLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierBill_billNo_key" ON "SupplierBill"("billNo");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierBill_obligationId_key" ON "SupplierBill"("obligationId");

-- CreateIndex
CREATE INDEX "SupplierBill_status_idx" ON "SupplierBill"("status");

-- CreateIndex
CREATE INDEX "SupplierBill_supplierId_billDate_idx" ON "SupplierBill"("supplierId", "billDate");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierBill_supplierId_supplierInvoiceNo_key" ON "SupplierBill"("supplierId", "supplierInvoiceNo");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierBillLine_billId_lineNo_key" ON "SupplierBillLine"("billId", "lineNo");

-- AddForeignKey
ALTER TABLE "FinCategory" ADD CONSTRAINT "FinCategory_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierBill" ADD CONSTRAINT "SupplierBill_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierBillLine" ADD CONSTRAINT "SupplierBillLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "SupplierBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierBillLine" ADD CONSTRAINT "SupplierBillLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══ Stage 2 database rules ═══════════════════════════════════════════════════
-- Hand-written; the Prisma diff above cannot express them. Same style as stage 1: a rule a
-- service might forget lives in the database, so every code path is bound by it.

-- 1. Supplier bill lifecycle, four-eyes approval and immutability once posted.
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
  IF NEW."status" = 'POSTED' AND (NEW."postedBy" IS NULL OR NEW."postedAt" IS NULL OR NEW."obligationId" IS NULL) THEN
    RAISE EXCEPTION 'A posted supplier bill needs its poster and its payment obligation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupplierBill_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SupplierBill"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_supplier_bill();

-- 2. Lines change only while the bill is a draft; each line is arithmetically whole.
CREATE OR REPLACE FUNCTION acc_guard_supplier_bill_line() RETURNS trigger AS $$
DECLARE
  st "SupplierBillStatus";
BEGIN
  SELECT "status" INTO st FROM "SupplierBill" WHERE "id" = COALESCE(NEW."billId", OLD."billId");
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of a submitted or posted supplier bill cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."net" + NEW."vat" <> NEW."gross" OR NEW."net" < 0 OR NEW."vat" < 0 THEN
    RAISE EXCEPTION 'Bill line: net + VAT must equal gross, and neither may be negative' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupplierBillLine_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SupplierBillLine"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_supplier_bill_line();

-- 3. Outbox: posting or reversing a bill becomes exactly one accounting event, in the same transaction.
CREATE OR REPLACE FUNCTION acc_emit_supplier_bill_event() RETURNS trigger AS $$
DECLARE
  et text; at timestamp;
BEGIN
  IF NEW."status" = 'POSTED' AND OLD."status" <> 'POSTED' THEN et := 'ap.bill.posted'; at := NEW."billDate"::timestamp;
  ELSIF NEW."status" = 'REVERSED' AND OLD."status" <> 'REVERSED' THEN et := 'ap.bill.reversed'; at := NEW."reversedAt";
  ELSE RETURN NULL;
  END IF;
  INSERT INTO "AccountingEvent" ("id", "eventType", "sourceModule", "sourceDocumentId", "sourceEventId",
    "idempotencyKey", "occurredAt", "payload", "status", "partyKey", "createdAt", "updatedAt")
  VALUES ('ae_' || replace(gen_random_uuid()::text, '-', ''), et, 'payables', NEW."id", NEW."id" || ':' || et,
    'payables:' || NEW."id" || ':' || et, at,
    jsonb_build_object('billId', NEW."id", 'billNo', NEW."billNo", 'supplierId', NEW."supplierId", 'totalGross', NEW."totalGross"::text),
    'PENDING', 'BILL:' || NEW."id", now(), now())
  ON CONFLICT ("idempotencyKey") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupplierBill_accounting_outbox" AFTER UPDATE OF "status" ON "SupplierBill"
  FOR EACH ROW EXECUTE FUNCTION acc_emit_supplier_bill_event();

-- 4. Outbox: a confirmed AND reviewed bank line becomes one event; voiding it later becomes a
--    second event (its journal is mirrored). Both share the line's party key, so they post in order.
CREATE OR REPLACE FUNCTION acc_emit_bank_event() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'CONFIRMED' AND NEW."reviewStatus" = 'REVIEWED' THEN
    INSERT INTO "AccountingEvent" ("id", "eventType", "sourceModule", "sourceDocumentId", "sourceEventId",
      "idempotencyKey", "occurredAt", "payload", "status", "partyKey", "createdAt", "updatedAt")
    VALUES ('ae_' || replace(gen_random_uuid()::text, '-', ''), 'bank.transaction.confirmed', 'bank', NEW."id", NEW."id" || ':confirmed',
      'bank:' || NEW."id" || ':confirmed', NEW."txnDate"::timestamp,
      jsonb_build_object('transactionId', NEW."id", 'cashAccountId', NEW."cashAccountId", 'amount', NEW."amount"::text),
      'PENDING', 'BANKTXN:' || NEW."id", now(), now())
    ON CONFLICT ("idempotencyKey") DO NOTHING;
  ELSIF TG_OP = 'UPDATE' AND NEW."status" = 'VOID' AND OLD."status" <> 'VOID'
        AND EXISTS (SELECT 1 FROM "AccountingEvent" WHERE "idempotencyKey" = 'bank:' || NEW."id" || ':confirmed') THEN
    INSERT INTO "AccountingEvent" ("id", "eventType", "sourceModule", "sourceDocumentId", "sourceEventId",
      "idempotencyKey", "occurredAt", "payload", "status", "partyKey", "createdAt", "updatedAt")
    VALUES ('ae_' || replace(gen_random_uuid()::text, '-', ''), 'bank.transaction.voided', 'bank', NEW."id", NEW."id" || ':voided',
      'bank:' || NEW."id" || ':voided', COALESCE(NEW."voidedAt", now()),
      jsonb_build_object('transactionId', NEW."id"), 'PENDING', 'BANKTXN:' || NEW."id", now(), now())
    ON CONFLICT ("idempotencyKey") DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BankTransaction_accounting_outbox" AFTER INSERT OR UPDATE OF "status", "reviewStatus" ON "BankTransaction"
  FOR EACH ROW EXECUTE FUNCTION acc_emit_bank_event();
