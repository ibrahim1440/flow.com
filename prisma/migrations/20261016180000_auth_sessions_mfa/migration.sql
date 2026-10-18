-- Owner security decision (16 Oct, Option A: username + PIN for privileged accounts) —
-- server-side sessions (logout revokes, idle and absolute expiry, authentication time for
-- step-up), TOTP multi-factor authentication with recovery codes, and normalized unique
-- usernames.
-- ADDITIVE ONLY: one new enum value; three new tables with their indexes, checks and guards;
-- one helper function and one expression index on "Employee"."username". No existing column or
-- row is changed; the frozen 20261016140000 and 20261016160000 migrations are untouched.
-- Also (independent security review of 5f06a801, NEW-3 / NEW-8): identity document numbers are
-- strict — hr_norm_id is redefined without locale-dependent steps, and a stored number whose
-- normal form is anything but [A-Z0-9] is refused by a CHECK on both kinds of record. Existing
-- rows are re-checked first; the migration stops with a message if any would be refused.
-- Atomic: the whole file runs in one transaction.
BEGIN;

-- A second-person, attested MFA reset (recovery codes lost).
ALTER TYPE "HrConfigChangeKind" ADD VALUE IF NOT EXISTS 'MFA_RESET';

-- Usernames are unique in normal form (trim, NFKC, case-fold). The application writes them
-- normalized; this index makes two spellings of one name impossible even if it did not.
CREATE OR REPLACE FUNCTION auth_norm_username(v TEXT) RETURNS TEXT AS $$
  SELECT CASE WHEN v IS NULL OR btrim(v) = '' THEN NULL ELSE lower(normalize(btrim(v), NFKC)) END
