-- Workstations W4 — the packaging and order-preparation station (feat/station-w4).
-- Figma page 630:2, frames P1–P7; owner directions J-15 (manual lot entry), J-16 (staging place is
-- free text), J-18 (ready-for-dispatch handoff: per line, partial, idempotent) and D16 (no separate
-- dispatch station: the handoff, then the existing ERP dispatch page records the delivery).
--
-- ADDITIVE ONLY — three new, empty tables:
--   "PreparationPick"      one verified pick (units of one finished-goods lot reserved for one order
--                          line, the lot number checked at the station). PICKED → HANDED_OFF →
--                          DELIVERED (settled by POST /api/deliveries) | VOIDED. Moves no stock.
--   "DispatchHandoff"      «تسليم للشحن»: an order (or some of its lines) handed to the dispatch team,
--                          with the staging note, the parcels, who prepared it; requestKey UNIQUE
--                          (Idempotency-Key). Moves no stock and delivers nothing.
--   "DispatchHandoffLine"  one line's units in a handoff and the lots they came from.
-- Foreign keys from the new tables only: Order / OrderItem ON DELETE CASCADE (an order that may be
-- deleted takes its preparation records with it), DispatchHandoff SET NULL / CASCADE. No FK to
-- "FinishedGoodsLot" on purpose (the lot is named by id and number, the audit-table convention).
-- Nothing existing is altered, dropped, renamed or back-filled. The previous application version
-- never reads the new tables.
-- Atomic: the whole file runs in one transaction. Rollback:
-- docs/hr/migration-review/rollback-20261030100000_station_w4.sql.
BEGIN;

-- CreateTable
CREATE TABLE "PreparationPick" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "finishedGoodsLotId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PICKED',
    "handoffId" TEXT,
    "requestKey" TEXT NOT NULL,
    "pickedById" TEXT NOT NULL,
    "pickedByName" TEXT NOT NULL,
    "stationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "PreparationPick_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PreparationPick_units_check" CHECK ("units" > 0),
    CONSTRAINT "PreparationPick_status_check" CHECK ("status" IN ('PICKED', 'HANDED_OFF', 'DELIVERED', 'VOIDED'))
);

-- CreateTable
CREATE TABLE "DispatchHandoff" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "stagingNote" TEXT,
    "packages" INTEGER,
    "units" INTEGER NOT NULL,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "preparedById" TEXT NOT NULL,
    "preparedByName" TEXT NOT NULL,
    "stationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchHandoff_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DispatchHandoff_units_check" CHECK ("units" > 0),
    CONSTRAINT "DispatchHandoff_packages_check" CHECK ("packages" IS NULL OR "packages" BETWEEN 0 AND 999),
    CONSTRAINT "DispatchHandoff_stagingNote_check" CHECK ("stagingNote" IS NULL OR length("stagingNote") <= 120)
);

-- CreateTable
CREATE TABLE "DispatchHandoffLine" (
    "id" TEXT NOT NULL,
    "handoffId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "lots" JSONB NOT NULL,

    CONSTRAINT "DispatchHandoffLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DispatchHandoffLine_units_check" CHECK ("units" > 0)
);

-- CreateIndex
CREATE INDEX "PreparationPick_orderItemId_status_idx" ON "PreparationPick"("orderItemId", "status");

-- CreateIndex
CREATE INDEX "PreparationPick_orderId_status_idx" ON "PreparationPick"("orderId", "status");

-- CreateIndex
CREATE INDEX "PreparationPick_handoffId_idx" ON "PreparationPick"("handoffId");

-- CreateIndex
CREATE UNIQUE INDEX "PreparationPick_requestKey_finishedGoodsLotId_key" ON "PreparationPick"("requestKey", "finishedGoodsLotId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchHandoff_requestKey_key" ON "DispatchHandoff"("requestKey");

-- CreateIndex
CREATE INDEX "DispatchHandoff_orderId_createdAt_idx" ON "DispatchHandoff"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "DispatchHandoff_createdAt_idx" ON "DispatchHandoff"("createdAt");

-- CreateIndex
CREATE INDEX "DispatchHandoffLine_orderItemId_idx" ON "DispatchHandoffLine"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchHandoffLine_handoffId_orderItemId_key" ON "DispatchHandoffLine"("handoffId", "orderItemId");

-- AddForeignKey
ALTER TABLE "PreparationPick" ADD CONSTRAINT "PreparationPick_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreparationPick" ADD CONSTRAINT "PreparationPick_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreparationPick" ADD CONSTRAINT "PreparationPick_handoffId_fkey" FOREIGN KEY ("handoffId") REFERENCES "DispatchHandoff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchHandoff" ADD CONSTRAINT "DispatchHandoff_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchHandoffLine" ADD CONSTRAINT "DispatchHandoffLine_handoffId_fkey" FOREIGN KEY ("handoffId") REFERENCES "DispatchHandoff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchHandoffLine" ADD CONSTRAINT "DispatchHandoffLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
