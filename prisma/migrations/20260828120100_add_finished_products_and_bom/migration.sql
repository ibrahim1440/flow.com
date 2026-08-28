-- Finished Products (SKU-based selling), bills of materials, stocked packaging
-- materials, and the roasted/intermediate stock stage that sits between roasting and
-- packaging.
--
-- ADDITIVE ONLY. No column is dropped, no row is deleted, and no existing balance is
-- rewritten. The one UPDATE in this file seeds a new column on RoastingBatch from data
-- the row already carries.
--
-- The chain this establishes, and which the CHECK constraints below defend:
--   GreenBean (kg) -> Roasting -> roasted stock (kg) -> Packaging/BOM -> FinishedGoodsLot
--   (units) -> StockAllocation (units) -> Delivery (units)
-- Green coffee is consumed by roasting alone. A finished SKU's BOM draws on roasted
-- stock and packaging materials, never on green beans.

-- ─── New enums ───────────────────────────────────────────────────────────────
-- CREATE TYPE (unlike ALTER TYPE ... ADD VALUE) is usable in the same transaction,
-- so these stay here with the tables that use them.

CREATE TYPE "ProductCategory" AS ENUM ('ROASTED_COFFEE', 'GREEN_COFFEE', 'MERCHANDISE', 'OTHER');
CREATE TYPE "UnitOfMeasure" AS ENUM ('UNIT', 'KG', 'GRAM', 'PIECE');
CREATE TYPE "MaterialCategory" AS ENUM ('PACKAGING', 'LABEL', 'CONSUMABLE', 'OTHER');
CREATE TYPE "BomComponentType" AS ENUM ('ROASTED_COFFEE', 'MATERIAL');

-- ─── Finished Products catalog ───────────────────────────────────────────────
-- ProductSKU was already "one row = one sellable SKU"; it only lacked the catalog
-- fields. Existing SKUs keep working: name is nullable and falls back to the coffee
-- product's name plus pack size, and every new column has a default.

ALTER TABLE "ProductSKU"
    ADD COLUMN "name"          TEXT,
    ADD COLUMN "nameAr"        TEXT,
    ADD COLUMN "category"      "ProductCategory" NOT NULL DEFAULT 'ROASTED_COFFEE',
    ADD COLUMN "unitOfMeasure" "UnitOfMeasure"   NOT NULL DEFAULT 'UNIT',
    ADD COLUMN "isActive"      BOOLEAN           NOT NULL DEFAULT true;

CREATE INDEX "ProductSKU_isActive_idx" ON "ProductSKU"("isActive");
CREATE INDEX "ProductSKU_category_isActive_idx" ON "ProductSKU"("category", "isActive");

-- ─── Stocked packaging materials ─────────────────────────────────────────────
-- Bags, labels and cartons had no inventory model at all: PurchaseType.PACKAGING
-- recorded the cost of buying them and nothing recorded holding them. A BOM component
-- has to point at something real, so this is that something.

CREATE TABLE "MaterialItem" (
    "id"             TEXT NOT NULL,
    "code"           TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "nameAr"         TEXT,
    "category"       "MaterialCategory" NOT NULL DEFAULT 'PACKAGING',
    "unitOfMeasure"  "UnitOfMeasure"    NOT NULL DEFAULT 'PIECE',
    "quantityOnHand" DOUBLE PRECISION   NOT NULL DEFAULT 0,
    "reorderPoint"   DOUBLE PRECISION   NOT NULL DEFAULT 0,
    "isActive"       BOOLEAN            NOT NULL DEFAULT true,
    "notes"          TEXT,
    "createdAt"      TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3)       NOT NULL,

    CONSTRAINT "MaterialItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MaterialItem_code_key" ON "MaterialItem"("code");
CREATE INDEX "MaterialItem_isActive_idx" ON "MaterialItem"("isActive");
CREATE INDEX "MaterialItem_category_isActive_idx" ON "MaterialItem"("category", "isActive");

