-- 20261231160000_idempotency_request — R1-b (owner decision 1-أ): one generic record of the money / stock writes already done,
-- so a double click, a retry after a lost response, or eight simultaneous submits of the same form make ONE record — and the
-- repeats get the ORIGINAL answer back instead of a second order, payment, journal, receipt or transfer.
--   "IdempotencyRequest": one row per (actor, scope, key). Written INSIDE the transaction of the write it protects, first:
--   a concurrent duplicate waits on the UNIQUE index, then finds the committed row and replays its stored response; a write
--   that fails rolls its key row back with it (the client may retry the same key). The intent hash refuses the same key
--   reused for a different request (409 REQUEST_KEY_REUSED).
-- Additive: one new table, its unique key, an index for age-based clean-up, and one partial index on "HrAuditLog" for the
-- direct-sale key lookup. No existing row is read or written.
BEGIN;

CREATE TABLE "IdempotencyRequest" (
  "id"             TEXT        NOT NULL,
  "actorId"        TEXT        NOT NULL,
  "scope"          TEXT        NOT NULL,
  "key"            TEXT        NOT NULL,
  "intentHash"     TEXT        NOT NULL,
  "responseStatus" INTEGER,
  "responseBody"   JSONB,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"    TIMESTAMP(3),
  CONSTRAINT "IdempotencyRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IdempotencyRequest_scope_check" CHECK ("scope" ~ '^[a-z0-9_.:-]{1,64}$'),
  CONSTRAINT "IdempotencyRequest_key_check" CHECK ("key" ~ '^[A-Za-z0-9._:-]{1,200}$'),
  CONSTRAINT "IdempotencyRequest_hash_check" CHECK ("intentHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "IdempotencyRequest_response_check" CHECK (("responseStatus" IS NULL) = ("completedAt" IS NULL)
                                                        AND ("responseStatus" IS NULL OR "responseStatus" BETWEEN 200 AND 299))
);
CREATE UNIQUE INDEX "IdempotencyRequest_actorId_scope_key_key" ON "IdempotencyRequest"("actorId", "scope", "key");
CREATE INDEX "IdempotencyRequest_createdAt_idx" ON "IdempotencyRequest"("createdAt");

-- R1-b (owner 1-ج): a direct sale waiting for its discount approval is found again by its key in the audit trail (its replay,
-- lib/services/sales/direct-sale.ts, under an advisory lock on the key) — that lookup scanned "HrAuditLog". A partial
-- expression index for exactly that lookup (no existing row is changed).
CREATE INDEX "HrAuditLog_direct_sale_key_idx" ON "HrAuditLog" (("after" ->> 'requestKey')) WHERE "action" = 'DIRECT_SALE_CREATED';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "IdempotencyRequest" TO flowcom_app;
  END IF;
END $$;

COMMIT;
