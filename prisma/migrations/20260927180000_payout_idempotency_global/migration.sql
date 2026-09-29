-- A payout idempotency key identifies one payment, so it is unique across the whole
-- ledger rather than within an employee and a period. The narrower constraint would have
-- accepted the same key as a second payment for a different person or month, which is a
-- client fault rather than a legitimate payment.
--
-- Postgres treats NULLs as distinct under a unique index, so every movement that carries
-- no key -- accruals, reversals, adjustments -- is unaffected.

DROP INDEX IF EXISTS "CommissionLedgerEntry_employeeId_periodStart_idempotencyKey_key";

CREATE UNIQUE INDEX "CommissionLedgerEntry_idempotencyKey_key"
    ON "CommissionLedgerEntry"("idempotencyKey");
