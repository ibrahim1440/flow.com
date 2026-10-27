-- Unified inventory, phase 1: user-defined item categories. ADDITIVE ONLY, one transaction.
--   * "UnitOfMeasure" + 'LITER' (milk). PostgreSQL 16 accepts ALTER TYPE … ADD VALUE inside a transaction
--     block as long as the new value is not USED before COMMIT: nothing below uses it as an enum value —
--     "ItemCategory"."defaultUnit" is TEXT (CHECK on the unit names), so the milk category is seeded 'LITER'
--     as text.
--   * "ItemCategory" (new, seeded): a root («المحمصة», «المقهى», «المنتجات الجاهزة») and its children, at most
--     two levels (trigger item_category_guard). template → inventoryRole is fixed 1:1 (CHECK), and template,
--     inventoryRole and legacyMaterialCategory never change after creation (same trigger); the seeded system
--     rows (green, roasted, finished) are never re-parented, archived or deleted. One active name per parent
--     (partial unique index). A category says what the stock is, never where it is.
--   * "MaterialItem"."categoryId" (nullable, FK RESTRICT) back-filled from the legacy enum
--     (PACKAGING → أكياس وتغليف, LABEL → ملصقات, CONSUMABLE / OTHER → المحمصة › أخرى), so every existing material
--     keeps its cost role (INVENTORY_PACKAGING / INVENTORY_CAFE exactly as cost-ledger.ts derived it).
--     Trigger material_item_category_sync keeps "category" (the enum every consumer reads) in step with it,
--     fills "categoryId" when a writer omits it, and REFUSES a move to a category of another inventory role
--     once the item has stock or a cost-ledger holder ("CostItem").
--   * "SettingsAuditLog_action_check" WIDENED by the five CATEGORY_* actions (every row it accepted before it
--     still accepts).
--   * The runtime role (flowcom_app), when it exists, is granted the new table (scripts/release/
--     grant-app-runtime.sql grants it again on every deploy).
-- Row counts touched: every "MaterialItem" row once (the back-fill), 12 "ItemCategory" rows inserted.
-- Rollback: docs/hr/migration-review/rollback-20261112090000_item_categories.sql.
BEGIN;

ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'LITER';

CREATE TABLE "ItemCategory" (
    "id" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "parentId" TEXT,
    "template" TEXT NOT NULL,
    "defaultUnit" TEXT NOT NULL DEFAULT 'PIECE',
    "inventoryRole" TEXT NOT NULL,
    "legacyMaterialCategory" "MaterialCategory",
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemCategory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ItemCategory_template_check" CHECK ("template" IN ('GREEN_COFFEE', 'ROASTED_COFFEE', 'FINISHED', 'PACKAGING', 'GENERAL')),
    CONSTRAINT "ItemCategory_inventoryRole_check" CHECK ("inventoryRole" IN ('INVENTORY_GREEN', 'INVENTORY_PACKAGING', 'INVENTORY_CAFE', 'INVENTORY_ROASTED', 'INVENTORY_PACKED')),
    CONSTRAINT "ItemCategory_defaultUnit_check" CHECK ("defaultUnit" IN ('UNIT', 'KG', 'GRAM', 'PIECE', 'LITER')),
    CONSTRAINT "ItemCategory_role_matches_template" CHECK (
         ("template" = 'GREEN_COFFEE'   AND "inventoryRole" = 'INVENTORY_GREEN'     AND "legacyMaterialCategory" IS NULL)
      OR ("template" = 'ROASTED_COFFEE' AND "inventoryRole" = 'INVENTORY_ROASTED'   AND "legacyMaterialCategory" IS NULL)
      OR ("template" = 'FINISHED'       AND "inventoryRole" = 'INVENTORY_PACKED'    AND "legacyMaterialCategory" IS NULL)
      OR ("template" = 'PACKAGING'      AND "inventoryRole" = 'INVENTORY_PACKAGING' AND "legacyMaterialCategory" IN ('PACKAGING', 'LABEL'))
      OR ("template" = 'GENERAL'        AND "inventoryRole" = 'INVENTORY_CAFE'      AND "legacyMaterialCategory" IN ('CONSUMABLE', 'OTHER'))),
    CONSTRAINT "ItemCategory_nameAr_check" CHECK (char_length(btrim("nameAr")) BETWEEN 1 AND 80),
    CONSTRAINT "ItemCategory_nameEn_check" CHECK ("nameEn" IS NULL OR char_length(btrim("nameEn")) BETWEEN 1 AND 80),
    CONSTRAINT "ItemCategory_archived_check" CHECK ("isActive" = ("archivedAt" IS NULL)),
    CONSTRAINT "ItemCategory_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id")
);