$$ LANGUAGE sql IMMUTABLE;
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM (SELECT auth_norm_username("username") FROM "Employee" WHERE auth_norm_username("username") IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'AUTH: % username(s) differ only by case, spaces or Unicode form; rename them before this migration', n;
  END IF;
END $$;
CREATE UNIQUE INDEX "Employee_username_norm_key" ON "Employee" (auth_norm_username("username")) WHERE auth_norm_username("username") IS NOT NULL;

-- One row per signed-in session. The token names its row (jti); a session is valid only while
-- this row is not revoked and neither the idle nor the absolute deadline has passed. Logout,
-- a credential change, a promotion to a privileged account and an MFA reset revoke it.
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    -- PIN | USERNAME_PIN | PASSWORD
    "method" TEXT NOT NULL,
    "mfa" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Last strong authentication (sign-in or step-up): sensitive actions need it recent.
    "authTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuthSession_employeeId_idx" ON "AuthSession"("employeeId");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AuthSession_method" CHECK ("method" IN ('PIN', 'USERNAME_PIN', 'PASSWORD')),
  ADD CONSTRAINT "AuthSession_revoked" CHECK (("revokedAt" IS NULL) = ("revokedReason" IS NULL));

-- A revoked session is never brought back.
CREATE OR REPLACE FUNCTION auth_session_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."revokedAt" IS NOT NULL AND (NEW."revokedAt" IS NULL OR NEW."revokedAt" <> OLD."revokedAt") THEN
    RAISE EXCEPTION 'AUTH: a revoked session is never reinstated' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER auth_session_guard BEFORE UPDATE ON "AuthSession" FOR EACH ROW EXECUTE FUNCTION auth_session_guard();

-- TOTP (RFC 6238) per account. The secret is encrypted at rest (AES-256-GCM, key from the
-- environment, never stored here). enrolledAt is set only after a valid first code; lastStep
-- refuses a code that was already used (replay).
CREATE TABLE "AuthMfa" (
    "employeeId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3),
    "lastStep" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthMfa_pkey" PRIMARY KEY ("employeeId")
);
ALTER TABLE "AuthMfa" ADD CONSTRAINT "AuthMfa_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ten one-time recovery codes per enrollment, stored as keyed hashes only.
CREATE TABLE "AuthRecoveryCode" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthRecoveryCode_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuthRecoveryCode_employeeId_idx" ON "AuthRecoveryCode"("employeeId");
CREATE UNIQUE INDEX "AuthRecoveryCode_codeHash_key" ON "AuthRecoveryCode"("codeHash");
ALTER TABLE "AuthRecoveryCode" ADD CONSTRAINT "AuthRecoveryCode_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A used recovery code is never usable again.
CREATE OR REPLACE FUNCTION auth_recovery_code_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."usedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'AUTH: a used recovery code never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."codeHash" <> OLD."codeHash" OR NEW."employeeId" <> OLD."employeeId" THEN
    RAISE EXCEPTION 'AUTH: a recovery code is only ever marked used' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER auth_recovery_code_guard BEFORE UPDATE ON "AuthRecoveryCode" FOR EACH ROW EXECUTE FUNCTION auth_recovery_code_guard();

-- ── Identity numbers: one strict, locale-independent normal form (NEW-3, NEW-8) ──────────
-- Same steps as before (NFKC; format / default-ignorable characters removed; Arabic-Indic and
-- Eastern Arabic-Indic digits to ASCII; spaces, dashes and dots removed; leading zeros of an
-- all-digit number stripped), except that nothing depends on the database locale: whitespace
-- is an explicit list (not \s) and only ASCII a-z is upper-cased (not upper()). The result is
-- valid only when it is [A-Z0-9]+: other digit scripts, combining marks, punctuation such as
-- _ / , and look-alike letters (Cyrillic, Greek, ß, …) are refused, never folded.
CREATE OR REPLACE FUNCTION hr_norm_id(v TEXT) RETURNS TEXT AS $$
DECLARE t TEXT;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  t := normalize(v, NFKC);
  t := regexp_replace(t, '[\u00AD\u034F\u061C\u0600-\u0605\u06DD\u070F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB]', '', 'g');
  t := translate(t, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
  t := regexp_replace(t, '[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\-\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D.\u00B7\u2024\u2027\u3002\uFF0E\uFF61]', '', 'g');
  t := translate(t, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  IF t ~ '^[0-9]+$' THEN
    t := ltrim(t, '0');
    IF t = '' THEN t := '0'; END IF;
  END IF;
  IF t = '' THEN RETURN NULL; END IF;
  RETURN t;
END $$ LANGUAGE plpgsql IMMUTABLE;

DO $$
DECLARE n INT;
BEGIN
  SELECT (SELECT count(*) FROM "HrEmployeePrivate" WHERE "idNumber" !~ '^[ \t\n\r]*$' AND (hr_norm_id("idNumber") IS NULL OR hr_norm_id("idNumber") !~ '^[A-Z0-9]+$' OR "idNumberNorm" IS DISTINCT FROM hr_norm_id("idNumber")))
       + (SELECT count(*) FROM "HrExternalPerson" WHERE "idNumber" !~ '^[ \t\n\r]*$' AND (hr_norm_id("idNumber") IS NULL OR hr_norm_id("idNumber") !~ '^[A-Z0-9]+$' OR "idNumberNorm" IS DISTINCT FROM hr_norm_id("idNumber")))
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'IDENTITY: % stored identity number(s) contain characters other than A-Z and 0-9 after normalization (other digit scripts, marks, punctuation or look-alike letters); correct them before this migration', n;
  END IF;
END $$;
ALTER TABLE "HrEmployeePrivate" ADD CONSTRAINT "HrEmployeePrivate_idNumber_strict" CHECK ("idNumber" IS NULL OR "idNumber" ~ '^[ \t\n\r]*$' OR ("idNumberNorm" IS NOT NULL AND "idNumberNorm" ~ '^[A-Z0-9]+$'));
ALTER TABLE "HrExternalPerson" ADD CONSTRAINT "HrExternalPerson_idNumber_strict" CHECK ("idNumber" IS NULL OR "idNumber" ~ '^[ \t\n\r]*$' OR ("idNumberNorm" IS NOT NULL AND "idNumberNorm" ~ '^[A-Z0-9]+$'));

COMMIT;
