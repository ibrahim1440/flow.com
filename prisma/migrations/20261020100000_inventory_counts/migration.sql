-- Inventory count sessions («الجرد والتسويات», Figma 216:2 / 278:4772; batch "Inventory & products",
-- track B). ADDITIVE ONLY: one new enum "InventoryCountStatus", two new tables
-- "InventoryCountSession" / "InventoryCountLine" (with their SERIAL sequence, indexes, one FK
-- between them and three CHECKs on the new table), and ONE new index on the existing
-- "InventoryMovement" (sourceDocType, sourceDocId). Nothing existing is dropped, renamed, retyped,
-- made NOT NULL or back-filled; no existing row is read or written.
--   InventoryCountSession: number (SERIAL, unique), status OPEN | POSTED | CANCELLED, who / when.
--   InventoryCountLine: one counted item (GreenBean or MaterialItem) per session, the system
--   balance at the count, the counted quantity and — once posted — the booked variance and the
--   InventoryMovement it produced. Stock itself still moves only through InventoryMovement and the
--   balance columns, written by the existing adjustment service.
-- Atomic: the whole file runs in one transaction. The CREATE INDEX on "InventoryMovement" takes a
-- SHARE lock on that table for the time of the build (writes to the ledger wait; reads do not).
-- Rollback: docs/hr/migration-review/rollback-20261020100000_inventory_counts.sql.
BEGIN;

-- CreateEnum
CREATE TYPE "InventoryCountStatus" AS ENUM ('OPEN', 'POSTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "InventoryCountSession" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "status" "InventoryCountStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "postedById" TEXT,
    "postReason" TEXT,
    "postedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCountSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCountLine" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "category" "InventoryCategory" NOT NULL,
    "entityId" TEXT NOT NULL,
    "systemQty" DOUBLE PRECISION NOT NULL,
    "countedQty" DOUBLE PRECISION,
    "countedAt" TIMESTAMP(3),
    "countedById" TEXT,
    "notes" TEXT,
    "postedPreviousQty" DOUBLE PRECISION,
    "postedNewQty" DOUBLE PRECISION,
    "postedVariance" DOUBLE PRECISION,
    "movementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCountLine_pkey" PRIMARY KEY ("id"),
    -- Only the two stock kinds a person can count: green coffee (kg) and packaging material.
    CONSTRAINT "InventoryCountLine_category_check" CHECK ("category" IN ('RAW_MATERIAL', 'PACKAGING_MATERIAL')),
    -- A count is a non-negative, finite quantity (JSON 1e309 would otherwise arrive as Infinity).
    CONSTRAINT "InventoryCountLine_countedQty_check" CHECK ("countedQty" IS NULL OR ("countedQty" >= 0 AND "countedQty" < 'Infinity'::float8)),
    CONSTRAINT "InventoryCountLine_systemQty_check" CHECK ("systemQty" > '-Infinity'::float8 AND "systemQty" < 'Infinity'::float8)
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCountSession_number_key" ON "InventoryCountSession"("number");

-- CreateIndex
CREATE INDEX "InventoryCountSession_status_createdAt_idx" ON "InventoryCountSession"("status", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryCountLine_category_entityId_idx" ON "InventoryCountLine"("category", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCountLine_sessionId_category_entityId_key" ON "InventoryCountLine"("sessionId", "category", "entityId");

-- CreateIndex (existing table, additive)
CREATE INDEX "InventoryMovement_sourceDocType_sourceDocId_idx" ON "InventoryMovement"("sourceDocType", "sourceDocId");

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InventoryCountSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