CREATE INDEX "ItemCategory_parentId_sortOrder_idx" ON "ItemCategory"("parentId", "sortOrder");
-- One ACTIVE category of a name under one parent (roots share the parent ''); archived names may repeat.
CREATE UNIQUE INDEX "ItemCategory_active_name_key" ON "ItemCategory" (COALESCE("parentId", ''), lower(btrim("nameAr"))) WHERE "archivedAt" IS NULL;

ALTER TABLE "ItemCategory" ADD CONSTRAINT "ItemCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ItemCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Two levels at most; children never under a view-only root; the category's nature is fixed at creation;
-- the seeded system categories are renamed or reordered only.
CREATE OR REPLACE FUNCTION item_category_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "ItemCategory"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."isSystem" THEN
      RAISE EXCEPTION 'ITEM_CATEGORY_SYSTEM: a system category is never deleted (%)', OLD."id" USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."template" IS DISTINCT FROM OLD."template" OR NEW."inventoryRole" IS DISTINCT FROM OLD."inventoryRole"
       OR NEW."legacyMaterialCategory" IS DISTINCT FROM OLD."legacyMaterialCategory" THEN
      RAISE EXCEPTION 'ITEM_CATEGORY_FIXED: a category''s template and inventory role never change (%)', OLD."id" USING ERRCODE = 'P0001';
    END IF;
    IF OLD."isSystem" AND (NEW."isSystem" IS DISTINCT FROM OLD."isSystem" OR NEW."parentId" IS DISTINCT FROM OLD."parentId" OR NEW."archivedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'ITEM_CATEGORY_SYSTEM: a system category is only renamed or reordered (%)', OLD."id" USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW."parentId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."parentId" IS DISTINCT FROM OLD."parentId") THEN
    SELECT * INTO p FROM "ItemCategory" WHERE "id" = NEW."parentId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ITEM_CATEGORY_PARENT: parent category % does not exist', NEW."parentId" USING ERRCODE = 'P0001';
    END IF;
    IF p."parentId" IS NOT NULL THEN
      RAISE EXCEPTION 'ITEM_CATEGORY_DEPTH: categories are at most two levels deep (% is already a sub-category)', p."id" USING ERRCODE = 'P0001';
    END IF;
    IF p."template" IN ('GREEN_COFFEE', 'ROASTED_COFFEE', 'FINISHED') THEN
      RAISE EXCEPTION 'ITEM_CATEGORY_PARENT_VIEW_ONLY: % holds no sub-categories', p."id" USING ERRCODE = 'P0001';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM "ItemCategory" c WHERE c."parentId" = NEW."id") THEN
      RAISE EXCEPTION 'ITEM_CATEGORY_DEPTH: % has sub-categories and cannot become one', NEW."id" USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "ItemCategory_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ItemCategory"
  FOR EACH ROW EXECUTE FUNCTION item_category_guard();

