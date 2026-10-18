-- Owner decision 1 (Option A, 16 Oct): mandatory VERIFIED person identity for payroll duties,
-- with the corrections of the independent security review of 3404f4f0.
-- ADDITIVE: three new enum values; four new tables (external persons, identity verifications,
-- the one-time verification bootstrap, the credential stage) with their indexes, checks and
-- guards; one new nullable column on "HrEmployeePrivate" ("idNumberNorm", filled from the
-- existing "idNumber"), its unique index and guard; and one guard trigger on "HrEmployee" (one
-- login, one person). No existing column is changed or dropped and no existing row is deleted;
-- the frozen 20261016140000 migration is untouched.
-- Atomic: the whole file runs in one transaction.
BEGIN;

-- One normal form for identity document numbers (review P1-2), shared by every guard and by the
-- application (src/lib/hr/identity.ts normalizeIdNumber, kept identical and tested against this):
--   NFKC (full-width digits and letters fold to ASCII) → drop format and default-ignorable
--   characters → Arabic-Indic and Eastern Arabic-Indic digits to ASCII → drop spaces, dashes and
--   dots → upper case → an all-digit number compares without leading zeros. Empty → NULL.
CREATE OR REPLACE FUNCTION hr_norm_id(v TEXT) RETURNS TEXT AS $$
DECLARE t TEXT;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  t := normalize(v, NFKC);
  t := regexp_replace(t, '[\u00AD\u034F\u061C\u0600-\u0605\u06DD\u070F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB]', '', 'g');
  t := translate(t, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
  t := regexp_replace(t, '[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\-\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D.\u00B7\u2024\u2027\u3002\uFF0E\uFF61]', '', 'g');
  t := upper(t);
  IF t ~ '^[0-9]+$' THEN
    t := ltrim(t, '0');
    IF t = '' THEN t := '0'; END IF;
  END IF;
  IF t = '' THEN RETURN NULL; END IF;
  RETURN t;
END $$ LANGUAGE plpgsql IMMUTABLE;

-- New request kinds (values added; never used inside this transaction).
ALTER TYPE "HrConfigChangeKind" ADD VALUE IF NOT EXISTS 'PERSON_VERIFY';
ALTER TYPE "HrConfigChangeKind" ADD VALUE IF NOT EXISTS 'EXTERNAL_PERSON_CHANGE';
-- Review P2-3: an identifying change (name, identity document) of a verified employee, or of one
-- whose login holds duties, is a second-person request.
ALTER TYPE "HrConfigChangeKind" ADD VALUE IF NOT EXISTS 'EMPLOYEE_IDENTITY_CHANGE';

-- A verified non-employee identity (e.g. an external accountant). Never on payroll, never a
-- payee, and never a dummy employee record.
CREATE TABLE "HrExternalPerson" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "idNumber" TEXT,
    -- hr_norm_id("idNumber"), set by the guard trigger (never by the application).
    "idNumberNorm" TEXT,
    "organization" TEXT,
    "roleNote" TEXT,
    "accountId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HrExternalPerson_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HrExternalPerson_accountId_key" ON "HrExternalPerson"("accountId");
CREATE INDEX "HrExternalPerson_active_idx" ON "HrExternalPerson"("active");
-- One identity document, one person record (when present), compared in normal form.
CREATE UNIQUE INDEX "HrExternalPerson_idNumberNorm_key" ON "HrExternalPerson"("idNumberNorm") WHERE "idNumberNorm" IS NOT NULL;

ALTER TABLE "HrExternalPerson"
  ADD CONSTRAINT "HrExternalPerson_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "HrExternalPerson_name" CHECK (length(btrim("fullName")) >= 3);

-- A login is linked to ONE person: never to an employee record and an external person at once.
CREATE OR REPLACE FUNCTION hr_external_person_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: an external person record is never deleted; deactivate it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- One human, one record (review P1-2): the normal form is the guard's own, and an employee
  -- record with the same number is refused. The advisory lock serialises the two tables' checks.
  NEW."idNumberNorm" := hr_norm_id(NEW."idNumber");
  IF NEW."idNumberNorm" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('hr:idnorm:' || NEW."idNumberNorm"));
    IF EXISTS (SELECT 1 FROM "HrEmployeePrivate" WHERE "idNumberNorm" = NEW."idNumberNorm") THEN
      RAISE EXCEPTION 'HR: this identity number belongs to an employee record' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  -- Review P3-8: the login's row is locked first, so two concurrent links of one login (one per
  -- table) cannot both pass the check below.
  IF NEW."accountId" IS NOT NULL THEN
    PERFORM 1 FROM "Employee" WHERE "id" = NEW."accountId" FOR UPDATE;
  END IF;
  IF NEW."accountId" IS NOT NULL AND EXISTS (SELECT 1 FROM "HrEmployee" WHERE "accountId" = NEW."accountId") THEN
    RAISE EXCEPTION 'HR: this login is already linked to an employee record' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER hr_external_person_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrExternalPerson"
  FOR EACH ROW EXECUTE FUNCTION hr_external_person_guard();

-- And the other direction: an employee record never takes a login an external person holds.
-- (A trigger only; no column or row of "HrEmployee" changes.)
CREATE OR REPLACE FUNCTION hr_employee_account_one_person() RETURNS trigger AS $$
BEGIN
  IF NEW."accountId" IS NOT NULL THEN
    PERFORM 1 FROM "Employee" WHERE "id" = NEW."accountId" FOR UPDATE;
  END IF;
  IF NEW."accountId" IS NOT NULL AND EXISTS (SELECT 1 FROM "HrExternalPerson" WHERE "accountId" = NEW."accountId") THEN
    RAISE EXCEPTION 'HR: this login is already linked to an external person' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER hr_employee_account_one_person BEFORE INSERT OR UPDATE OF "accountId" ON "HrEmployee"
  FOR EACH ROW EXECUTE FUNCTION hr_employee_account_one_person();

