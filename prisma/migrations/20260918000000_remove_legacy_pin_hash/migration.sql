-- Remove the legacy PIN selector.
--
-- Employee.pinHash held an unsalted SHA-256 of the raw PIN. Under Secure Version B it is
-- inert: nothing reads it and nothing writes it. Login selects on pinLookup — a keyed
-- HMAC-SHA256 — and proves with bcrypt over pinVerifierInput, so an unsalted digest of a
-- six-digit PIN is now pure liability. The whole keyspace is a million candidates: anyone
-- holding a copy of this table could recover every PIN from it in seconds.
--
-- It was kept only so the previous application version could still authenticate during the
-- cutover. Every active employee has been reissued under Version B and carries a pinLookup,
-- so that rollback path is finished and the column can go.
--
-- Dropping it closes the rollback boundary: an application build older than Version B can no
-- longer authenticate anyone, and recovery is forward-fix or restore from the recovery point
-- taken immediately before this migration.

DROP INDEX "Employee_pinHash_key";

ALTER TABLE "Employee" DROP COLUMN "pinHash";