-- The seed (deterministic ids; idempotent). No enum value added above is used here.
INSERT INTO "ItemCategory" ("id", "nameAr", "nameEn", "parentId", "template", "defaultUnit", "inventoryRole", "legacyMaterialCategory", "isSystem", "sortOrder", "updatedByName", "updatedAt") VALUES
  ('cat_roastery',         'المحمصة',                  'Roastery',                   NULL,           'PACKAGING',      'PIECE', 'INVENTORY_PACKAGING', 'PACKAGING',  false, 1, 'migration', now()),
  ('cat_cafe',             'المقهى',                   'Café',                       NULL,           'GENERAL',        'PIECE', 'INVENTORY_CAFE',      'CONSUMABLE', false, 2, 'migration', now()),
  ('cat_finished',         'المنتجات الجاهزة',         'Finished products',          NULL,           'FINISHED',       'UNIT',  'INVENTORY_PACKED',    NULL,         true,  3, 'migration', now()),
  ('cat_roastery_green',   'بن أخضر',                  'Green coffee',               'cat_roastery', 'GREEN_COFFEE',   'KG',    'INVENTORY_GREEN',     NULL,         true,  1, 'migration', now()),
  ('cat_roastery_roasted', 'بن محمص',                  'Roasted coffee',             'cat_roastery', 'ROASTED_COFFEE', 'KG',    'INVENTORY_ROASTED',   NULL,         true,  2, 'migration', now()),
  ('cat_roastery_bags',    'أكياس وتغليف',             'Bags and packaging',         'cat_roastery', 'PACKAGING',      'PIECE', 'INVENTORY_PACKAGING', 'PACKAGING',  false, 3, 'migration', now()),
  ('cat_roastery_labels',  'ملصقات',                   'Labels',                     'cat_roastery', 'PACKAGING',      'PIECE', 'INVENTORY_PACKAGING', 'LABEL',      false, 4, 'migration', now()),
  ('cat_roastery_other',   'أخرى',                     'Other',                      'cat_roastery', 'GENERAL',        'PIECE', 'INVENTORY_CAFE',      'OTHER',      false, 5, 'migration', now()),
  ('cat_cafe_dairy',       'حليب وألبان',              'Milk and dairy',             'cat_cafe',     'GENERAL',        'LITER', 'INVENTORY_CAFE',      'CONSUMABLE', false, 1, 'migration', now()),
  ('cat_cafe_sweets',      'حلويات',                   'Sweets',                     'cat_cafe',     'GENERAL',        'PIECE', 'INVENTORY_CAFE',      'CONSUMABLE', false, 2, 'migration', now()),
  ('cat_cafe_cups',        'أكواب ومستلزمات التقديم',  'Cups and serving supplies',  'cat_cafe',     'GENERAL',        'PIECE', 'INVENTORY_CAFE',      'CONSUMABLE', false, 3, 'migration', now()),
  ('cat_cafe_sugar',       'سكر ومحليات',              'Sugar and sweeteners',       'cat_cafe',     'GENERAL',        'KG',    'INVENTORY_CAFE',      'CONSUMABLE', false, 4, 'migration', now())
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "MaterialItem" ADD COLUMN "categoryId" TEXT;
CREATE INDEX "MaterialItem_categoryId_idx" ON "MaterialItem"("categoryId");
ALTER TABLE "MaterialItem" ADD CONSTRAINT "MaterialItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ItemCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Back-fill: every existing material by its legacy enum (deterministic, idempotent).
UPDATE "MaterialItem" SET "categoryId" = CASE "category"
    WHEN 'PACKAGING' THEN 'cat_roastery_bags'
    WHEN 'LABEL' THEN 'cat_roastery_labels'
    ELSE 'cat_roastery_other' END
  WHERE "categoryId" IS NULL;

-- Keeps the legacy enum in step with the category (and the category with a legacy-only write), and refuses a
-- change of inventory role once the item carries stock or cost.
CREATE OR REPLACE FUNCTION material_item_category_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c "ItemCategory"%ROWTYPE;
        old_role text;
        def text;
