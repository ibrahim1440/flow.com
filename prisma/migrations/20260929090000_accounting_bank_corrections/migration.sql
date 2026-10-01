-- CreateEnum
CREATE TYPE "BankCorrectionKind" AS ENUM ('VOID', 'REPLACE');

-- CreateEnum
CREATE TYPE "BankCorrectionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED');

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "replacesTransactionId" TEXT;

-- CreateTable
CREATE TABLE "BankCorrection" (
    "id" TEXT NOT NULL,
    "correctionNo" SERIAL NOT NULL,
    "transactionId" TEXT NOT NULL,
    "kind" "BankCorrectionKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "replacement" JSONB,
    "status" "BankCorrectionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "appliedAt" TIMESTAMP(3),
    "replacementTransactionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankCorrection_correctionNo_key" ON "BankCorrection"("correctionNo");

-- CreateIndex
CREATE UNIQUE INDEX "BankCorrection_replacementTransactionId_key" ON "BankCorrection"("replacementTransactionId");

-- CreateIndex
CREATE INDEX "BankCorrection_transactionId_idx" ON "BankCorrection"("transactionId");

-- CreateIndex
CREATE INDEX "BankCorrection_status_idx" ON "BankCorrection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_replacesTransactionId_key" ON "BankTransaction"("replacesTransactionId");

-- AddForeignKey
ALTER TABLE "BankCorrection" ADD CONSTRAINT "BankCorrection_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_replacesTransactionId_fkey" FOREIGN KEY ("replacesTransactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Posted bank lines are immutable (STAGE_2_DESIGN §7). "Posted" = the journal of the line's
-- confirmed event exists; for the receiving leg of a transfer, the paying leg's journal counts.
-- VOLATILE on purpose: inside a trigger each call sees journals committed by a concurrent
-- posting that this statement waited for (the translator locks the bank row FOR UPDATE).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION acc_bank_txn_posted(p_id text) RETURNS boolean VOLATILE LANGUAGE plpgsql AS $$
DECLARE peer text;
BEGIN
  SELECT "transferPeerId" INTO peer FROM "BankTransaction" WHERE "id" = p_id;
  RETURN EXISTS (
    SELECT 1 FROM "JournalEntry" je JOIN "AccountingEvent" ae ON ae."id" = je."originEventId"
     WHERE ae."idempotencyKey" = 'bank:' || p_id || ':confirmed'
        OR (peer IS NOT NULL AND ae."idempotencyKey" = 'bank:' || peer || ':confirmed'));
END $$;

CREATE OR REPLACE FUNCTION acc_guard_posted_bank_txn() RETURNS trigger AS $$
BEGIN
  IF NOT acc_bank_txn_posted(OLD."id") THEN RETURN NEW; END IF;
  IF (NEW."amount", NEW."currency", NEW."grossAmount", NEW."feeAmount", NEW."cashAccountId", NEW."txnDate",
      NEW."classification", NEW."branchKey", NEW."transferPeerId", NEW."replacesTransactionId")
     IS DISTINCT FROM
     (OLD."amount", OLD."currency", OLD."grossAmount", OLD."feeAmount", OLD."cashAccountId", OLD."txnDate",
      OLD."classification", OLD."branchKey", OLD."transferPeerId", OLD."replacesTransactionId") THEN
    RAISE EXCEPTION 'This bank line has posted to the ledger; its amount, date, account, classification and transfer link cannot change. Request a correction in Accounting → Bank.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."reviewStatus" IS DISTINCT FROM OLD."reviewStatus" THEN
    RAISE EXCEPTION 'This bank line has posted to the ledger; it cannot be sent back to review. Request a correction in Accounting → Bank.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NEW."status" <> 'VOID' OR OLD."status" = 'VOID' THEN
      RAISE EXCEPTION 'A posted bank line can only be voided' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "BankCorrection" c
                    WHERE c."status" = 'APPROVED'
                      AND (c."transactionId" = OLD."id" OR c."transactionId" = OLD."transferPeerId")) THEN
      RAISE EXCEPTION 'A posted bank line is voided only through an approved correction (Accounting → Bank)'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."voidedBy" IS NULL OR NEW."voidedAt" IS NULL THEN
      RAISE EXCEPTION 'A void records who and when' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "BankTransaction_posted_guard" BEFORE UPDATE ON "BankTransaction"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_posted_bank_txn();

-- Splits (counterpart accounts) of a posted line are frozen.
CREATE OR REPLACE FUNCTION acc_guard_posted_bank_split() RETURNS trigger AS $$
DECLARE t text := COALESCE(NEW."transactionId", OLD."transactionId");
BEGIN
  PERFORM 1 FROM "BankTransaction" WHERE "id" = t FOR UPDATE;
  IF acc_bank_txn_posted(t) THEN
    RAISE EXCEPTION 'This bank line has posted to the ledger; its budget splits cannot change. Request a correction in Accounting → Bank.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "BankTransactionSplit_posted_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BankTransactionSplit"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_posted_bank_split();

-- Matches (supplier allocations) of a posted line are frozen; once the line is VOID they may
-- only be switched off (the void releases the obligations it paid).
CREATE OR REPLACE FUNCTION acc_guard_posted_bank_match() RETURNS trigger AS $$
DECLARE t text := COALESCE(NEW."transactionId", OLD."transactionId"); st text;
BEGIN
  SELECT "status"::text INTO st FROM "BankTransaction" WHERE "id" = t FOR UPDATE;
  IF NOT acc_bank_txn_posted(t) THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' AND st = 'VOID' AND OLD."active" AND NOT NEW."active"
     AND (NEW."targetType", NEW."targetId", NEW."amount", NEW."transactionId") IS NOT DISTINCT FROM (OLD."targetType", OLD."targetId", OLD."amount", OLD."transactionId") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'This bank line has posted to the ledger; its matches to documents cannot change. Request a correction in Accounting → Bank.'
    USING ERRCODE = 'integrity_constraint_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "BankTransactionMatch_posted_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BankTransactionMatch"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_posted_bank_match();

-- Corrections: append-only, four-eyes, one-way status.
CREATE OR REPLACE FUNCTION acc_guard_bank_correction() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bank corrections are part of the audit trail and cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."approvedBy" IS NOT NULL OR NEW."appliedAt" IS NOT NULL OR NEW."replacementTransactionId" IS NOT NULL THEN
      RAISE EXCEPTION 'A correction starts as a pending request' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF length(coalesce(NEW."reason", '')) < 5 THEN
      RAISE EXCEPTION 'A correction needs a reason (5+ characters)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (NEW."kind" = 'REPLACE') <> (NEW."replacement" IS NOT NULL) THEN
      RAISE EXCEPTION 'A replacement correction carries the replacement data; a void does not' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."transactionId", NEW."kind", NEW."reason", NEW."replacement", NEW."requestedBy", NEW."requestedAt", NEW."correctionNo")
     IS DISTINCT FROM (OLD."transactionId", OLD."kind", OLD."reason", OLD."replacement", OLD."requestedBy", OLD."requestedAt", OLD."correctionNo") THEN
    RAISE EXCEPTION 'A correction request cannot be edited; reject it and request a new one' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = NEW."status" THEN
    IF (NEW."approvedBy", NEW."approvedAt", NEW."rejectedBy", NEW."rejectedAt", NEW."rejectReason", NEW."appliedAt", NEW."replacementTransactionId")
       IS DISTINCT FROM (OLD."approvedBy", OLD."approvedAt", OLD."rejectedBy", OLD."rejectedAt", OLD."rejectReason", OLD."appliedAt", OLD."replacementTransactionId") THEN
      RAISE EXCEPTION 'A correction decision cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'PENDING' AND NEW."status" = 'APPROVED' THEN
    IF NEW."approvedBy" IS NULL OR NEW."approvedAt" IS NULL OR NEW."approvedBy" = NEW."requestedBy" THEN
      RAISE EXCEPTION 'A correction is approved by someone other than the requester' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF OLD."status" = 'PENDING' AND NEW."status" = 'REJECTED' THEN
    IF NEW."rejectedBy" IS NULL OR NEW."rejectedAt" IS NULL OR length(coalesce(NEW."rejectReason", '')) < 5 THEN
      RAISE EXCEPTION 'A rejection records who, when and why' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF OLD."status" = 'APPROVED' AND NEW."status" = 'APPLIED' THEN
    IF NEW."appliedAt" IS NULL OR (NEW."kind" = 'REPLACE') <> (NEW."replacementTransactionId" IS NOT NULL)
       OR NOT EXISTS (SELECT 1 FROM "BankTransaction" WHERE "id" = NEW."transactionId" AND "status" = 'VOID') THEN
      RAISE EXCEPTION 'An applied correction has voided the original (and created its replacement)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'A correction cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "BankCorrection_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BankCorrection"
  FOR EACH ROW EXECUTE FUNCTION acc_guard_bank_correction();
