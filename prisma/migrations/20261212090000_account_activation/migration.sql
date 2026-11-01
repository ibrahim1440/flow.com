-- «رابط تفعيل الحساب» (owner decision, 1 Nov 2026): a new login — or one whose password is to be reset — gets a one-time
-- link by WhatsApp; the person opens it and chooses their own password. Only the SHA-256 of the token is stored; the
-- link itself is never written anywhere (the WhatsApp log row says a link was sent, not the link). Additive.
BEGIN;

CREATE TABLE "AccountActivation" (
  "id"          TEXT         NOT NULL,
  "employeeId"  TEXT         NOT NULL,
  "tokenHash"   TEXT         NOT NULL,
  "purpose"     TEXT         NOT NULL,
  "createdById" TEXT         NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "usedAt"      TIMESTAMP(3),
  "revokedAt"   TIMESTAMP(3),
  CONSTRAINT "AccountActivation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountActivation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AccountActivation_shape_check" CHECK (
    "tokenHash" ~ '^[0-9a-f]{64}$'
    AND "purpose" IN ('INVITE', 'RESET')
    AND "expiresAt" > "createdAt"
    AND NOT ("usedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "AccountActivation_tokenHash_key" ON "AccountActivation"("tokenHash");
CREATE INDEX "AccountActivation_employeeId_idx" ON "AccountActivation"("employeeId");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "AccountActivation" TO flowcom_app;
  END IF;
END $$;

COMMIT;
