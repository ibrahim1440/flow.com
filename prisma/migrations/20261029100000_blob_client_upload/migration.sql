-- Direct browser-to-Vercel-Blob uploads of customer files, up to 20 MB (feat/blob-client-upload).
-- Owner decision: files over 4 MB no longer pass through the app's route (Vercel's 4.5 MB request
-- limit); the browser uploads them straight to the private Blob store with a short token the server
-- scopes to ONE exact pathname, then asks the server to finalize (check the blob, hash it, sniff its
-- type, create the "CustomerFile" row).
--
-- ADDITIVE ONLY:
--   "CustomerFileUpload"   new, empty table: one row per upload slot the server handed out and that
--                          is not finalized yet (customer, exact pathname, declared name / size / type,
--                          category, title, who asked, when, the token's expiry). The row is deleted
--                          when the upload is finalized (the "CustomerFile" row takes the same id),
--                          refused (the blob is deleted) or swept as an orphan after one hour (the
--                          blob is deleted). FK from the new table only: Employee ON DELETE SET NULL.
--                          No FK to "Customer" on purpose — a slot outlives its customer so its blob
--                          is still swept.
-- Nothing existing is altered, dropped, renamed or back-filled. The previous application version never
-- reads the new table.
-- Atomic: the whole file runs in one transaction. Rollback:
-- docs/hr/migration-review/rollback-20261029100000_blob_client_upload.sql.
BEGIN;

-- CreateTable
CREATE TABLE "CustomerFileUpload" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "pathname" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT,
    "fileName" TEXT NOT NULL,
    "declaredBytes" INTEGER NOT NULL,
    "declaredType" TEXT NOT NULL,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerFileUpload_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CustomerFileUpload_category_check" CHECK ("category" IN ('CONTRACT', 'REGISTRATION', 'TAX', 'PRICE_AGREEMENT', 'OTHER')),
    CONSTRAINT "CustomerFileUpload_type_check" CHECK ("declaredType" IN ('application/pdf', 'image/jpeg', 'image/png')),
    -- The direct path is for files the app's own route cannot carry: up to the Blob limit of 20 MB.
    CONSTRAINT "CustomerFileUpload_size_check" CHECK ("declaredBytes" BETWEEN 1 AND 20971520),
    -- customers/<customerId>/<id>-…: the slot's pathname always names its own customer and id.
    CONSTRAINT "CustomerFileUpload_pathname_check" CHECK (
        left("pathname", length('customers/' || "customerId" || '/' || "id" || '-')) = 'customers/' || "customerId" || '/' || "id" || '-'
        AND length("pathname") <= 400)
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerFileUpload_pathname_key" ON "CustomerFileUpload"("pathname");
CREATE INDEX "CustomerFileUpload_createdAt_idx" ON "CustomerFileUpload"("createdAt");
CREATE INDEX "CustomerFileUpload_customerId_idx" ON "CustomerFileUpload"("customerId");

-- AddForeignKey
ALTER TABLE "CustomerFileUpload" ADD CONSTRAINT "CustomerFileUpload_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