-- Typed link so buying packaging can restock the item rather than only booking cost.
-- The pre-existing untyped PurchaseRecord."itemId" is left exactly as it is.
ALTER TABLE "PurchaseRecord" ADD COLUMN "materialItemId" TEXT;
CREATE INDEX "PurchaseRecord_materialItemId_idx" ON "PurchaseRecord"("materialItemId");
ALTER TABLE "PurchaseRecord" ADD CONSTRAINT "PurchaseRecord_materialItemId_fkey"
    FOREIGN KEY ("materialItemId") REFERENCES "MaterialItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Bill of materials ───────────────────────────────────────────────────────

CREATE TABLE "BomComponent" (
    "id"              TEXT NOT NULL,
    "productSkuId"    TEXT NOT NULL,
    "type"            "BomComponentType" NOT NULL,
    "coffeeProductId" TEXT,
    "materialItemId"  TEXT,
    "quantityPerUnit" DOUBLE PRECISION   NOT NULL,
    "unitOfMeasure"   "UnitOfMeasure"    NOT NULL,
    "notes"           TEXT,
    "createdAt"       TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3)       NOT NULL,

    CONSTRAINT "BomComponent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BomComponent_productSkuId_idx" ON "BomComponent"("productSkuId");
CREATE INDEX "BomComponent_materialItemId_idx" ON "BomComponent"("materialItemId");
CREATE INDEX "BomComponent_coffeeProductId_idx" ON "BomComponent"("coffeeProductId");

ALTER TABLE "BomComponent" ADD CONSTRAINT "BomComponent_productSkuId_fkey"
    FOREIGN KEY ("productSkuId") REFERENCES "ProductSKU"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BomComponent" ADD CONSTRAINT "BomComponent_coffeeProductId_fkey"
    FOREIGN KEY ("coffeeProductId") REFERENCES "CoffeeProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BomComponent" ADD CONSTRAINT "BomComponent_materialItemId_fkey"
    FOREIGN KEY ("materialItemId") REFERENCES "MaterialItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Roasted / intermediate stock ────────────────────────────────────────────
-- The stage that did not exist: packaging used to turn a batch straight into finished
-- goods, so there was no point at which roasted coffee was a balance a BOM could draw
-- on. The RoastingBatch itself is that lot — no parallel table, no duplicated identity.

ALTER TABLE "RoastingBatch" ADD COLUMN "roastedAvailableKg" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Seed from what each batch already records, so no historical batch presents coffee it
-- has already packed, sampled or blended away as still being available.
--   roasted output - packed into bags - taken as samples - consumed by blends
-- GREATEST(...,0) guards the handful of legacy rows whose packed weight exceeds their
-- recorded roast output; those simply seed at zero rather than going negative.
UPDATE "RoastingBatch" rb
   SET "roastedAvailableKg" = GREATEST(
        0,
        COALESCE(rb."roastedBeanQuantity", 0)
      - ( COALESCE(rb."bags3kg",  0) * 3.0
        + COALESCE(rb."bags1kg",  0) * 1.0
        + COALESCE(rb."bags250g", 0) * 0.25
        + COALESCE(rb."bags150g", 0) * 0.15 )
      - COALESCE(rb."samplesGrams", 0) / 1000.0
      - COALESCE((
            SELECT SUM(bi."quantityUsed")
              FROM "BlendIngredient" bi
             WHERE bi."sourceBatchId" = rb."id"
        ), 0)
   );

-- ─── Unit-native finished goods ──────────────────────────────────────────────
-- Units become the single source of truth for SKU-tracked lots. `isUnitTracked` is a
-- discriminator, NOT a second copy of the same balance: a lot is either unit-tracked
-- (units* authoritative, availableQty/reservedQty stay 0) or a legacy kg lot
-- (availableQty/reservedQty authoritative, units* stay 0).
--
-- Every existing lot defaults to isUnitTracked = false and is left untouched. They
-- cannot be converted honestly — 8.45 kg against a 1 KG SKU is not a whole number of
-- bags — so they keep serving the legacy bean-based order lines in kilograms.

