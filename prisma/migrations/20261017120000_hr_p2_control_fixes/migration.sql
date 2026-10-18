-- P-2 independent-review corrections, payroll-controls side (P1-A1, P2-A2, P2-A4, P3-A6).
-- Engineering CONTROLS only: no compensation formula, rate, cap or policy value is set here.
--
-- ADDITIVE:
--   · "HrPayrollRun"."controlAttestationId" (nullable, unique): a proposal-correction attestation
--     serves ONE run and expires with it (P1-A1); a guard checks it names an APPLIED attestation of
--     that corrected run and never changes;
--   · a NOT VALID CHECK: a NEW payment row carries an idempotency key (P2-A2). Rows written before
--     are not touched or re-validated;
--   · table "HrJournalLinkBaseline" (append-only) and a ONE-TIME capture, in this transaction, of a
--     baseline for every HR journal link written before posted lines were frozen (P2-A4): the
--     journal's lines per account and side, the posting key the account map resolves each account
--     to, and the account map as it stands. The capture reads existing rows and writes only the new
--     table. It is a snapshot for the accountant to review, not an approval;
--   · guards: the account map cannot change while a legacy link lacks a baseline; a new link always
--     records its posted lines (P2-A4); APPROVED → CANCELLED needs the run's HR-linked reversal of
--     its accrual; a journal HR posted keeps every header field (description, createdBy,
--     approvedBy, postedBy, dates, reversalReason, …) — only POSTED → REVERSED and updatedAt move
--     (P3-A6).
-- No existing column is changed or dropped and no existing row is updated. No existing trigger is
-- replaced. Atomic: one transaction.
--
-- ASSUMPTION (P3-A6): every guard below — like those of the earlier HR migrations — holds only
-- while the application's RUNTIME role cannot disable triggers: it must not own the HR tables, be
-- a superuser, or be allowed to SET session_replication_role (scripts/hr/grant-hr-runtime.sql
-- grants no TRIGGER, ownership or superuser right; RUNBOOK §6 makes this a deployment check).
--
-- Rollback: docs/hr/migration-review/rollback-20261017120000_hr_p2_control_fixes.sql (refuses while
-- a run relies on an attestation; drops the baselines — export them first).
BEGIN;

-- ── 1 · P1-A1: an attestation serves one correction run and expires with it ───────────────────
ALTER TABLE "HrPayrollRun" ADD COLUMN "controlAttestationId" TEXT;
CREATE UNIQUE INDEX "HrPayrollRun_controlAttestationId_key" ON "HrPayrollRun"("controlAttestationId");

CREATE OR REPLACE FUNCTION hr_run_attestation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."controlAttestationId" IS DISTINCT FROM OLD."controlAttestationId" THEN
    RAISE EXCEPTION 'HR: the attestation a payroll run relies on never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."controlAttestationId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "HrConfigChange" c
        WHERE c."id" = NEW."controlAttestationId" AND c."kind" = 'PAYROLL_CONTROL_ATTEST' AND c."status" = 'APPLIED'
          AND NEW."kind" = 'CORRECTION' AND c."targetKey" = 'PAYROLL_ATTEST:PROPOSAL_CORRECTION:' || NEW."correctsRunId") THEN
    RAISE EXCEPTION 'HR: a payroll run relies only on an applied attestation of the run it corrects' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_run_attestation_guard BEFORE INSERT OR UPDATE ON "HrPayrollRun"
  FOR EACH ROW EXECUTE FUNCTION hr_run_attestation_guard();

-- ── 2 · P2-A2: no new payment without an idempotency key ──────────────────────────────────────
ALTER TABLE "HrPayrollPayment" ADD CONSTRAINT "HrPayrollPayment_idempotency_required"
  CHECK ("idempotencyKey" IS NOT NULL) NOT VALID;

-- ── 3 · P2-A4: baselines for links written before posted lines were frozen ───────────────────
CREATE TABLE "HrJournalLinkBaseline" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "accountMap" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HrJournalLinkBaseline_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HrJournalLinkBaseline_lines" CHECK (jsonb_typeof("lines") = 'array'),
    CONSTRAINT "HrJournalLinkBaseline_map" CHECK (jsonb_typeof("accountMap") = 'object')
);
CREATE UNIQUE INDEX "HrJournalLinkBaseline_linkId_key" ON "HrJournalLinkBaseline"("linkId");
ALTER TABLE "HrJournalLinkBaseline" ADD CONSTRAINT "HrJournalLinkBaseline_linkId_fkey"
  FOREIGN KEY ("linkId") REFERENCES "HrJournalLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "HrJournalLinkBaseline_append_only" BEFORE UPDATE OR DELETE ON "HrJournalLinkBaseline"
  FOR EACH ROW EXECUTE FUNCTION hr_forbid_mutation();

