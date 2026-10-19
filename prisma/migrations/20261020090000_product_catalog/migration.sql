-- Product catalog (Figma 216:2 «المنتجات»: 256:3410, 258:3751, 260:4107, 262:4570, 276:4776;
-- docs/design/direction-2.1-rc/CATALOG-BACKEND.md, owner decisions D2–D5).
-- ADDITIVE ONLY: one new table "CatalogCategory"; on "CoffeeProduct" a NULLABLE "categoryId" (no
-- default) and "isActive" BOOLEAN NOT NULL DEFAULT true (a constant default: metadata-only on
-- PostgreSQL 11+, no row is rewritten, every existing product reads active); on "ProductSKU" a
-- NULLABLE "barcode" (no default) with a UNIQUE index (every existing row is NULL, so nothing can
-- collide); four more indexes and one foreign key ("CoffeeProduct"."categoryId" -> "CatalogCategory",
-- ON DELETE RESTRICT) that only NULL / new values reference. Nothing is dropped, renamed, retyped,
-- made NOT NULL or back-filled.
-- Atomic: the whole file runs in one transaction. The three CREATE INDEX on existing tables take a
-- SHARE lock on "CoffeeProduct" / "ProductSKU" for the time of the build (both small catalog
-- tables). Rollback: docs/hr/migration-review/rollback-20261020090000_product_catalog.sql.
BEGIN;

-- AlterTable
ALTER TABLE "CoffeeProduct" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ProductSKU" ADD COLUMN     "barcode" TEXT;

-- CreateTable
CREATE TABLE "CatalogCategory" (
    "id" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalogCategory_nameAr_key" ON "CatalogCategory"("nameAr");

-- CreateIndex
CREATE INDEX "CatalogCategory_isActive_sortOrder_idx" ON "CatalogCategory"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "CoffeeProduct_categoryId_idx" ON "CoffeeProduct"("categoryId");

-- CreateIndex
CREATE INDEX "CoffeeProduct_isActive_idx" ON "CoffeeProduct"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSKU_barcode_key" ON "ProductSKU"("barcode");

-- AddForeignKey
ALTER TABLE "CoffeeProduct" ADD CONSTRAINT "CoffeeProduct_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CatalogCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
