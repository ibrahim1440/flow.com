-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "pin" TEXT NOT NULL,
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
    "country" TEXT NOT NULL,
    "region" TEXT,
    "variety" TEXT,
    "process" TEXT,
    "altitude" TEXT,
    "location" TEXT,
    "quantityKg" DOUBLE PRECISION NOT NULL DEFAULT 0,
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
    "blendTiming" TEXT,
    "parentBatchId" TEXT,
    "qcDeadline" TIMESTAMP(3),
    "qcToken" TEXT,
    "qcClosedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RoastingBatch_pkey" PRIMARY KEY ("id")
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CoffeeProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_username_key" ON "Employee"("username");

-- CreateIndex
CREATE UNIQUE INDEX "GreenBean_serialNumber_key" ON "GreenBean"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RoastingBatch_batchNumber_key" ON "RoastingBatch"("batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RoastingBatch_qcToken_key" ON "RoastingBatch"("qcToken");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_parentBatchId_fkey" FOREIGN KEY ("parentBatchId") REFERENCES "RoastingBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QcRecord" ADD CONSTRAINT "QcRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RoastingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QcRecord" ADD CONSTRAINT "QcRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