-- One-time capture (reads only; writes only the new table). Amounts as 2-decimal text, like
-- "postedLines". A key is resolved through the account map as it stands; an account the map does
-- not name is "UNMAPPED", one named by several keys "AMBIGUOUS:K1|K2" (compared per account).
INSERT INTO "HrJournalLinkBaseline" ("id", "linkId", "journalEntryId", "lines", "accountMap", "source")
SELECT 'jlb_' || md5(l."id"), l."id", l."journalEntryId",
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object('key', k."key", 'accountId', x."acc", 'side', x."side", 'amount', (x."amt")::numeric(18,2)::text) ORDER BY x."side", k."key", x."acc")
           FROM (SELECT "accountId" AS "acc", 'D' AS "side", sum("debit") AS "amt" FROM "JournalEntryLine" WHERE "journalEntryId" = l."journalEntryId" AND "debit" > 0 GROUP BY 1
                 UNION ALL
                 SELECT "accountId", 'C', sum("credit") FROM "JournalEntryLine" WHERE "journalEntryId" = l."journalEntryId" AND "credit" > 0 GROUP BY 1) x
           CROSS JOIN LATERAL (
             SELECT CASE count(*) WHEN 0 THEN 'UNMAPPED' WHEN 1 THEN min(m."key") ELSE 'AMBIGUOUS:' || string_agg(m."key", '|' ORDER BY m."key") END AS "key"
               FROM "HrAccountMap" m WHERE m."accountId" = x."acc") k
       ), '[]'::jsonb),
       (SELECT COALESCE(jsonb_object_agg(m."key", m."accountId"), '{}'::jsonb) FROM "HrAccountMap" m),
       'migration:20261017120000_hr_p2_control_fixes'
  FROM "HrJournalLink" l
 WHERE l."postedLines" IS NULL;

-- The account map never changes while a legacy link has no baseline (its journal could no longer
-- be verified through a map nobody recorded).
CREATE OR REPLACE FUNCTION hr_account_map_baseline_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "HrJournalLink" l WHERE l."postedLines" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "HrJournalLinkBaseline" b WHERE b."linkId" = l."id")) THEN
    RAISE EXCEPTION 'HR: the account map cannot change while an HR journal link from before posted lines were frozen has no baseline' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_account_map_baseline_guard BEFORE INSERT OR UPDATE OR DELETE ON "HrAccountMap"
  FOR EACH ROW EXECUTE FUNCTION hr_account_map_baseline_guard();

-- From now on every link records what its journal posted (no new legacy link).
CREATE OR REPLACE FUNCTION hr_journal_link_posted_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."postedLines" IS NULL OR jsonb_typeof(NEW."postedLines") <> 'array' THEN
    RAISE EXCEPTION 'HR: a journal link records the lines its journal posted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_journal_link_posted_guard BEFORE INSERT ON "HrJournalLink"
  FOR EACH ROW EXECUTE FUNCTION hr_journal_link_posted_guard();

-- ── 4 · P3-A6: APPROVED → CANCELLED only with the HR-linked reversal of the accrual ──────────
CREATE OR REPLACE FUNCTION hr_payroll_run_cancel_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'APPROVED' AND NEW."status" = 'CANCELLED' AND NOT EXISTS (
       SELECT 1
         FROM "HrJournalLink" a
         JOIN "HrJournalLink" r ON r."sourceType" = 'PAYROLL_RUN' AND r."sourceId" = NEW."id" AND r."purpose" = 'REVERSAL'
         JOIN "JournalEntry" rev ON rev."id" = r."journalEntryId"
         JOIN "JournalEntry" acc ON acc."id" = a."journalEntryId"
        WHERE a."sourceType" = 'PAYROLL_RUN' AND a."sourceId" = NEW."id" AND a."purpose" = 'ACCRUAL'
          AND rev."reversesEntryId" = a."journalEntryId" AND acc."status" = 'REVERSED') THEN
    RAISE EXCEPTION 'HR: an approved payroll run is cancelled only with the HR-linked reversal of its accrual journal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_payroll_run_cancel_guard BEFORE UPDATE ON "HrPayrollRun"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_run_cancel_guard();

-- ── 5 · P3-A6: a journal HR posted keeps every header field ──────────────────────────────────
-- (hr_linked_journal_guard already freezes date, period, type, source, totals, currency and the
-- reversal link; this adds description, createdBy, submitted/approved/posted by and at,
-- reversalReason and any column added later. Only status — POSTED → REVERSED, checked there —
-- and the automatic updatedAt may move.)
CREATE OR REPLACE FUNCTION hr_linked_journal_header_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "HrJournalLink" WHERE "journalEntryId" = OLD."id")
     AND (to_jsonb(NEW) - ARRAY['status', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updatedAt']) THEN
    RAISE EXCEPTION 'HR: the header of a journal posted by HR never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_linked_journal_header_guard BEFORE UPDATE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION hr_linked_journal_header_guard();

COMMIT;
