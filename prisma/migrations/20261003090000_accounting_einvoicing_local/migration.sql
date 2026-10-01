-- Stage 6: e-invoicing (LOCAL validation only; nothing is sent to ZATCA) and the debit-note link.
-- Additive: new tables; nullable columns on SalesInvoice (debitNoteOfId) and Customer (nationalAddress).

-- CreateEnum
CREATE TYPE "EInvoiceProfileStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "nationalAddress" JSONB;

-- AlterTable
ALTER TABLE "SalesInvoice" ADD COLUMN     "debitNoteOfId" TEXT;

-- CreateTable
CREATE TABLE "EInvoiceProfile" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "EInvoiceProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "sellerName" TEXT NOT NULL,
    "sellerNameEn" TEXT,
    "vatNumber" TEXT NOT NULL,
    "crNumber" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "buildingNo" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT 'SA',
    "egsSerial" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
    "preparedBy" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "EInvoiceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EInvoiceJob" (
    "id" TEXT NOT NULL,
    "salesInvoiceId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errors" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EInvoiceJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EInvoice" (
    "id" TEXT NOT NULL,
    "salesInvoiceId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "egsSerial" TEXT NOT NULL,
    "icv" INTEGER NOT NULL,
    "uuid" TEXT NOT NULL,
    "typeCode" TEXT NOT NULL,
    "subtype" TEXT NOT NULL,
    "issueAt" TIMESTAMP(3) NOT NULL,
    "xml" TEXT NOT NULL,
    "invoiceHash" TEXT NOT NULL,
    "previousHash" TEXT NOT NULL,
    "qr" TEXT,
    "signature" TEXT,
    "publicKey" TEXT,
    "signer" TEXT NOT NULL,
    "validation" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "EInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EInvoiceSubmission" (
    "id" TEXT NOT NULL,
    "eInvoiceId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "environment" TEXT NOT NULL,
    "endpoint" TEXT,
    "requestHash" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "response" JSONB,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "EInvoiceSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EInvoiceProfile_version_key" ON "EInvoiceProfile"("version");

-- CreateIndex
CREATE UNIQUE INDEX "EInvoiceJob_salesInvoiceId_key" ON "EInvoiceJob"("salesInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "EInvoice_salesInvoiceId_key" ON "EInvoice"("salesInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "EInvoice_uuid_key" ON "EInvoice"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "EInvoice_egsSerial_icv_key" ON "EInvoice"("egsSerial", "icv");

-- CreateIndex
CREATE UNIQUE INDEX "EInvoiceSubmission_eInvoiceId_attempt_key" ON "EInvoiceSubmission"("eInvoiceId", "attempt");

-- AddForeignKey
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_debitNoteOfId_fkey" FOREIGN KEY ("debitNoteOfId") REFERENCES "SalesInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EInvoiceSubmission" ADD CONSTRAINT "EInvoiceSubmission_eInvoiceId_fkey" FOREIGN KEY ("eInvoiceId") REFERENCES "EInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══ Controls (stage 6) ═══════════════════════════════════════════════════════════════════════

-- An e-invoice never changes and is never deleted; its chain is checked when it is written:
-- ICV n follows n−1 of the same EGS, and the previous hash is that document's hash (or, for the
-- first, the initial value the service uses). Chain errors refuse the insert.
CREATE OR REPLACE FUNCTION acc_einvoice_guard() RETURNS trigger AS $$
DECLARE prev RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'An e-invoice cannot be changed or deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."icv" < 1 THEN
    RAISE EXCEPTION 'The invoice counter (ICV) starts at 1' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."icv" > 1 THEN
    SELECT * INTO prev FROM "EInvoice" WHERE "egsSerial" = NEW."egsSerial" AND "icv" = NEW."icv" - 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ICV % of % has no predecessor', NEW."icv", NEW."egsSerial" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF prev."invoiceHash" <> NEW."previousHash" THEN
      RAISE EXCEPTION 'The previous-invoice hash of ICV % does not match ICV %', NEW."icv", prev."icv" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EInvoice_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EInvoice" FOR EACH ROW EXECUTE FUNCTION acc_einvoice_guard();

CREATE OR REPLACE FUNCTION acc_einvoice_submission_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Submission attempts are append-only' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EInvoiceSubmission_guard" BEFORE UPDATE OR DELETE ON "EInvoiceSubmission" FOR EACH ROW EXECUTE FUNCTION acc_einvoice_submission_guard();

-- Seller profile: approved by someone other than its preparer; an approved version never changes;
-- production is not an environment this branch accepts.
CREATE OR REPLACE FUNCTION acc_einvoice_profile_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'An approved e-invoicing profile cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN OLD;
  END IF;
  IF NEW."environment" NOT IN ('LOCAL_ONLY', 'SANDBOX') THEN
    RAISE EXCEPTION 'E-invoicing environment % is not allowed (LOCAL_ONLY or SANDBOX)', NEW."environment" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN RAISE EXCEPTION 'A profile is created as a draft' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED' AND (NEW."approvedBy" IS NULL OR NEW."approvedBy" = NEW."preparedBy") THEN
    RAISE EXCEPTION 'An e-invoicing profile must be approved by someone other than its preparer' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED') OR (OLD."status" = 'APPROVED' AND NEW."status" = 'RETIRED')) THEN
    RAISE EXCEPTION 'A profile cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'An approved e-invoicing profile cannot change; prepare a new version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "EInvoiceProfile_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EInvoiceProfile" FOR EACH ROW EXECUTE FUNCTION acc_einvoice_profile_guard();
CREATE UNIQUE INDEX "EInvoiceProfile_one_draft" ON "EInvoiceProfile" ((true)) WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "EInvoiceProfile_one_approved" ON "EInvoiceProfile" ((true)) WHERE "status" = 'APPROVED';