BEGIN
  def := CASE NEW."category" WHEN 'PACKAGING' THEN 'cat_roastery_bags' WHEN 'LABEL' THEN 'cat_roastery_labels' ELSE 'cat_roastery_other' END;
  IF NEW."categoryId" IS NULL THEN
    NEW."categoryId" := def;
  ELSIF TG_OP = 'UPDATE' AND NEW."categoryId" IS NOT DISTINCT FROM OLD."categoryId" AND NEW."category" IS DISTINCT FROM OLD."category" THEN
    -- A writer that only knows the enum moved the item to another inventory role: follow it to that enum's
    -- default category (a change within one role — CONSUMABLE ↔ OTHER — keeps the category).
    IF (SELECT "inventoryRole" FROM "ItemCategory" WHERE "id" = NEW."categoryId")
       IS DISTINCT FROM (CASE WHEN NEW."category" IN ('CONSUMABLE', 'OTHER') THEN 'INVENTORY_CAFE' ELSE 'INVENTORY_PACKAGING' END) THEN
      NEW."categoryId" := def;
    ELSIF NEW."category" IN ('PACKAGING', 'LABEL') THEN
      NEW."categoryId" := def;
    END IF;
  END IF;
  SELECT * INTO c FROM "ItemCategory" WHERE "id" = NEW."categoryId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_CATEGORY_PARENT: category % does not exist', NEW."categoryId" USING ERRCODE = 'P0001';
  END IF;
  IF c."legacyMaterialCategory" IS NULL THEN
    RAISE EXCEPTION 'ITEM_CATEGORY_NOT_MATERIAL: category % holds no stock items of this kind', c."id" USING ERRCODE = 'P0001';
  END IF;
  -- The enum follows the category; CONSUMABLE and OTHER (one role, one meaning to every consumer) are kept
  -- as written, so a back-filled CONSUMABLE material is not rewritten by an unrelated update.
  IF NOT (c."legacyMaterialCategory" IN ('CONSUMABLE', 'OTHER') AND NEW."category" IN ('CONSUMABLE', 'OTHER')) THEN
    NEW."category" := c."legacyMaterialCategory";
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."categoryId" IS DISTINCT FROM OLD."categoryId" THEN
    SELECT "inventoryRole" INTO old_role FROM "ItemCategory" WHERE "id" = OLD."categoryId";
    IF old_role IS NULL THEN
      old_role := CASE WHEN OLD."category" IN ('CONSUMABLE', 'OTHER') THEN 'INVENTORY_CAFE' ELSE 'INVENTORY_PACKAGING' END;
    END IF;
    IF old_role <> c."inventoryRole" AND (OLD."quantityOnHand" <> 0 OR NEW."quantityOnHand" <> 0
         OR EXISTS (SELECT 1 FROM "CostItem" ci WHERE ci."kind" = 'MATERIAL' AND ci."entityId" = OLD."id")) THEN
      RAISE EXCEPTION 'ITEM_CATEGORY_ROLE_CHANGE: material % has stock or cost under %; moving it to % needs a stock transfer', OLD."id", old_role, c."inventoryRole" USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "MaterialItem_category_sync" BEFORE INSERT OR UPDATE OF "category", "categoryId" ON "MaterialItem"
  FOR EACH ROW EXECUTE FUNCTION material_item_category_sync();

ALTER TABLE "SettingsAuditLog" DROP CONSTRAINT "SettingsAuditLog_action_check";
ALTER TABLE "SettingsAuditLog" ADD CONSTRAINT "SettingsAuditLog_action_check" CHECK ("action" IN ('SETTINGS_UPDATED', 'ROASTER_CREATED', 'ROASTER_UPDATED',
  'ROASTER_STATUS_CHANGED', 'MAINTENANCE_CREATED', 'MAINTENANCE_UPDATED', 'OPERATOR_ASSIGNED', 'OPERATOR_UNASSIGNED',
  'ORDER_STATUS_RECOMPUTED', 'CATEGORY_CREATED', 'CATEGORY_UPDATED', 'CATEGORY_REORDERED', 'CATEGORY_ARCHIVED', 'CATEGORY_RESTORED'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ItemCategory" TO flowcom_app;
    GRANT EXECUTE ON FUNCTION item_category_guard(), material_item_category_sync() TO flowcom_app;
  END IF;
END $$;

COMMIT;
