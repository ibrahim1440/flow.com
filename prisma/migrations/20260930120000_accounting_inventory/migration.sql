-- Stage 4: inventory valuation and manufacturing costing (docs/accounting/STAGE_4_DESIGN.md).
-- Accounting-owned tables in Decimal beside the operational quantity records, which are linked
-- (InvItem.greenBeanId, materialItemId, …) but never written from here.
-- CreateEnum
CREATE TYPE "InvItemKind" AS ENUM ('GREEN_COFFEE', 'ROASTED_COFFEE', 'PACKAGING', 'MILK', 'BAKERY_INGREDIENT', 'FINISHED_GOOD', 'RESALE_GOOD', 'CONSUMABLE');

-- CreateEnum
CREATE TYPE "InvCostMethod" AS ENUM ('WEIGHTED_AVERAGE', 'FIFO');

-- CreateEnum
CREATE TYPE "InvPriceDifference" AS ENUM ('CAPITALISE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "InvDocType" AS ENUM ('RECEIPT', 'SUPPLIER_RETURN', 'ISSUE', 'TRANSFER', 'PRODUCTION', 'SALE_ISSUE', 'CUSTOMER_RETURN', 'LANDED_COST', 'BILL_MATCH', 'COUNT');

-- CreateEnum
CREATE TYPE "InvDocStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED');

-- CreateEnum
CREATE TYPE "InvLineRole" AS ENUM ('LINE', 'INPUT', 'OUTPUT');

-- CreateEnum
CREATE TYPE "InvIssueReason" AS ENUM ('INTERNAL_USE', 'CALIBRATION', 'QC', 'TRAINING', 'SPOILAGE');

-- CreateEnum
CREATE TYPE "InvLossBandStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

-- AlterTable
ALTER TABLE "AccountingSettings" ADD COLUMN     "inventoryCostMethod" "InvCostMethod",
ADD COLUMN     "inventoryPriceDifference" "InvPriceDifference";

-- CreateTable
CREATE TABLE "InvItem" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "kind" "InvItemKind" NOT NULL,
    "baseUnit" TEXT NOT NULL,
    "yieldPerUnit" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "greenBeanId" TEXT,
    "coffeeProductId" TEXT,
    "materialItemId" TEXT,
    "productSkuId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvUnit" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "factor" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "InvUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvLocation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvLossBand" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "process" TEXT NOT NULL,
    "maxLossPercent" DECIMAL(5,2) NOT NULL,
    "status" "InvLossBandStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvLossBand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvDocument" (
    "id" TEXT NOT NULL,
    "docNo" SERIAL NOT NULL,
    "type" "InvDocType" NOT NULL,
    "status" "InvDocStatus" NOT NULL DEFAULT 'DRAFT',
    "docDate" DATE NOT NULL,
    "locationId" TEXT NOT NULL,
    "toLocationId" TEXT,
    "supplierId" TEXT,
    "customerId" TEXT,
    "description" TEXT,
    "reason" TEXT,
    "issueReason" "InvIssueReason",
    "lossBandId" TEXT,
    "lossBandPercent" DECIMAL(5,2),
    "costMethod" "InvCostMethod",
    "priceDifference" "InvPriceDifference",
    "provisional" BOOLEAN NOT NULL DEFAULT false,
    "amount" DECIMAL(18,2),
    "allocationBasis" TEXT,
    "billLineId" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "requestKey" TEXT,
    "createdBy" TEXT NOT NULL,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "postedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "movesSealed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvDocLine" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "role" "InvLineRole" NOT NULL DEFAULT 'LINE',
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "factor" DECIMAL(18,6) NOT NULL,
    "baseQty" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4),
    "countedQty" DECIMAL(18,4),
    "targetLineId" TEXT,
    "description" TEXT,

    CONSTRAINT "InvDocLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvLayer" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "moveId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "qtyIn" DECIMAL(18,4) NOT NULL,
    "valueIn" DECIMAL(18,2) NOT NULL,
    "qtyLeft" DECIMAL(18,4) NOT NULL,
    "valueLeft" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvLayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvMove" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineId" TEXT,
    "itemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "layerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvMove_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvItem_code_key" ON "InvItem"("code");

-- CreateIndex
CREATE UNIQUE INDEX "InvItem_greenBeanId_key" ON "InvItem"("greenBeanId");

-- CreateIndex
CREATE UNIQUE INDEX "InvItem_coffeeProductId_key" ON "InvItem"("coffeeProductId");

-- CreateIndex
CREATE UNIQUE INDEX "InvItem_materialItemId_key" ON "InvItem"("materialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "InvItem_productSkuId_key" ON "InvItem"("productSkuId");

-- CreateIndex
CREATE INDEX "InvItem_kind_isActive_idx" ON "InvItem"("kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "InvUnit_itemId_unit_key" ON "InvUnit"("itemId", "unit");

-- CreateIndex
CREATE UNIQUE INDEX "InvLocation_code_key" ON "InvLocation"("code");

-- CreateIndex
CREATE UNIQUE INDEX "InvLossBand_code_key" ON "InvLossBand"("code");

-- CreateIndex
CREATE UNIQUE INDEX "InvDocument_docNo_key" ON "InvDocument"("docNo");

-- CreateIndex
CREATE UNIQUE INDEX "InvDocument_billLineId_key" ON "InvDocument"("billLineId");

-- CreateIndex
CREATE UNIQUE INDEX "InvDocument_requestKey_key" ON "InvDocument"("requestKey");

-- CreateIndex
CREATE INDEX "InvDocument_status_docDate_idx" ON "InvDocument"("status", "docDate");

-- CreateIndex
CREATE INDEX "InvDocument_type_status_idx" ON "InvDocument"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InvDocument_sourceType_sourceId_key" ON "InvDocument"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "InvDocLine_targetLineId_idx" ON "InvDocLine"("targetLineId");

-- CreateIndex
CREATE UNIQUE INDEX "InvDocLine_documentId_lineNo_key" ON "InvDocLine"("documentId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "InvLayer_moveId_key" ON "InvLayer"("moveId");

-- CreateIndex
CREATE INDEX "InvLayer_itemId_locationId_date_idx" ON "InvLayer"("itemId", "locationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "InvMove_seq_key" ON "InvMove"("seq");

-- CreateIndex
CREATE INDEX "InvMove_itemId_locationId_date_idx" ON "InvMove"("itemId", "locationId", "date");

-- CreateIndex
CREATE INDEX "InvMove_documentId_idx" ON "InvMove"("documentId");

-- AddForeignKey
ALTER TABLE "InvUnit" ADD CONSTRAINT "InvUnit_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InvItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvDocLine" ADD CONSTRAINT "InvDocLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "InvDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvDocLine" ADD CONSTRAINT "InvDocLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InvItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvLayer" ADD CONSTRAINT "InvLayer_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InvItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvMove" ADD CONSTRAINT "InvMove_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "InvDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvMove" ADD CONSTRAINT "InvMove_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InvItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Controls ───────────────────────────────────────────────────────────────────────────────
ALTER TABLE "InvUnit" ADD CONSTRAINT "InvUnit_factor_check" CHECK ("factor" > 0);
ALTER TABLE "InvItem" ADD CONSTRAINT "InvItem_yield_check" CHECK ("yieldPerUnit" > 0);
ALTER TABLE "InvLossBand" ADD CONSTRAINT "InvLossBand_percent_check" CHECK ("maxLossPercent" >= 0 AND "maxLossPercent" < 100);
ALTER TABLE "InvDocLine" ADD CONSTRAINT "InvDocLine_qty_check" CHECK ("quantity" >= 0 AND "baseQty" >= 0 AND "factor" > 0 AND ("unitCost" IS NULL OR "unitCost" >= 0) AND ("countedQty" IS NULL OR "countedQty" >= 0));
ALTER TABLE "InvLayer" ADD CONSTRAINT "InvLayer_amounts_check" CHECK ("qtyIn" > 0 AND "valueIn" >= 0 AND "qtyLeft" >= 0 AND "valueLeft" >= 0 AND "qtyLeft" <= "qtyIn" AND ("qtyLeft" > 0 OR "valueLeft" = 0));
ALTER TABLE "InvMove" ADD CONSTRAINT "InvMove_kind_check" CHECK (
  ("kind" = 'IN' AND "qty" > 0 AND "value" >= 0) OR ("kind" = 'OUT' AND "qty" < 0 AND "value" <= 0) OR
  ("kind" IN ('REVALUE', 'EXPENSED') AND "qty" = 0));
ALTER TABLE "InvDocument" ADD CONSTRAINT "InvDocument_basis_check" CHECK ("allocationBasis" IS NULL OR "allocationBasis" IN ('VALUE', 'QUANTITY'));

-- Documents: DRAFT → SUBMITTED → APPROVED (someone else) → POSTED; SUBMITTED → DRAFT on rejection.
-- Content changes only while a draft; a posted document is history (only its moves get sealed).
CREATE OR REPLACE FUNCTION acc_guard_inv_document() RETURNS trigger AS $$
DECLARE wf text[] := ARRAY['status', 'submittedBy', 'submittedAt', 'approvedBy', 'approvedAt', 'postedBy', 'postedAt',
  'rejectedBy', 'rejectedAt', 'rejectedReason', 'movesSealed', 'updatedAt', 'lossBandPercent', 'costMethod', 'priceDifference', 'provisional'];
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
  IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - wf) IS DISTINCT FROM (to_jsonb(OLD) - wf) THEN
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
CREATE TRIGGER "InvDocument_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvDocument"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_inv_document();

CREATE OR REPLACE FUNCTION acc_guard_inv_doc_line() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT "status"::text INTO st FROM "InvDocument" WHERE "id" = COALESCE(NEW."documentId", OLD."documentId");
  IF st IS NULL OR st = 'DRAFT' THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'Lines of a % inventory document cannot change', st USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvDocLine_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvDocLine"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_inv_doc_line();

-- Moves: written only while their document is being posted; never changed or deleted.
CREATE OR REPLACE FUNCTION acc_guard_inv_move() RETURNS trigger AS $$
DECLARE d record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Inventory cost moves are part of the ledger and cannot be changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT "status", "movesSealed", "docDate" INTO d FROM "InvDocument" WHERE "id" = NEW."documentId";
  IF d."status" IS DISTINCT FROM 'POSTED' OR d."movesSealed" OR NEW."date" <> d."docDate" THEN
    RAISE EXCEPTION 'Cost moves are written only while their document posts, on its date' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvMove_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvMove"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_inv_move();

-- Layers: created from an IN move; afterwards only what is left changes, and at commit a layer
-- must equal its receipt plus every move drawn from or revaluing it.
CREATE OR REPLACE FUNCTION acc_guard_inv_layer() RETURNS trigger AS $$
DECLARE m record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Cost layers cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO m FROM "InvMove" WHERE "id" = NEW."moveId";
    IF m."id" IS NULL OR m."kind" <> 'IN' OR m."itemId" <> NEW."itemId" OR m."locationId" <> NEW."locationId" OR m."date" <> NEW."date"
       OR m."qty" <> NEW."qtyIn" OR m."value" <> NEW."valueIn" OR NEW."qtyLeft" <> NEW."qtyIn" OR NEW."valueLeft" <> NEW."valueIn" THEN
      RAISE EXCEPTION 'A cost layer is created from its receiving move, whole' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."itemId", NEW."locationId", NEW."moveId", NEW."date", NEW."qtyIn", NEW."valueIn") IS DISTINCT FROM (OLD."itemId", OLD."locationId", OLD."moveId", OLD."date", OLD."qtyIn", OLD."valueIn")
     OR NEW."qtyLeft" > OLD."qtyLeft" THEN
    RAISE EXCEPTION 'Only what is left of a cost layer can change, and its quantity only goes down' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvLayer_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvLayer"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_inv_layer();

CREATE OR REPLACE FUNCTION acc_check_inv_layer() RETURNS trigger AS $$
DECLARE q numeric; v numeric;
BEGIN
  SELECT COALESCE(SUM("qty"), 0), COALESCE(SUM("value"), 0) INTO q, v FROM "InvMove" WHERE "layerId" = NEW."id" AND "kind" IN ('OUT', 'REVALUE');
  IF NEW."qtyIn" + q <> NEW."qtyLeft" OR NEW."valueIn" + v <> NEW."valueLeft" THEN
    RAISE EXCEPTION 'Cost layer % does not equal its moves (quantity % vs %, value % vs %)', NEW."id", NEW."qtyIn" + q, NEW."qtyLeft", NEW."valueIn" + v, NEW."valueLeft"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "InvLayer_equals_moves" AFTER INSERT OR UPDATE ON "InvLayer"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acc_check_inv_layer();

-- Items: the kind decides the inventory account and the base unit every quantity is kept in;
-- neither changes once the item has cost moves.
CREATE OR REPLACE FUNCTION acc_guard_inv_item() RETURNS trigger AS $$
BEGIN
  IF (NEW."kind", NEW."baseUnit", NEW."yieldPerUnit") IS DISTINCT FROM (OLD."kind", OLD."baseUnit", OLD."yieldPerUnit")
     AND EXISTS (SELECT 1 FROM "InvMove" WHERE "itemId" = OLD."id") THEN
    RAISE EXCEPTION 'An item with cost moves keeps its kind, base unit and yield weight' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvItem_accounting_guard" BEFORE UPDATE ON "InvItem"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_inv_item();

-- Loss bands (D-1): approved by someone other than their author; an approved band's percentage
-- never changes (retire it and approve a new one).
CREATE OR REPLACE FUNCTION acc_guard_inv_loss_band() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'Only a draft loss band can be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' AND NEW."status" <> 'DRAFT' THEN RAISE EXCEPTION 'A loss band starts as a draft' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" <> 'DRAFT' AND (NEW."maxLossPercent", NEW."process", NEW."code", NEW."createdBy", NEW."approvedBy") IS DISTINCT FROM (OLD."maxLossPercent", OLD."process", OLD."code", OLD."createdBy", OLD."approvedBy") THEN
      RAISE EXCEPTION 'An approved loss band cannot change; retire it and approve a new one' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED') OR (OLD."status" = 'APPROVED' AND NEW."status" = 'RETIRED')) THEN
      RAISE EXCEPTION 'Loss band cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" = 'APPROVED' AND (NEW."approvedBy" IS NULL OR NEW."approvedBy" = NEW."createdBy") THEN
      RAISE EXCEPTION 'A loss band must be approved by someone other than its author' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvLossBand_accounting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvLossBand"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_inv_loss_band();

-- Outbox: a posted inventory document is exactly one event.
CREATE OR REPLACE FUNCTION acc_emit_inv_document_event() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'POSTED' AND OLD."status" <> 'POSTED' THEN
    INSERT INTO "AccountingEvent" ("id", "eventType", "sourceModule", "sourceDocumentId", "sourceEventId",
      "idempotencyKey", "occurredAt", "payload", "status", "partyKey", "createdAt", "updatedAt")
    VALUES ('ae_' || replace(gen_random_uuid()::text, '-', ''), 'inv.document.posted', 'inventory', NEW."id", NEW."id" || ':inv.document.posted',
      'inventory:' || NEW."id" || ':inv.document.posted', NEW."docDate"::timestamp,
      jsonb_build_object('documentId', NEW."id", 'docNo', NEW."docNo", 'type', NEW."type"::text),
      'PENDING', NULL, now(), now())
    ON CONFLICT ("idempotencyKey") DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InvDocument_accounting_outbox" AFTER UPDATE OF "status" ON "InvDocument"
  FOR EACH ROW EXECUTE FUNCTION acc_emit_inv_document_event();
