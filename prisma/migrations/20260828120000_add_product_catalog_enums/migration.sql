-- New values on two EXISTING enums, isolated in their own migration.
--
-- PostgreSQL will not let a value added by ALTER TYPE ... ADD VALUE be *used* in the
-- same transaction that added it, and Prisma runs each migration file in one
-- transaction. Keeping these four statements in a migration of their own guarantees
-- they are committed before 20260828120100 creates the columns and rows that reference
-- them. Splitting on that boundary is the documented workaround, not a stylistic choice.
--
-- Additive only: adding a value to an enum cannot invalidate an existing row.

-- Inventory now has two stages between raw material and finished goods.
ALTER TYPE "InventoryCategory" ADD VALUE 'ROASTED_COFFEE';
ALTER TYPE "InventoryCategory" ADD VALUE 'PACKAGING_MATERIAL';

-- Ledger rows written when packaging draws a SKU's bill of materials, and when a
-- production order consumes stock.
ALTER TYPE "SourceDocType" ADD VALUE 'BOM_CONSUMPTION';
ALTER TYPE "SourceDocType" ADD VALUE 'PRODUCTION_ORDER';