ALTER TABLE "FinishedGoodsLot"
    ADD COLUMN "isUnitTracked"  BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "unitsProduced"  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "unitsAvailable" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "unitsReserved"  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "FinishedGoodsLot_productSkuId_status_idx" ON "FinishedGoodsLot"("productSkuId", "status");
CREATE INDEX "FinishedGoodsLot_isUnitTracked_status_idx" ON "FinishedGoodsLot"("isUnitTracked", "status");

ALTER TABLE "StockAllocation" ADD COLUMN "quantityUnits" INTEGER;

ALTER TABLE "OrderItem"
    ADD COLUMN "quantityUnits"  INTEGER,
    ADD COLUMN "deliveredUnits" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "OrderItem_productSkuId_idx" ON "OrderItem"("productSkuId");

ALTER TABLE "Delivery" ADD COLUMN "quantityUnits" INTEGER;

-- ─── Invariants ──────────────────────────────────────────────────────────────
-- Following the precedent in docs/migration-drift-and-db-constraints.md and the two
-- constraints added by 20260826090000: the balance rules that must never be violated
-- are enforced by the database, not only by route code.

-- Packaging material stock can never go negative.
ALTER TABLE "MaterialItem"
    ADD CONSTRAINT "MaterialItem_quantityOnHand_non_negative"
    CHECK ("quantityOnHand" >= 0);

-- A BOM line always consumes a positive amount.
ALTER TABLE "BomComponent"
    ADD CONSTRAINT "BomComponent_quantityPerUnit_positive"
    CHECK ("quantityPerUnit" > 0);

-- A BOM line points at exactly one thing, and the thing matches its type. This is what
-- keeps "roasted coffee components never reference green beans" true at the storage
-- layer rather than by convention.
ALTER TABLE "BomComponent"
    ADD CONSTRAINT "BomComponent_exactly_one_target"
    CHECK (
        ("type" = 'ROASTED_COFFEE' AND "coffeeProductId" IS NOT NULL AND "materialItemId" IS NULL)
     OR ("type" = 'MATERIAL'       AND "materialItemId"  IS NOT NULL AND "coffeeProductId" IS NULL)
    );

-- Roasted stock cannot go negative.
ALTER TABLE "RoastingBatch"
    ADD CONSTRAINT "RoastingBatch_roastedAvailableKg_non_negative"
    CHECK ("roastedAvailableKg" >= 0);

-- Unit balances stay ordered: reserved <= available <= produced, none negative.
ALTER TABLE "FinishedGoodsLot"
    ADD CONSTRAINT "FinishedGoodsLot_units_ordered"
    CHECK (
        "unitsProduced"  >= 0
    AND "unitsAvailable" >= 0
    AND "unitsReserved"  >= 0
    AND "unitsReserved"  <= "unitsAvailable"
    AND "unitsAvailable" <= "unitsProduced"
    );

-- Counting units is only meaningful when the pack size is known, so a unit-tracked lot
-- must name its SKU.
ALTER TABLE "FinishedGoodsLot"
    ADD CONSTRAINT "FinishedGoodsLot_unit_tracked_requires_sku"
    CHECK ("isUnitTracked" = false OR "productSkuId" IS NOT NULL);

-- Unit quantities, where present, are positive whole amounts.
ALTER TABLE "StockAllocation"
    ADD CONSTRAINT "StockAllocation_quantityUnits_positive"
    CHECK ("quantityUnits" IS NULL OR "quantityUnits" > 0);

ALTER TABLE "OrderItem"
    ADD CONSTRAINT "OrderItem_quantityUnits_positive"
    CHECK ("quantityUnits" IS NULL OR "quantityUnits" > 0);

ALTER TABLE "OrderItem"
    ADD CONSTRAINT "OrderItem_deliveredUnits_non_negative"
    CHECK ("deliveredUnits" >= 0);

ALTER TABLE "Delivery"
    ADD CONSTRAINT "Delivery_quantityUnits_positive"
    CHECK ("quantityUnits" IS NULL OR "quantityUnits" > 0);
