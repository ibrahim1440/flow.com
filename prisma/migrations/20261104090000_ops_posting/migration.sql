-- Accounting A3 — posting from operations (feat/accounting-ops-posting). docs/accounting/POSTING-CONTRACT.md §4, §10.
--
-- ADDITIVE ONLY: nine new, empty tables (the inventory cost sub-ledger CostItem / CostMove, CostingSettings,
-- InventoryOpeningCost, ExpenseCategory, the AP sub-ledger SupplierInvoice / SupplierInvoiceLine / SupplierPayment /
-- SupplierPaymentAllocation, CommissionGlSync), two nullable columns on "Supplier" (vatNumber, paymentTermsDays),
-- CHECKs on the new tables only, and ledger_* guard functions with their triggers on the new tables only.
-- No existing row is rewritten; no existing constraint, trigger or function changes.
--
-- Guarantees (enforced here, not only in the application):
--   C1 the cost sub-ledger is append-only: a CostMove is never deleted or truncated; its only change is resolving
--      glState PENDING → POSTED / SKIPPED / NONE / OPENING (with journalEntryId) — and none stays PENDING at commit;
--   C2 a cost holder never holds a negative quantity or value, and an empty holder holds no value;
--   C3 a POSTED / CANCELLED supplier invoice keeps its supplier, reference, dates and amounts; its lines are frozen;
--      POSTED → CANCELLED is the only status change after posting, with a reason; paid never exceeds the gross;
--   C4 one live invoice per (supplier, supplier reference).
--
-- One transaction: it applies whole or not at all. Rollback: docs/hr/migration-review/rollback-20261104090000_ops_posting.sql.

BEGIN;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "paymentTermsDays" INTEGER,
ADD COLUMN     "vatNumber" TEXT;

