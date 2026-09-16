-- Delivery request idempotency.
--
-- The same logical dispatch submitted twice created a second Delivery row, delivered the
-- quantity again and consumed the stock again; the ordered-quantity ceiling bounded the
-- damage without deduplicating anything. requestKey is the client-supplied Idempotency-Key
-- and intentHash the canonical hash of what it asked for, so a retry can be recognised and
-- replayed rather than repeated.
--
-- Both nullable, and the unique index permits many NULLs, so the previous application
-- version keeps inserting deliveries unchanged while this migration is already applied.
ALTER TABLE "Delivery" ADD COLUMN "requestKey" TEXT;
ALTER TABLE "Delivery" ADD COLUMN "intentHash" TEXT;
CREATE UNIQUE INDEX "Delivery_requestKey_key" ON "Delivery"("requestKey");

-- Keyed PIN lookup.
--
-- Employee.pinHash is an unsalted SHA-256 of a low-entropy PIN, unique-indexed for lookup.
-- A database copy therefore yields every working PIN in milliseconds, which bcrypt on
-- Employee.pin cannot compensate for. pinLookup replaces it with HMAC-SHA256 under a
-- dedicated application secret: unforgeable and unsearchable without that secret.
--
-- Additive only. pinHash is untouched here so the previous application version can still
-- authenticate during the deployment window; a later migration removes it, after every PIN
-- has been reissued and no code reads or writes it.
ALTER TABLE "Employee" ADD COLUMN "pinLookup" TEXT;
CREATE UNIQUE INDEX "Employee_pinLookup_key" ON "Employee"("pinLookup");
