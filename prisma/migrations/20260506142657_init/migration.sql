-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GreenBean" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serialNumber" TEXT NOT NULL,
    "beanType" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "region" TEXT,
    "variety" TEXT,
    "process" TEXT,
    "altitude" TEXT,
    "location" TEXT,
    "quantityKg" REAL NOT NULL DEFAULT 0,
    "receivedDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderNumber" INTEGER NOT NULL,
    "customerId" TEXT NOT NULL,
    "quotationNumber" TEXT,
    "quotationSentDate" DATETIME,
    "approvalStatus" TEXT NOT NULL DEFAULT 'Pending',
    "approvalDate" DATETIME,
    "paymentStatus" TEXT NOT NULL DEFAULT 'Not Paid',
    "vatInvoiceStatus" TEXT NOT NULL DEFAULT 'Not Yet',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "greenBeanId" TEXT,
    "beanTypeName" TEXT NOT NULL,
    "quantityKg" REAL NOT NULL,
    "productionStatus" TEXT NOT NULL DEFAULT 'Pending',
    "deliveryStatus" TEXT NOT NULL DEFAULT 'Not Yet',
    "deliveredQty" REAL NOT NULL DEFAULT 0,
    "remainingQty" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderItem_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RoastingBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderItemId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "greenBeanId" TEXT,
    "greenBeanQuantity" REAL NOT NULL,
    "roastedBeanQuantity" REAL NOT NULL DEFAULT 0,
    "wasteQuantity" REAL NOT NULL DEFAULT 0,
    "bags3kg" INTEGER NOT NULL DEFAULT 0,
    "bags1kg" INTEGER NOT NULL DEFAULT 0,
    "bags250g" INTEGER NOT NULL DEFAULT 0,
    "bags150g" INTEGER NOT NULL DEFAULT 0,
    "samplesGrams" REAL NOT NULL DEFAULT 0,
    "roastProfile" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RoastingBatch_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoastingBatch_greenBeanId_fkey" FOREIGN KEY ("greenBeanId") REFERENCES "GreenBean" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QcRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "coffeeOrigin" TEXT NOT NULL,
    "processing" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "onProfile" BOOLEAN NOT NULL DEFAULT false,
    "underDeveloped" BOOLEAN NOT NULL DEFAULT false,
    "overDeveloped" BOOLEAN NOT NULL DEFAULT false,
    "color" INTEGER,
    "remarks" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "QcRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RoastingBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderItemId" TEXT NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantityKg" REAL NOT NULL,
    "deliveryType" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Delivery_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CoffeeProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "GreenBean_serialNumber_key" ON "GreenBean"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RoastingBatch_batchNumber_key" ON "RoastingBatch"("batchNumber");
