-- CreateIndex
CREATE INDEX "CuppingSession_status_idx" ON "CuppingSession"("status");

-- CreateIndex
CREATE INDEX "Delivery_date_idx" ON "Delivery"("date");

-- CreateIndex
CREATE INDEX "FinishedGoodsLot_status_idx" ON "FinishedGoodsLot"("status");

-- CreateIndex
CREATE INDEX "FinishedGoodsLot_createdAt_idx" ON "FinishedGoodsLot"("createdAt");

-- CreateIndex
CREATE INDEX "GreenBean_isActive_idx" ON "GreenBean"("isActive");

-- CreateIndex
CREATE INDEX "GreenBean_isActive_quantityKg_idx" ON "GreenBean"("isActive", "quantityKg");

-- CreateIndex
CREATE INDEX "InventoryMovement_timestamp_idx" ON "InventoryMovement"("timestamp");

-- CreateIndex
CREATE INDEX "InventoryMovement_category_timestamp_idx" ON "InventoryMovement"("category", "timestamp");

-- CreateIndex
CREATE INDEX "InventoryMovement_referenceEntityId_idx" ON "InventoryMovement"("referenceEntityId");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderItem_productionStatus_idx" ON "OrderItem"("productionStatus");

-- CreateIndex
CREATE INDEX "OrderItem_deliveryStatus_idx" ON "OrderItem"("deliveryStatus");

-- CreateIndex
CREATE INDEX "OrderItem_productionStatus_deliveryStatus_idx" ON "OrderItem"("productionStatus", "deliveryStatus");

-- CreateIndex
CREATE INDEX "PurchaseRecord_purchaseDate_idx" ON "PurchaseRecord"("purchaseDate");

-- CreateIndex
CREATE INDEX "PurchaseRecord_supplierId_purchaseDate_idx" ON "PurchaseRecord"("supplierId", "purchaseDate");

-- CreateIndex
CREATE INDEX "QcRecord_date_idx" ON "QcRecord"("date");

-- CreateIndex
CREATE INDEX "QcRecord_batchId_date_idx" ON "QcRecord"("batchId", "date");

-- CreateIndex
CREATE INDEX "RoastingBatch_status_idx" ON "RoastingBatch"("status");

-- CreateIndex
CREATE INDEX "RoastingBatch_status_createdAt_idx" ON "RoastingBatch"("status", "createdAt");
