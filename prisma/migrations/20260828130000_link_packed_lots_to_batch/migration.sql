-- Many:1 link from a finished-goods lot back to the roast it was packed from.
--
-- FinishedGoodsLot."roastingBatchId" is UNIQUE, encoding the legacy 1:1 shape where a
-- batch became exactly one kilogram lot. One roast can now be packed into several SKUs —
-- a 1 KG lot and a 250 g lot from the same batch — which a unique column cannot express.
-- Rather than drop that constraint (the existing packaging route upserts on it, and one
-- legacy lot has a NULL productSkuId, so a composite unique could not address it either)
-- this adds a second, non-unique link used by the unit-tracked path.
--
-- The two are mutually exclusive by convention and by construction: unit-tracked lots set
-- packedFromBatchId and leave roastingBatchId NULL, legacy lots do the reverse. Batch
-- traceability therefore stays unambiguous from either direction.
--
-- Additive only. Every one of the eight existing lots keeps its roastingBatchId and gets
-- NULL here, which is correct: none of them was produced through the SKU packing path.

ALTER TABLE "FinishedGoodsLot" ADD COLUMN "packedFromBatchId" TEXT;

CREATE INDEX "FinishedGoodsLot_packedFromBatchId_idx" ON "FinishedGoodsLot"("packedFromBatchId");

ALTER TABLE "FinishedGoodsLot" ADD CONSTRAINT "FinishedGoodsLot_packedFromBatchId_fkey"
    FOREIGN KEY ("packedFromBatchId") REFERENCES "RoastingBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A lot is packed through exactly one of the two paths, never both.
ALTER TABLE "FinishedGoodsLot"
    ADD CONSTRAINT "FinishedGoodsLot_one_batch_link"
    CHECK ("roastingBatchId" IS NULL OR "packedFromBatchId" IS NULL);
