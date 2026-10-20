-- Dispatch without lots (production simplification, Phase D item 7; gap G09). ADDITIVE ONLY: one new
-- table, "DeliveryLine", its two indexes, two foreign keys and one CHECK that judges its own new rows.
-- Nothing is dropped, renamed, retyped, made NOT NULL or back-filled; no existing table is scanned or
-- rewritten, and no existing row is read.
--   DeliveryLine: one row per finished-goods lot a delivery drew from, with the units (SKU lines; NULL on
--     a kilogram line) and kilograms taken from that lot. The rows of one delivery sum to the delivery's
--     quantityUnits / quantityKg. POST /api/deliveries now picks the lots itself (the line's reservations
--     first, then free units, oldest lot first) and may span several lots, so the lot can no longer be a
--     single column on "Delivery".
--     DeliveryLine → Delivery CASCADE (a line exists only with its delivery; a delivery is removed only by
--     the order-item cascade and the admin resets); DeliveryLine → FinishedGoodsLot RESTRICT (a lot with
--     dispatch history cannot be deleted from under it — the admin resets clear DeliveryLine first).
-- Deliveries recorded before this migration keep no lines: their single lot stays on the ledger
-- (InventoryMovement OUT, sourceDocType DELIVERY, sourceDocId = the delivery id), which every reader
-- falls back to (src/lib/services/delivery-lots.ts). No back-fill.
-- Atomic: the whole file runs in one transaction.
-- Rollback: docs/hr/migration-review/rollback-20261023100000_delivery_lines.sql.
BEGIN;

-- CreateTable
CREATE TABLE "DeliveryLine" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "finishedGoodsLotId" TEXT NOT NULL,
    "quantityUnits" INTEGER,
    "quantityKg" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryLine_pkey" PRIMARY KEY ("id")
);

-- A line ships something: positive kilograms, and positive units where units are counted.
ALTER TABLE "DeliveryLine" ADD CONSTRAINT "DeliveryLine_quantity_check"
  CHECK ("quantityKg" > 0 AND ("quantityUnits" IS NULL OR "quantityUnits" > 0));

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryLine_deliveryId_finishedGoodsLotId_key" ON "DeliveryLine"("deliveryId", "finishedGoodsLotId");

-- CreateIndex
CREATE INDEX "DeliveryLine_finishedGoodsLotId_idx" ON "DeliveryLine"("finishedGoodsLotId");

-- AddForeignKey
ALTER TABLE "DeliveryLine" ADD CONSTRAINT "DeliveryLine_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryLine" ADD CONSTRAINT "DeliveryLine_finishedGoodsLotId_fkey" FOREIGN KEY ("finishedGoodsLotId") REFERENCES "FinishedGoodsLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
