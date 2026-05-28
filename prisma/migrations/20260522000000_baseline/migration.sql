-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PurchaseType" AS ENUM ('GREEN_BEAN', 'PACKAGING', 'EQUIPMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('IN', 'OUT', 'ADJUSTMENT', 'LOSS');

-- CreateEnum
CREATE TYPE "InventoryCategory" AS ENUM ('RAW_MATERIAL', 'FINISHED_GOODS');

-- CreateEnum
CREATE TYPE "SourceDocType" AS ENUM ('PURCHASE', 'ROASTING_BATCH', 'DELIVERY', 'BLEND', 'MANUAL_ADJUSTMENT', 'PACKING');

-- CreateEnum
CREATE TYPE "LotStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'SHIPPED');

-- CreateEnum
CREATE TYPE "ProductionOrderStatus" AS ENUM ('PENDING', 'IN_PRODUCTION', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "pin" TEXT NOT NULL,
    "pinHash" TEXT,
    "password" TEXT,
    "role" TEXT NOT NULL,
    "permissions" TEXT NOT NULL DEFAULT '{}',
    "defaultRoute" TEXT NOT NULL DEFAULT '/dashboard',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "phoneNumber" TEXT,
    "preferredLanguage" TEXT NOT NULL DEFAULT 'ar',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GreenBean" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "beanType" TEXT NOT NULL,
    "beanTypeAr" TEXT,
    "country" TEXT NOT NULL,
    "countryAr" TEXT,
    "region" TEXT,
    "regionAr" TEXT,
    "variety" TEXT,
    "process" TEXT,
    "processAr" TEXT,
    "altitude" TEXT,
    "location" TEXT,
    "quantityKg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "receivedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GreenBean_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orderNumber" INTEGER NOT NULL,
    "customerId" TEXT NOT NULL,
    "quotationNumber" TEXT,
    "quotationSentDate" TIMESTAMP(3),
    "approvalStatus" TEXT NOT NULL DEFAULT 'Pending',
    "approvalDate" TIMESTAMP(3),
    "paymentStatus" TEXT NOT NULL DEFAULT 'Not Paid',
    "vatInvoiceStatus" TEXT NOT NULL DEFAULT 'Not Yet',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "greenBeanId" TEXT,
    "productId" TEXT,
    "productSkuId" TEXT,
    "beanTypeName" TEXT NOT NULL,
    "quantityKg" DOUBLE PRECISION NOT NULL,
    "productionStatus" TEXT NOT NULL DEFAULT 'Pending',
    "deliveryStatus" TEXT NOT NULL DEFAULT 'Not Yet',
    "deliveredQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remainingQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoastingBatch" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "greenBeanId" TEXT,
    "productId" TEXT,
    "greenBeanQuantity" DOUBLE PRECISION NOT NULL,
    "roastedBeanQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "wasteQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "roastProfile" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending QC',
    "bags3kg" INTEGER NOT NULL DEFAULT 0,
    "bags1kg" INTEGER NOT NULL DEFAULT 0,
    "bags250g" INTEGER NOT NULL DEFAULT 0,
    "bags150g" INTEGER NOT NULL DEFAULT 0,
    "samplesGrams" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isBlend" BOOLEAN NOT NULL DEFAULT false,
    "blendTiming" TEXT,
    "parentBatchId" TEXT,
    "qcDeadline" TIMESTAMP(3),
    "qcToken" TEXT,
    "qcClosedById" TEXT,
    "productionOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoastingBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlendIngredient" (
    "id" TEXT NOT NULL,
    "sourceBatchId" TEXT NOT NULL,
    "targetBlendBatchId" TEXT NOT NULL,
    "quantityUsed" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlendIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QcRecord" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "coffeeOrigin" TEXT NOT NULL,
    "processing" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "onProfile" BOOLEAN NOT NULL DEFAULT false,
    "underDeveloped" BOOLEAN NOT NULL DEFAULT false,
    "overDeveloped" BOOLEAN NOT NULL DEFAULT false,
    "color" INTEGER,
    "colorWhole" DOUBLE PRECISION,
    "colorGround" DOUBLE PRECISION,
    "remarks" TEXT,
    "employeeId" TEXT,
    "isExternal" BOOLEAN NOT NULL DEFAULT false,
    "testerName" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'Accept',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QcRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantityKg" DOUBLE PRECISION NOT NULL,
    "deliveryType" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuppingSession" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "sessionToken" TEXT,
    "batchId" TEXT,
    "greenBeanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CuppingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuppingSessionBatch" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "batchId" TEXT,
    "isExternalSample" BOOLEAN NOT NULL DEFAULT false,
    "externalSampleName" TEXT,
    "externalSupplierName" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CuppingSessionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuppingScore" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionBatchId" TEXT,
    "employeeId" TEXT,
    "externalName" TEXT,
    "fragranceAroma" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "flavor" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "aftertaste" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "acidity" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "body" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "uniformity" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "cleanCup" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "sweetness" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "overall" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "defectCups" INTEGER NOT NULL DEFAULT 0,
    "defectType" TEXT NOT NULL DEFAULT 'none',
    "finalScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "flavorDescriptors" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CuppingScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "logoBase64" TEXT,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerRoastPreference" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "greenBeanId" TEXT NOT NULL,
    "profileName" TEXT NOT NULL,
    "usageType" TEXT NOT NULL DEFAULT 'BOTH',
    "notes" TEXT,
    "targetColorWhole" DOUBLE PRECISION,
    "targetToleranceWhole" DOUBLE PRECISION,
    "targetColorGround" DOUBLE PRECISION,
    "targetToleranceGround" DOUBLE PRECISION,
    "targetDeltaMin" DOUBLE PRECISION,
    "targetDeltaMax" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerRoastPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoffeeProduct" (
    "id" TEXT NOT NULL,
    "productNameEn" TEXT NOT NULL,
    "productNameAr" TEXT,
    "countryEn" TEXT NOT NULL,
    "countryAr" TEXT,
    "regionEn" TEXT,
    "regionAr" TEXT,
    "varietyEn" TEXT,
    "varietyAr" TEXT,
    "processEn" TEXT,
    "processAr" TEXT,
    "altitude" TEXT,
    "cupNotesEn" TEXT,
    "cupNotesAr" TEXT,
    "roastPathEn" TEXT,
    "roastPathAr" TEXT,
    "defaultGreenBeanId" TEXT,
    "expectedRoastLoss" DOUBLE PRECISION NOT NULL DEFAULT 15.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoffeeProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRecord" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "type" "PurchaseType" NOT NULL,
    "itemId" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "costPerUnit" DOUBLE PRECISION NOT NULL,
    "totalCost" DOUBLE PRECISION NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "type" "MovementType" NOT NULL,
    "category" "InventoryCategory" NOT NULL,
    "referenceEntityId" TEXT,
    "quantityChanged" DOUBLE PRECISION NOT NULL,
    "previousQuantity" DOUBLE PRECISION NOT NULL,
    "newQuantity" DOUBLE PRECISION NOT NULL,
    "sourceDocType" "SourceDocType" NOT NULL,
    "sourceDocId" TEXT,
    "userId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinishedGoodsLot" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productSkuId" TEXT,
    "batchNumber" TEXT NOT NULL,
    "roastingBatchId" TEXT,
    "quantityKg" DOUBLE PRECISION NOT NULL,
    "availableQty" DOUBLE PRECISION NOT NULL,
    "status" "LotStatus" NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinishedGoodsLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSKU" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "skuCode" TEXT NOT NULL,
    "weightGrams" DOUBLE PRECISION NOT NULL,
    "isBulk" BOOLEAN NOT NULL DEFAULT false,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSKU_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionOrder" (
    "id" TEXT NOT NULL,
    "productionNumber" TEXT NOT NULL,
    "productSkuId" TEXT NOT NULL,
    "targetUnits" INTEGER NOT NULL,
    "targetWeightKg" DOUBLE PRECISION NOT NULL,
    "expectedGreenBeanKg" DOUBLE PRECISION NOT NULL,
    "status" "ProductionOrderStatus" NOT NULL DEFAULT 'PENDING',
    "surplusHandled" BOOLEAN NOT NULL DEFAULT false,
    "sourceOrderItemId" TEXT,
    "greenBeanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "identifierHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_username_key" ON "Employee"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_pinHash_key" ON "Employee"("pinHash");

-- CreateIndex
CREATE UNIQUE INDEX "GreenBean_serialNumber_key" ON "GreenBean"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RoastingBatch_qcToken_key" ON "RoastingBatch"("qcToken");

-- CreateIndex
CREATE INDEX "RoastingBatch_greenBeanId_createdAt_idx" ON "RoastingBatch"("greenBeanId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoastingBatch_greenBeanId_batchNumber_key" ON "RoastingBatch"("greenBeanId", "batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CuppingSession_sessionToken_key" ON "CuppingSession"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerRoastPreference_customerId_greenBeanId_key" ON "CustomerRoastPreference"("customerId", "greenBeanId");

-- CreateIndex
CREATE UNIQUE INDEX "FinishedGoodsLot_batchNumber_key" ON "FinishedGoodsLot"("batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FinishedGoodsLot_roastingBatchId_key" ON "FinishedGoodsLot"("roastingBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSKU_skuCode_key" ON "ProductSKU"("skuCode");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionOrder_productionNumber_key" ON "ProductionOrder"("productionNumber");

-- CreateIndex
CREATE INDEX "LoginAttempt_ipHash_createdAt_idx" ON "LoginAttempt"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ipHash_identifierHash_createdAt_idx" ON "LoginAttempt"("ipHash", "identifierHash", "createdAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productSkuId_fkey" FOREIGN KEY ("productSkuId") REFERENCES "ProductSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_parentBatchId_fkey" FOREIGN KEY ("parentBatchId") REFERENCES "RoastingBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlendIngredient" ADD CONSTRAINT "BlendIngredient_sourceBatchId_fkey" FOREIGN KEY ("sourceBatchId") REFERENCES "RoastingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlendIngredient" ADD CONSTRAINT "BlendIngredient_targetBlendBatchId_fkey" FOREIGN KEY ("targetBlendBatchId") REFERENCES "RoastingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QcRecord" ADD CONSTRAINT "QcRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QcRecord" ADD CONSTRAINT "QcRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuppingSession" ADD CONSTRAINT "CuppingSession_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuppingSession" ADD CONSTRAINT "CuppingSession_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuppingSessionBatch" ADD CONSTRAINT "CuppingSessionBatch_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CuppingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuppingSessionBatch" ADD CONSTRAINT "CuppingSessionBatch_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuppingScore" ADD CONSTRAINT "CuppingScore_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CuppingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuppingScore" ADD CONSTRAINT "CuppingScore_sessionBatchId_fkey" FOREIGN KEY ("sessionBatchId") REFERENCES "CuppingSessionBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuppingScore" ADD CONSTRAINT "CuppingScore_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerRoastPreference" ADD CONSTRAINT "CustomerRoastPreference_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerRoastPreference" ADD CONSTRAINT "CustomerRoastPreference_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoffeeProduct" ADD CONSTRAINT "CoffeeProduct_defaultGreenBeanId_fkey" FOREIGN KEY ("defaultGreenBeanId") REFERENCES "GreenBean"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRecord" ADD CONSTRAINT "PurchaseRecord_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinishedGoodsLot" ADD CONSTRAINT "FinishedGoodsLot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinishedGoodsLot" ADD CONSTRAINT "FinishedGoodsLot_productSkuId_fkey" FOREIGN KEY ("productSkuId") REFERENCES "ProductSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinishedGoodsLot" ADD CONSTRAINT "FinishedGoodsLot_roastingBatchId_fkey" FOREIGN KEY ("roastingBatchId") REFERENCES "RoastingBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSKU" ADD CONSTRAINT "ProductSKU_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_productSkuId_fkey" FOREIGN KEY ("productSkuId") REFERENCES "ProductSKU"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_sourceOrderItemId_fkey" FOREIGN KEY ("sourceOrderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Manually preserved CHECK constraints not represented by Prisma schema
ALTER TABLE "GreenBean"
  ADD CONSTRAINT "GreenBean_quantityKg_non_negative"
  CHECK ("quantityKg" >= 0);

ALTER TABLE "RoastingBatch"
  ADD CONSTRAINT "RoastingBatch_greenBeanQuantity_positive"
  CHECK ("greenBeanQuantity" > 0);

ALTER TABLE "RoastingBatch"
  ADD CONSTRAINT "RoastingBatch_roastedBeanQuantity_non_negative"
  CHECK ("roastedBeanQuantity" >= 0);

ALTER TABLE "RoastingBatch"
  ADD CONSTRAINT "RoastingBatch_wasteQuantity_non_negative"
  CHECK ("wasteQuantity" >= 0);

ALTER TABLE "FinishedGoodsLot"
  ADD CONSTRAINT "FinishedGoodsLot_availableQty_non_negative"
  CHECK ("availableQty" >= 0);
