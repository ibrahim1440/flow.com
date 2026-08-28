-- Backfill reservations for coffee that was already spoken for when shelf allocation shipped.
--
-- 20260826090000_add_shelf_allocation added reservedQty with DEFAULT 0 on the reasoning that
-- nothing could previously reserve stock. That is true of the COLUMN but not of the business
-- reality: under the old delivery rule a lot could only ever be shipped against the order item
-- whose batch produced it, so every packaged-but-undelivered lot was effectively reserved to
-- that item. Leaving those at reservedQty = 0 publishes them to the shelf, where the first new
-- order to come along can reserve them out from under the order that paid for the roast.
--
-- This reproduces, for existing rows, exactly what the packaging route now does at packaging
-- time: claim the lot for its own order item, up to what that item still needs.
--
-- Idempotent: it inserts nothing for lots that already carry an allocation, so re-running it
-- is a no-op.

INSERT INTO "StockAllocation" (
    "id", "orderItemId", "finishedGoodsLotId", "quantityKg", "status", "createdById", "createdAt", "updatedAt"
)
SELECT
    -- Deterministic id so a re-run cannot create a second row for the same lot.
    'backfill_' || md5(fgl."id"),
    oi."id",
    fgl."id",
    LEAST(
        fgl."availableQty",
        GREATEST(oi."quantityKg" - oi."deliveredQty", 0)
    ),
    'RESERVED',
    NULL,
    now(),
    now()
FROM "FinishedGoodsLot" fgl
JOIN "RoastingBatch" rb ON rb."id" = fgl."roastingBatchId"
JOIN "OrderItem"     oi ON oi."id" = rb."orderItemId"
JOIN "Order"          o ON o."id"  = oi."orderId"
WHERE fgl."status" = 'AVAILABLE'
  AND fgl."availableQty" > 0
  AND fgl."reservedQty" = 0
  -- Only for orders that are still live: a cancelled or rejected order has no claim on stock.
  AND o."status" NOT IN ('Cancelled', 'Rejected')
  -- Only where the order item still wants coffee.
  AND (oi."quantityKg" - oi."deliveredQty") > 0
  -- Never double-claim a lot that somehow already has an allocation.
  AND NOT EXISTS (
      SELECT 1 FROM "StockAllocation" sa
       WHERE sa."finishedGoodsLotId" = fgl."id" AND sa."status" = 'RESERVED'
  );

-- Bring the denormalised counter on the lot in line with the rows just written. Written as a
-- full recompute from StockAllocation rather than an increment, so the column ends up correct
-- no matter how many times this migration is replayed.
UPDATE "FinishedGoodsLot" fgl
   SET "reservedQty" = COALESCE(agg."total", 0)
  FROM (
        SELECT sa."finishedGoodsLotId" AS "lotId", SUM(sa."quantityKg") AS "total"
          FROM "StockAllocation" sa
         WHERE sa."status" = 'RESERVED'
         GROUP BY sa."finishedGoodsLotId"
       ) agg
 WHERE agg."lotId" = fgl."id"
   AND fgl."reservedQty" IS DISTINCT FROM COALESCE(agg."total", 0);
