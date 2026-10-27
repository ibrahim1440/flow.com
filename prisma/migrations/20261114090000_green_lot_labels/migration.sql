-- Green-coffee lot labels with barcodes, and scanning («ملصق اللوت» · «امسح الباركود»). ADDITIVE ONLY, one transaction
-- (PostgreSQL 16 / 17; no enum value is added, nothing here needs to run outside a transaction block).
--
--   1. A short, stable, scanner-friendly label code per green lot and per stock material — the payload of the Code 128
--      barcode on the label: "GreenBean"."labelCode" 'GL-00042' and "MaterialItem"."labelCode" 'MT-00007' (upper-case
--      Latin, digits and one hyphen: a keyboard-wedge scanner types it the same on an Arabic or an English keyboard
--      layout once the application maps the Arabic layout back; never a name, a price or a person). The serial number
--      stays what people write and search; it is free text, so it is not the barcode.
--      Two sequences ("GreenBean_labelCode_seq", "MaterialItem_labelCode_seq", MAXVALUE 99999: the code is always five
--      digits); every existing row is numbered once in creation order, the sequence continues after them, and the
--      column default takes the next number for every later row — whichever code path creates it (the lot form, the
--      one-step purchase invoice, the seed). NOT NULL, UNIQUE, and a CHECK of the exact shape.
--   2. Per-sack labels: "GreenBean"."sackCount" (1–999) and "sackWeightKg" (> 0, ≤ 1000; only with a sack count),
--      both nullable — «15 كيس × 69 كغ»; the per-sack label reads «كيس 3 من 15» from them, and a reprint of any sack
--      reads the same numbers.
--   3. "PrintTemplatePreset_template_values" WIDENED (DROP + ADD) by 'GREEN_LOT' and 'MATERIAL_SHELF': a preset of the
--      two new label templates can be saved. Every row the old CHECK accepted, the new one accepts.
--   4. The runtime role flowcom_app, when it exists, gets USAGE / SELECT on the two new sequences (the column defaults
--      call nextval as the inserting role), so inserts keep working between the deploy and the next run of
--      scripts/release/grant-app-runtime.sql (which grants every sequence anyway).
-- No trigger fires on the back-fill: "MaterialItem_category_sync" is UPDATE OF "category", "categoryId" only, and
-- "GreenBean" has none. Every statement stands on its own (the file is also applied statement by statement, BEGIN /
-- COMMIT stripped, through one outer transaction).
-- Rollback: docs/hr/migration-review/rollback-20261114090000_green_lot_labels.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE "GreenBean_labelCode_seq" AS integer MINVALUE 1 MAXVALUE 99999 NO CYCLE;
CREATE SEQUENCE "MaterialItem_labelCode_seq" AS integer MINVALUE 1 MAXVALUE 99999 NO CYCLE;

ALTER TABLE "GreenBean" ADD COLUMN "labelCode" TEXT;
UPDATE "GreenBean" g SET "labelCode" = 'GL-' || lpad(s.n::text, 5, '0')
  FROM (SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS n FROM "GreenBean") s WHERE g."id" = s."id";
SELECT setval('"GreenBean_labelCode_seq"', GREATEST((SELECT count(*) FROM "GreenBean"), 1), (SELECT count(*) FROM "GreenBean") > 0);
ALTER TABLE "GreenBean" ALTER COLUMN "labelCode" SET DEFAULT ('GL-'::text || lpad((nextval('"GreenBean_labelCode_seq"'::regclass))::text, 5, '0'::text));
ALTER TABLE "GreenBean" ALTER COLUMN "labelCode" SET NOT NULL;
ALTER SEQUENCE "GreenBean_labelCode_seq" OWNED BY "GreenBean"."labelCode";
CREATE UNIQUE INDEX "GreenBean_labelCode_key" ON "GreenBean"("labelCode");
ALTER TABLE "GreenBean" ADD CONSTRAINT "GreenBean_labelCode_check" CHECK ("labelCode" ~ '^GL-[0-9]{5}$');

ALTER TABLE "MaterialItem" ADD COLUMN "labelCode" TEXT;
UPDATE "MaterialItem" m SET "labelCode" = 'MT-' || lpad(s.n::text, 5, '0')
  FROM (SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS n FROM "MaterialItem") s WHERE m."id" = s."id";
SELECT setval('"MaterialItem_labelCode_seq"', GREATEST((SELECT count(*) FROM "MaterialItem"), 1), (SELECT count(*) FROM "MaterialItem") > 0);
ALTER TABLE "MaterialItem" ALTER COLUMN "labelCode" SET DEFAULT ('MT-'::text || lpad((nextval('"MaterialItem_labelCode_seq"'::regclass))::text, 5, '0'::text));
ALTER TABLE "MaterialItem" ALTER COLUMN "labelCode" SET NOT NULL;
ALTER SEQUENCE "MaterialItem_labelCode_seq" OWNED BY "MaterialItem"."labelCode";
CREATE UNIQUE INDEX "MaterialItem_labelCode_key" ON "MaterialItem"("labelCode");
ALTER TABLE "MaterialItem" ADD CONSTRAINT "MaterialItem_labelCode_check" CHECK ("labelCode" ~ '^MT-[0-9]{5}$');

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "GreenBean" ADD COLUMN "sackCount" INTEGER;
ALTER TABLE "GreenBean" ADD COLUMN "sackWeightKg" DOUBLE PRECISION;
ALTER TABLE "GreenBean" ADD CONSTRAINT "GreenBean_sacks_check" CHECK (
  ("sackCount" IS NULL OR "sackCount" BETWEEN 1 AND 999)
  AND ("sackWeightKg" IS NULL OR ("sackWeightKg" > 0 AND "sackWeightKg" <= 1000 AND "sackCount" IS NOT NULL)));

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "PrintTemplatePreset" DROP CONSTRAINT "PrintTemplatePreset_template_values";
ALTER TABLE "PrintTemplatePreset" ADD CONSTRAINT "PrintTemplatePreset_template_values"
  CHECK ("templateKey" IN ('COFFEE_ORIGIN', 'CUPPING_RESULTS', 'GREEN_LOT', 'MATERIAL_SHELF'));

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT USAGE, SELECT ON SEQUENCE "GreenBean_labelCode_seq", "MaterialItem_labelCode_seq" TO flowcom_app;
  END IF;
END $$;

COMMIT;
