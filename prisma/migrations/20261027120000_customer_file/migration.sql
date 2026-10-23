-- Customer file: the «الملفات» tab of the account page (Figma crm-account 179:1312 / 180:1470).
-- ADDITIVE ONLY: one new, empty table "CustomerFile" with its index, two foreign keys (from the new
-- table only) and five CHECKs that judge the new table's rows only. Nothing existing is altered,
-- dropped, renamed, retyped or back-filled; no existing row can block it.
--   CustomerFile -> Customer ON DELETE CASCADE (a deleted customer takes its documents, as its contacts)
--   CustomerFile.uploadedById -> Employee ON DELETE SET NULL
-- The bytes live in the row (BYTEA), as "CollectionEvidence", "FinAttachment" and "HrDocument" already
-- do: the deployment has an ephemeral filesystem and no object store. The size CHECK keeps it a
-- document store, not a file server: 5 MB per file, and the stored length must equal "sizeBytes".
-- Atomic: the whole file runs in one transaction. Rollback:
-- docs/hr/migration-review/rollback-20261027120000_customer_file.sql.
BEGIN;

-- CreateTable
CREATE TABLE "CustomerFile" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerFile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CustomerFile_category_check" CHECK ("category" IN ('CONTRACT', 'REGISTRATION', 'TAX', 'PRICE_AGREEMENT', 'OTHER')),
    CONSTRAINT "CustomerFile_mimeType_check" CHECK ("mimeType" IN ('application/pdf', 'image/jpeg', 'image/png')),
    CONSTRAINT "CustomerFile_size_check" CHECK ("sizeBytes" BETWEEN 1 AND 5242880 AND octet_length("content") = "sizeBytes"),
    CONSTRAINT "CustomerFile_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 120),
    CONSTRAINT "CustomerFile_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

-- CreateIndex
CREATE INDEX "CustomerFile_customerId_createdAt_idx" ON "CustomerFile"("customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "CustomerFile" ADD CONSTRAINT "CustomerFile_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerFile" ADD CONSTRAINT "CustomerFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
