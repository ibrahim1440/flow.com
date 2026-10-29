-- «الموقع» — the location dimension of the accountant workspace (BATCH22 WP-B; owner answer 7: Qoyod "projects" are used
-- as locations — المحمصة، المقهى). ADDITIVE ONLY, one transaction (PostgreSQL 16 / 17): nullable columns, foreign keys,
-- indexes, one CHECK, one guard trigger and a seed of branches for the existing sites. NULL means «غير محدد» everywhere.
--
--   Council ruling (BATCH22-DESIGN §WP-B): the dimension posted and reported is the existing ledger dimension
--   "JournalEntryLine"."branchId" → "FinBranch", labelled «الموقع». "StockLocation" stays the physical site and is mapped
--   to a branch (many sites → one branch; «في الطريق» / TRANSIT never). The location is set on the document HEADER and
--   the posting engine stamps it on every line of the document's entry (PostEntryInput.defaultBranchId); only a manual
--   journal keeps a per-line location.
--
--   1. "StockLocation"."finBranchId" → "FinBranch" (ON DELETE RESTRICT), NULL for type TRANSIT (CHECK
--      StockLocation_finBranch_transit_check).
--   2. "branchId" → "FinBranch" (ON DELETE RESTRICT), indexed, on "SalesInvoice", "Order", "SalesCollection",
--      "SupplierInvoice", "SupplierPayment". History stays NULL (nothing posted before go-live).
--   3. The location of a posted document is FROZEN (location_branch_frozen): "SalesCollection" once decided
--      (APPROVED / REJECTED / REVERSED), "SupplierInvoice" once POSTED / CANCELLED, "SupplierPayment" always (it is born
--      POSTED). An issued "SalesInvoice" is frozen already (sinv_invoice_guard compares the whole row). A change after
--      posting is a reclass journal.
--   4. Seed: every active non-TRANSIT site of type ROASTERY / CAFE / BRANCH, and the production site, gets the branch of
--      its own code — the existing "FinBranch" of that code, else a new one (id 'br_' || site id, code and names copied);
--      WAREHOUSE / OTHER sites take the production site's branch. A site already mapped is never changed. The owner
--      remaps on the locations page.
--   5. The runtime role (flowcom_app), when it exists, is granted the new function (no new table).
-- Rollback: docs/hr/migration-review/rollback-20261125090000_location_dimension.sql.
BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "StockLocation" ADD COLUMN "finBranchId" TEXT;
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_finBranchId_fkey"
  FOREIGN KEY ("finBranchId") REFERENCES "FinBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_finBranch_transit_check" CHECK ("type" <> 'TRANSIT' OR "finBranchId" IS NULL);
CREATE INDEX "StockLocation_finBranchId_idx" ON "StockLocation" ("finBranchId");

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SalesInvoice" ADD COLUMN "branchId" TEXT;
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "FinBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "SalesInvoice_branchId_idx" ON "SalesInvoice" ("branchId");

ALTER TABLE "Order" ADD COLUMN "branchId" TEXT;
ALTER TABLE "Order" ADD CONSTRAINT "Order_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "FinBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Order_branchId_idx" ON "Order" ("branchId");

ALTER TABLE "SalesCollection" ADD COLUMN "branchId" TEXT;
ALTER TABLE "SalesCollection" ADD CONSTRAINT "SalesCollection_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "FinBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "SalesCollection_branchId_idx" ON "SalesCollection" ("branchId");

ALTER TABLE "SupplierInvoice" ADD COLUMN "branchId" TEXT;
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "FinBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "SupplierInvoice_branchId_idx" ON "SupplierInvoice" ("branchId");

ALTER TABLE "SupplierPayment" ADD COLUMN "branchId" TEXT;
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "FinBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "SupplierPayment_branchId_idx" ON "SupplierPayment" ("branchId");

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION location_branch_frozen() RETURNS trigger AS $$
DECLARE final boolean;
BEGIN
  IF NEW."branchId" IS NOT DISTINCT FROM OLD."branchId" THEN RETURN NEW; END IF;
  -- The status is read as text on every table ("SalesCollection"."status" is an enum: a literal of another table's
  -- states must never be cast to it).
  final := CASE TG_TABLE_NAME
    WHEN 'SalesCollection' THEN OLD."status"::text IN ('APPROVED', 'REJECTED', 'REVERSED')
    WHEN 'SupplierInvoice' THEN OLD."status"::text IN ('POSTED', 'CANCELLED')
    WHEN 'SupplierPayment' THEN true
    ELSE false END;
  IF final THEN
    RAISE EXCEPTION 'LEDGER: the location of a posted document never changes (a reclass journal moves it)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER location_branch_frozen BEFORE UPDATE OF "branchId" ON "SalesCollection" FOR EACH ROW EXECUTE FUNCTION location_branch_frozen();
CREATE TRIGGER location_branch_frozen BEFORE UPDATE OF "branchId" ON "SupplierInvoice" FOR EACH ROW EXECUTE FUNCTION location_branch_frozen();
CREATE TRIGGER location_branch_frozen BEFORE UPDATE OF "branchId" ON "SupplierPayment" FOR EACH ROW EXECUTE FUNCTION location_branch_frozen();

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
-- A site whose own branch exists already (same code) is mapped to it; otherwise a branch is created from the site.
INSERT INTO "FinBranch" ("id", "code", "nameEn", "nameAr", "active", "createdAt", "createdBy")
SELECT 'br_' || l."id", l."code", coalesce(nullif(btrim(l."nameEn"), ''), l."nameAr"), l."nameAr", true, now(), 'migration'
  FROM "StockLocation" l
 WHERE l."isActive" AND l."type" <> 'TRANSIT' AND l."finBranchId" IS NULL
   AND (l."type" IN ('ROASTERY', 'CAFE', 'BRANCH') OR l."isProduction")
   AND NOT EXISTS (SELECT 1 FROM "FinBranch" b WHERE b."code" = l."code")
ON CONFLICT DO NOTHING;

UPDATE "StockLocation" l SET "finBranchId" = b."id"
  FROM "FinBranch" b
 WHERE b."code" = l."code" AND l."isActive" AND l."type" <> 'TRANSIT' AND l."finBranchId" IS NULL
   AND (l."type" IN ('ROASTERY', 'CAFE', 'BRANCH') OR l."isProduction");

UPDATE "StockLocation" l SET "finBranchId" = p."finBranchId"
  FROM "StockLocation" p
 WHERE p."isProduction" AND p."finBranchId" IS NOT NULL
   AND l."isActive" AND l."type" IN ('WAREHOUSE', 'OTHER') AND l."finBranchId" IS NULL;

-- 5 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT EXECUTE ON FUNCTION location_branch_frozen() TO flowcom_app;
  END IF;
END $$;

COMMIT;