-- CreateTable
CREATE TABLE "CostItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "value" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "avgCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "lastInCost" DECIMAL(18,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostMove" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "costItemId" TEXT NOT NULL,
    "businessDay" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "qtyAfter" DECIMAL(18,4) NOT NULL,
    "valueAfter" DECIMAL(18,2) NOT NULL,
    "sourceModule" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceEvent" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL DEFAULT '',
    "inventoryMovementId" TEXT,
    "journalEntryId" TEXT,
    "glState" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostingSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "abnormalRoastLossPct" DECIMAL(5,2),
    "abnormalUseProductLimit" BOOLEAN NOT NULL DEFAULT false,
    "openingAppliedAt" TIMESTAMP(3),
    "openingAppliedBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryOpeningCost" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "note" TEXT,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryOpeningCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "accountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierRef" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "netTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vatTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grossTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "lastEditedBy" TEXT,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "postedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "journalEntryId" TEXT,
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "purchaseRecordId" TEXT,
    "stockKind" TEXT,
    "stockItemId" TEXT,
    "expenseCategoryId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4),
    "net" DECIMAL(18,2) NOT NULL,
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "vat" DECIMAL(18,2) NOT NULL,
    "gross" DECIMAL(18,2) NOT NULL,
    "matchedValue" DECIMAL(18,2),
    "variance" DECIMAL(18,2),
    "capitalized" DECIMAL(18,2),

    CONSTRAINT "SupplierInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "paymentDate" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "journalEntryId" TEXT,
    "createdBy" TEXT NOT NULL,
    "voidedBy" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPaymentAllocation" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionGlSync" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "postedTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "baselineTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "postings" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionGlSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CostItem_role_idx" ON "CostItem"("role");

-- CreateIndex
CREATE UNIQUE INDEX "CostItem_tenantId_kind_entityId_key" ON "CostItem"("tenantId", "kind", "entityId");

-- CreateIndex
CREATE INDEX "CostMove_costItemId_createdAt_idx" ON "CostMove"("costItemId", "createdAt");

-- CreateIndex
CREATE INDEX "CostMove_sourceType_sourceId_idx" ON "CostMove"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "CostMove_glState_businessDay_idx" ON "CostMove"("glState", "businessDay");

-- CreateIndex
CREATE UNIQUE INDEX "CostMove_tenantId_sourceType_sourceId_sourceEvent_costItemI_key" ON "CostMove"("tenantId", "sourceType", "sourceId", "sourceEvent", "costItemId", "lineKey");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryOpeningCost_kind_entityId_key" ON "InventoryOpeningCost"("kind", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_code_key" ON "ExpenseCategory"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_number_key" ON "SupplierInvoice"("number");

-- CreateIndex
CREATE INDEX "SupplierInvoice_supplierId_status_idx" ON "SupplierInvoice"("supplierId", "status");

-- CreateIndex
CREATE INDEX "SupplierInvoice_status_dueDate_idx" ON "SupplierInvoice"("status", "dueDate");

-- CreateIndex
CREATE INDEX "SupplierInvoiceLine_purchaseRecordId_idx" ON "SupplierInvoiceLine"("purchaseRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceLine_invoiceId_lineNo_key" ON "SupplierInvoiceLine"("invoiceId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_number_key" ON "SupplierPayment"("number");

-- CreateIndex
CREATE INDEX "SupplierPayment_supplierId_paymentDate_idx" ON "SupplierPayment"("supplierId", "paymentDate");

-- CreateIndex
CREATE INDEX "SupplierPaymentAllocation_invoiceId_idx" ON "SupplierPaymentAllocation"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPaymentAllocation_paymentId_invoiceId_key" ON "SupplierPaymentAllocation"("paymentId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionGlSync_employeeId_periodStart_key" ON "CommissionGlSync"("employeeId", "periodStart");

-- AddForeignKey
ALTER TABLE "CostMove" ADD CONSTRAINT "CostMove_costItemId_fkey" FOREIGN KEY ("costItemId") REFERENCES "CostItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentAllocation" ADD CONSTRAINT "SupplierPaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "SupplierPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentAllocation" ADD CONSTRAINT "SupplierPaymentAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── CHECKs ──────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "CostItem" ADD CONSTRAINT "CostItem_kind_check" CHECK ("kind" IN ('GREEN_BEAN', 'MATERIAL', 'ROASTED_BATCH', 'FG_LOT'));
ALTER TABLE "CostItem" ADD CONSTRAINT "CostItem_role_check" CHECK ("role" IN ('INVENTORY_GREEN', 'INVENTORY_PACKAGING', 'INVENTORY_CAFE', 'INVENTORY_ROASTED', 'INVENTORY_PACKED'));
ALTER TABLE "CostItem" ADD CONSTRAINT "CostItem_balance_check" CHECK ("qty" >= 0 AND "value" >= 0 AND "avgCost" >= 0 AND ("qty" > 0 OR "value" = 0));
ALTER TABLE "CostMove" ADD CONSTRAINT "CostMove_kind_check" CHECK ("kind" IN ('RECEIPT', 'ISSUE', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT', 'REVALUATION', 'OPENING', 'WRITE_OFF', 'RETURN'));
ALTER TABLE "CostMove" ADD CONSTRAINT "CostMove_glState_check" CHECK ("glState" IN ('PENDING', 'POSTED', 'SKIPPED', 'NONE', 'OPENING') AND ("glState" <> 'POSTED' OR "journalEntryId" IS NOT NULL));
ALTER TABLE "CostMove" ADD CONSTRAINT "CostMove_after_check" CHECK ("qtyAfter" >= 0 AND "valueAfter" >= 0 AND "unitCost" >= 0);
ALTER TABLE "CostingSettings" ADD CONSTRAINT "CostingSettings_singleton_check" CHECK ("id" = 'singleton' AND ("abnormalRoastLossPct" IS NULL OR ("abnormalRoastLossPct" >= 0 AND "abnormalRoastLossPct" < 100)));
ALTER TABLE "InventoryOpeningCost" ADD CONSTRAINT "InventoryOpeningCost_check" CHECK ("kind" IN ('GREEN_BEAN', 'MATERIAL', 'ROASTED_BATCH', 'FG_LOT') AND "unitCost" >= 0);
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,30}$' AND length(btrim("nameAr")) > 0);
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_status_check" CHECK ("status" IN ('DRAFT', 'SUBMITTED', 'POSTED', 'CANCELLED'));
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_amounts_check" CHECK ("netTotal" >= 0 AND "vatTotal" >= 0 AND "grossTotal" = "netTotal" + "vatTotal" AND "paidTotal" >= 0 AND "paidTotal" <= "grossTotal");
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_dates_check" CHECK ("dueDate" >= "invoiceDate" AND length(btrim("supplierRef")) > 0);
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_lifecycle_check" CHECK (
  ("status" IN ('DRAFT', 'SUBMITTED') OR ("postedBy" IS NOT NULL AND "postedAt" IS NOT NULL))
  AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancelledBy" IS NOT NULL AND length(btrim(coalesce("cancelReason", ''))) >= 3))
  AND ("status" <> 'SUBMITTED' OR ("submittedBy" IS NOT NULL AND "submittedAt" IS NOT NULL)));
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_kind_check" CHECK (
  ("kind" = 'GRN' AND "purchaseRecordId" IS NOT NULL AND "stockItemId" IS NULL AND "expenseCategoryId" IS NULL)
  OR ("kind" = 'STOCK' AND "stockKind" IN ('GREEN_BEAN', 'MATERIAL') AND "stockItemId" IS NOT NULL AND "purchaseRecordId" IS NULL AND "expenseCategoryId" IS NULL)
  OR ("kind" = 'EXPENSE' AND "expenseCategoryId" IS NOT NULL AND "purchaseRecordId" IS NULL AND "stockItemId" IS NULL));
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_amounts_check" CHECK ("net" >= 0 AND "vat" >= 0 AND "gross" = "net" + "vat" AND "vatRate" >= 0 AND "vatRate" <= 100 AND ("quantity" IS NULL OR "quantity" > 0));
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_check" CHECK ("amount" > 0 AND "method" IN ('BANK_TRANSFER', 'CASH', 'CHEQUE') AND "status" IN ('POSTED', 'VOIDED')
  AND (("status" = 'VOIDED') = ("voidedAt" IS NOT NULL AND "voidedBy" IS NOT NULL AND length(btrim(coalesce("voidReason", ''))) >= 3)));
ALTER TABLE "SupplierPaymentAllocation" ADD CONSTRAINT "SupplierPaymentAllocation_amount_check" CHECK ("amount" > 0);
ALTER TABLE "CommissionGlSync" ADD CONSTRAINT "CommissionGlSync_check" CHECK ("postings" >= 0);

-- C4: one live invoice per supplier reference (case-insensitive, trimmed).
CREATE UNIQUE INDEX "SupplierInvoice_supplier_ref_live_key" ON "SupplierInvoice" ("supplierId", lower(btrim("supplierRef"))) WHERE "status" <> 'CANCELLED';

-- ─── C1: the cost sub-ledger is append-only ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ledger_cost_move_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'COST_MOVE_IMMUTABLE: a cost movement is never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."glState" <> 'PENDING' OR NEW."glState" = 'PENDING'
     OR NEW."id" <> OLD."id" OR NEW."tenantId" <> OLD."tenantId" OR NEW."costItemId" <> OLD."costItemId" OR NEW."businessDay" <> OLD."businessDay"
     OR NEW."kind" <> OLD."kind" OR NEW."qty" <> OLD."qty" OR NEW."value" <> OLD."value" OR NEW."unitCost" <> OLD."unitCost"
     OR NEW."qtyAfter" <> OLD."qtyAfter" OR NEW."valueAfter" <> OLD."valueAfter" OR NEW."sourceModule" <> OLD."sourceModule"
     OR NEW."sourceType" <> OLD."sourceType" OR NEW."sourceId" <> OLD."sourceId" OR NEW."sourceEvent" <> OLD."sourceEvent"
     OR NEW."lineKey" <> OLD."lineKey" OR NEW."inventoryMovementId" IS DISTINCT FROM OLD."inventoryMovementId"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."createdBy" <> OLD."createdBy" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'COST_MOVE_IMMUTABLE: a cost movement only resolves its ledger state, once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_cost_move_guard BEFORE UPDATE OR DELETE ON "CostMove" FOR EACH ROW EXECUTE FUNCTION ledger_cost_move_guard();

CREATE OR REPLACE FUNCTION ledger_cost_move_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'COST_MOVE_IMMUTABLE: the cost sub-ledger is never truncated' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER ledger_cost_move_no_truncate BEFORE TRUNCATE ON "CostMove" FOR EACH STATEMENT EXECUTE FUNCTION ledger_cost_move_no_truncate();

-- No movement stays PENDING past its transaction (its ledger state is decided with the operation).
CREATE OR REPLACE FUNCTION ledger_cost_move_resolved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CostMove" WHERE "id" = NEW."id" AND "glState" = 'PENDING') THEN
    RAISE EXCEPTION 'COST_MOVE_PENDING: a cost movement must resolve its ledger state in its transaction (%)', NEW."id" USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_cost_move_resolved AFTER INSERT ON "CostMove" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_cost_move_resolved();

-- ─── C3: a posted supplier invoice is frozen ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ledger_ap_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('POSTED', 'CANCELLED') THEN
    IF NEW."supplierId" <> OLD."supplierId" OR NEW."supplierRef" <> OLD."supplierRef" OR NEW."number" <> OLD."number"
       OR NEW."invoiceDate" <> OLD."invoiceDate" OR NEW."dueDate" <> OLD."dueDate" OR NEW."netTotal" <> OLD."netTotal"
       OR NEW."vatTotal" <> OLD."vatTotal" OR NEW."grossTotal" <> OLD."grossTotal" OR NEW."postedBy" IS DISTINCT FROM OLD."postedBy"
       OR NEW."postedAt" IS DISTINCT FROM OLD."postedAt" OR NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId" THEN
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
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_ap_invoice_guard BEFORE UPDATE ON "SupplierInvoice" FOR EACH ROW EXECUTE FUNCTION ledger_ap_invoice_guard();

CREATE OR REPLACE FUNCTION ledger_ap_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT "status" INTO st FROM "SupplierInvoice" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END);
  -- The posting writes the matched value / variance on the lines BEFORE it marks the invoice POSTED.
  IF st IN ('POSTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'AP_INVOICE_POSTED: the lines of a posted supplier invoice are frozen' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER ledger_ap_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "SupplierInvoiceLine" FOR EACH ROW EXECUTE FUNCTION ledger_ap_line_guard();

COMMIT;