-- Review P1-2 on the employee side: the normal form of the private identity number, filled from
-- the existing values, unique, and never shared with an external person.
ALTER TABLE "HrEmployeePrivate" ADD COLUMN "idNumberNorm" TEXT;
UPDATE "HrEmployeePrivate" SET "idNumberNorm" = hr_norm_id("idNumber") WHERE "idNumber" IS NOT NULL;
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM (SELECT "idNumberNorm" FROM "HrEmployeePrivate" WHERE "idNumberNorm" IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'HR: % identity number(s) are shared by more than one employee record; resolve them before this migration', n;
  END IF;
END $$;
CREATE UNIQUE INDEX "HrEmployeePrivate_idNumberNorm_key" ON "HrEmployeePrivate"("idNumberNorm") WHERE "idNumberNorm" IS NOT NULL;

CREATE OR REPLACE FUNCTION hr_employee_private_id_guard() RETURNS trigger AS $$
BEGIN
  NEW."idNumberNorm" := hr_norm_id(NEW."idNumber");
  IF NEW."idNumberNorm" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('hr:idnorm:' || NEW."idNumberNorm"));
    IF EXISTS (SELECT 1 FROM "HrExternalPerson" WHERE "idNumberNorm" = NEW."idNumberNorm") THEN
      RAISE EXCEPTION 'HR: this identity number belongs to an external person' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER hr_employee_private_id_guard BEFORE INSERT OR UPDATE OF "idNumber", "idNumberNorm" ON "HrEmployeePrivate"
  FOR EACH ROW EXECUTE FUNCTION hr_employee_private_id_guard();

-- Identity verification of a person (employee or external), approved by a SECOND person.
-- At most one live verification per person; a verification is revoked, never edited or deleted.
CREATE TABLE "HrIdentityVerification" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "verifiedBy" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "configChangeId" TEXT,
    -- Review P2-4: the login this verification attests ("this login belongs to this person").
    -- A login linked to the person later is not verified until a second person attests it.
    "accountId" TEXT,
    "note" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "HrIdentityVerification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HrIdentityVerification_subjectType_subjectId_idx" ON "HrIdentityVerification"("subjectType", "subjectId");
CREATE UNIQUE INDEX "HrIdentityVerification_one_live" ON "HrIdentityVerification"("subjectType", "subjectId") WHERE "revokedAt" IS NULL;

ALTER TABLE "HrIdentityVerification"
  ADD CONSTRAINT "HrIdentityVerification_subject_type" CHECK ("subjectType" IN ('EMPLOYEE', 'EXTERNAL')),
  -- Four eyes: the person who verifies is never the one who asked.
  ADD CONSTRAINT "HrIdentityVerification_four_eyes" CHECK ("verifiedBy" <> "requestedBy"),
  ADD CONSTRAINT "HrIdentityVerification_revoked" CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL));

CREATE OR REPLACE FUNCTION hr_identity_verification_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: an identity verification is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'HR: a revoked identity verification never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['revokedAt', 'revokedBy', 'revokeReason']) <> (to_jsonb(OLD) - ARRAY['revokedAt', 'revokedBy', 'revokeReason']) THEN
    RAISE EXCEPTION 'HR: an identity verification is only ever revoked' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER hr_identity_verification_guard BEFORE UPDATE OR DELETE ON "HrIdentityVerification"
  FOR EACH ROW EXECUTE FUNCTION hr_identity_verification_guard();

-- Review P1-1: the bootstrap of an empty register happens ONCE. The first verification approved
-- without a verified verifier writes this single row; from then on no verification is ever
-- approved without a verified verifier, even if every verification is later revoked. Never
-- changed or deleted.
CREATE TABLE "HrIdentityBootstrap" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "verificationId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrIdentityBootstrap_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "HrIdentityBootstrap"
  ADD CONSTRAINT "HrIdentityBootstrap_singleton" CHECK ("id" = 'singleton'),
  ADD CONSTRAINT "HrIdentityBootstrap_two_people" CHECK ("requestedBy" <> "approvedBy"),
  ADD CONSTRAINT "HrIdentityBootstrap_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "HrIdentityVerification"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION hr_identity_bootstrap_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'HR: the identity bootstrap record never changes' USING ERRCODE = 'integrity_constraint_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER hr_identity_bootstrap_guard BEFORE UPDATE OR DELETE ON "HrIdentityBootstrap"
  FOR EACH ROW EXECUTE FUNCTION hr_identity_bootstrap_guard();

-- Review item 4 (orchestrator, 16 Oct): the credential HASHES of a requested credential change
-- (bcrypt PIN verifier, keyed PIN selector, bcrypt password) and the requested username are kept
-- here, not in the immutable HrConfigChange payload (which keeps the field NAMES only). The row
-- is deleted when the request is applied, rejected or withdrawn, so no old hash outlives its
-- request.
CREATE TABLE "HrCredentialStage" (
    "configChangeId" TEXT NOT NULL,
    "username" TEXT,
    "pin" TEXT,
    "pinLookup" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrCredentialStage_pkey" PRIMARY KEY ("configChangeId")
);

ALTER TABLE "HrCredentialStage"
  ADD CONSTRAINT "HrCredentialStage_configChangeId_fkey" FOREIGN KEY ("configChangeId") REFERENCES "HrConfigChange"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- The PIN verifier and its selector are written together, or not at all.
  ADD CONSTRAINT "HrCredentialStage_pin_pair" CHECK (("pin" IS NULL) = ("pinLookup" IS NULL));

COMMIT;
