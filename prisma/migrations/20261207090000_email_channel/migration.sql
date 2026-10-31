-- Batch 25: the e-mail channel for customer automation, phase 1 (owner decisions, 31 Oct 2026). ADDITIVE ONLY, one
-- transaction (PostgreSQL 16 / 17). No enum value is added to an existing type (so nothing here can trip 55P04).
--
--   1. "AutomationSettings": the e-mail channel's own sending mode "emailSendMode" (the existing OFF / TEST / LIVE type,
--      default OFF — independent of the WhatsApp "sendMode"), its test address "testEmail" (lower-case, CHECK) and
--      "testEmailVerifiedAt" (set when a test e-mail reached that address; LIVE is refused without one in the last 30
--      days), and who / when last changed the e-mail settings.
--   2. "Customer": "emailOptOut" (default false) with "emailOptOutAt" and "emailOptOutSource" (CHECK: customer_link |
--      staff | complaint | bounce) — «يستقبل إيميلات», separate from "whatsappOptOut".
--   3. "WhatsAppStatusRule": "emailEnabled" (default false) and "emailSubject" — the «إيميل» checkbox next to WhatsApp in
--      «إشعارات الحالات». CHECK: never on the tax-invoice source (locked until ZATCA clears / reports invoices).
--   4. "WhatsAppMessage": "channel" (constant 'whatsapp', CHECK) and "bodyArchivedAt" (the 180-day archive moved the
--      body). Every message row now names its channel; the e-mail rows live in their own table (5).
--   5. The e-mail log: "EmailMessageStatus", "EmailMessage" (channel constant 'email', dedupe keys namespaced 'email:',
--      the Resend message id and HTTP status, the document reference + sha256 of the PDF sent — never the PDF),
--      "EmailSendAttempt", "EmailSuppression" (hard bounces and complaints: never sent to again) and
--      "EmailProviderEvent" (the Resend webhook's svix-id: the webhook is idempotent).
--   6. "MessageArchive": message bodies older than 180 days, MOVED here from both logs by the daily job
--      (/api/cron/message-archive). Immutable: message_archive_immutable() refuses UPDATE / DELETE / TRUNCATE (an
--      explicit admin purge, not built, would set hiqbah.message_archive_purge as the migrate role; the test-cleanup
--      setting of a throwaway database is honoured for the same roles), and the runtime role loses UPDATE / DELETE.
--   7. The runtime role (flowcom_app), when it exists, is granted the new tables. Nothing for erp_app (retired).
--
-- Row counts touched: none rewritten. Constant defaults (metadata only) and nullable columns; the CHECKs hold for every
-- existing row (no test e-mail, no opt-out source, no e-mail switch, every message is a WhatsApp message).
--   8. Fix round 1 (council b25): "AutomationSettings"."replyToEmail" («بريد الردود», the company reply address when the rep
--      has no work e-mail); "Customer"."emailOptOutNote" (the opt-out history, appended, never overwritten) and
--      "Customer"."emailLinkId" (an opaque id the signed unsubscribe link carries instead of the customer id); a CHECK on
--      both logs that a QUEUED / SENDING row always still has its body (an archived message can never be re-sent empty);
--      and the partial indexes the archive job walks with a keyset cursor (rows that still have a body).
--
-- Locking: SET LOCAL lock_timeout bounds the wait for each table lock (the migration fails rather than queueing behind a
-- long transaction); every CHECK on an existing table is added NOT VALID, then VALIDATEd (the verifier requires
-- validated constraints).
-- Rollback: docs/hr/migration-review/rollback-20261207090000_email_channel.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1 ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "AutomationSettings" ADD COLUMN "emailSendMode"       "WhatsAppSendMode" NOT NULL DEFAULT 'OFF';
ALTER TABLE "AutomationSettings" ADD COLUMN "testEmail"           TEXT;
ALTER TABLE "AutomationSettings" ADD COLUMN "testEmailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "AutomationSettings" ADD COLUMN "emailUpdatedById"    TEXT;
ALTER TABLE "AutomationSettings" ADD COLUMN "emailUpdatedAt"      TIMESTAMP(3);
ALTER TABLE "AutomationSettings" ADD COLUMN "replyToEmail"        TEXT;
ALTER TABLE "AutomationSettings" ADD CONSTRAINT "AutomationSettings_test_email_check" CHECK (
  ("testEmail" IS NULL OR ("testEmail" = lower("testEmail") AND "testEmail" ~ '^[^@[:space:],;<>]+@[^@[:space:],;<>]+\.[a-z]{2,}$' AND length("testEmail") <= 254))
  AND ("replyToEmail" IS NULL OR ("replyToEmail" = lower("replyToEmail") AND "replyToEmail" ~ '^[^@[:space:],;<>]+@[^@[:space:],;<>]+\.[a-z]{2,}$' AND length("replyToEmail") <= 254))
) NOT VALID;
ALTER TABLE "AutomationSettings" VALIDATE CONSTRAINT "AutomationSettings_test_email_check";
ALTER TABLE "AutomationSettings" ADD CONSTRAINT "AutomationSettings_email_verified_check" CHECK (
  "testEmailVerifiedAt" IS NULL OR "testEmail" IS NOT NULL
) NOT VALID;
ALTER TABLE "AutomationSettings" VALIDATE CONSTRAINT "AutomationSettings_email_verified_check";

-- 2 ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Customer" ADD COLUMN "emailOptOut"       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Customer" ADD COLUMN "emailOptOutAt"     TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN "emailOptOutSource" TEXT;
ALTER TABLE "Customer" ADD COLUMN "emailOptOutNote"   TEXT;
ALTER TABLE "Customer" ADD COLUMN "emailLinkId"       TEXT;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_email_opt_out_check" CHECK (
  ("emailOptOutSource" IS NULL OR "emailOptOutSource" IN ('customer_link', 'staff', 'complaint', 'bounce'))
  AND ("emailLinkId" IS NULL OR "emailLinkId" ~ '^[A-Za-z0-9_-]{16,64}$')
) NOT VALID;
ALTER TABLE "Customer" VALIDATE CONSTRAINT "Customer_email_opt_out_check";
CREATE UNIQUE INDEX "Customer_emailLinkId_key" ON "Customer"("emailLinkId");

-- 3 ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "WhatsAppStatusRule" ADD COLUMN "emailEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WhatsAppStatusRule" ADD COLUMN "emailSubject" TEXT;
ALTER TABLE "WhatsAppStatusRule" ADD CONSTRAINT "WhatsAppStatusRule_email_check" CHECK (
  NOT ("emailEnabled" AND "source" = 'sales_invoice')
  AND ("emailSubject" IS NULL OR (length("emailSubject") <= 150 AND "emailSubject" !~ '[\r\n]'))
) NOT VALID;
ALTER TABLE "WhatsAppStatusRule" VALIDATE CONSTRAINT "WhatsAppStatusRule_email_check";

-- 4 ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "WhatsAppMessage" ADD COLUMN "channel"        TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE "WhatsAppMessage" ADD COLUMN "bodyArchivedAt" TIMESTAMP(3);
-- One CHECK: the channel, and a message still waiting or in flight always has its body (archived → never re-sent).
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_channel_check" CHECK (
  "channel" = 'whatsapp' AND ("bodyArchivedAt" IS NULL OR "status"::text NOT IN ('QUEUED', 'SENDING'))
) NOT VALID;
ALTER TABLE "WhatsAppMessage" VALIDATE CONSTRAINT "WhatsAppMessage_channel_check";
-- The archive job's keyset walk: only rows that still have a body (the archived ones drop out of the index).
CREATE INDEX "WhatsAppMessage_unarchived_idx" ON "WhatsAppMessage"("createdAt", "id") WHERE "bodyArchivedAt" IS NULL;

-- 5 ────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "EmailMessageStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'SKIPPED', 'CANCELLED');

CREATE TABLE "EmailMessage" (
  "id"                TEXT                 NOT NULL,
  "channel"           TEXT                 NOT NULL DEFAULT 'email',
  "dedupeKey"         TEXT                 NOT NULL,
  "ruleId"            TEXT,
  "ruleName"          TEXT,
  "eventId"           TEXT,
  "eventType"         TEXT,
  "subjectType"       TEXT,
  "subjectId"         TEXT,
  "stepIndex"         INTEGER,
  "recipientKind"     TEXT                 NOT NULL,
  "recipientName"     TEXT,
  "customerId"        TEXT,
  "toEmail"           TEXT,
  "intendedEmail"     TEXT,
  "planMode"          TEXT                 NOT NULL,
  "subject"           TEXT                 NOT NULL,
  "bodyText"          TEXT                 NOT NULL DEFAULT '',
  "bodyArchivedAt"    TIMESTAMP(3),
  "attachmentKind"    TEXT,
  "attachmentRefId"   TEXT,
  "attachmentSha256"  TEXT,
  "status"            "EmailMessageStatus" NOT NULL DEFAULT 'QUEUED',
  "statusNote"        TEXT,
  "scheduledAt"       TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextAttemptAt"     TIMESTAMP(3),
  "attempts"          INTEGER              NOT NULL DEFAULT 0,
  "lockedAt"          TIMESTAMP(3),
  "providerMessageId" TEXT,
  "httpStatus"        INTEGER,
  "sentAt"            TIMESTAMP(3),
  "deliveredAt"       TIMESTAMP(3),
  "bouncedAt"         TIMESTAMP(3),
  "complainedAt"      TIMESTAMP(3),
  "createdById"       TEXT,
  "createdAt"         TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailMessage_shape_check" CHECK (
    "channel" = 'email'
    AND "dedupeKey" LIKE 'email:%'
    AND "planMode" IN ('OFF', 'TEST', 'LIVE')
    AND ("attachmentKind" IS NULL OR ("attachmentKind" = 'quote_pdf' AND "attachmentRefId" IS NOT NULL))
    AND ("attachmentSha256" IS NULL OR "attachmentSha256" ~ '^[0-9a-f]{64}$')
    AND ("toEmail" IS NULL OR "toEmail" = lower("toEmail"))
    AND length("subject") <= 200 AND "subject" !~ '[\r\n]'
    AND ("bodyArchivedAt" IS NULL OR "status"::text NOT IN ('QUEUED', 'SENDING'))
  )
);
CREATE UNIQUE INDEX "EmailMessage_dedupeKey_key" ON "EmailMessage"("dedupeKey");
CREATE UNIQUE INDEX "EmailMessage_providerMessageId_key" ON "EmailMessage"("providerMessageId");
CREATE INDEX "EmailMessage_status_scheduledAt_idx" ON "EmailMessage"("status", "scheduledAt");
CREATE INDEX "EmailMessage_subjectType_subjectId_idx" ON "EmailMessage"("subjectType", "subjectId");
CREATE INDEX "EmailMessage_customerId_createdAt_idx" ON "EmailMessage"("customerId", "createdAt");
CREATE INDEX "EmailMessage_createdAt_idx" ON "EmailMessage"("createdAt");
CREATE INDEX "EmailMessage_unarchived_idx" ON "EmailMessage"("createdAt", "id") WHERE "bodyArchivedAt" IS NULL;

CREATE TABLE "EmailSendAttempt" (
  "id"                TEXT         NOT NULL,
  "messageId"         TEXT         NOT NULL,
  "attemptNo"         INTEGER      NOT NULL,
  "ok"                BOOLEAN      NOT NULL,
  "httpStatus"        INTEGER,
  "providerMessageId" TEXT,
  "error"             TEXT,
  "durationMs"        INTEGER,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailSendAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailSendAttempt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "EmailSendAttempt_messageId_idx" ON "EmailSendAttempt"("messageId");

CREATE TABLE "EmailSuppression" (
  "email"           TEXT         NOT NULL,
  "reason"          TEXT         NOT NULL,
  "providerEventId" TEXT,
  "createdById"     TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("email"),
  CONSTRAINT "EmailSuppression_shape_check" CHECK ("email" = lower("email") AND "reason" IN ('HARD_BOUNCE', 'COMPLAINT', 'MANUAL'))
);

CREATE TABLE "EmailProviderEvent" (
  "id"                TEXT         NOT NULL,
  "type"              TEXT         NOT NULL,
  "providerMessageId" TEXT,
  "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailProviderEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailProviderEvent_providerMessageId_idx" ON "EmailProviderEvent"("providerMessageId");

-- 6 ────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "MessageArchive" (
  "id"               TEXT         NOT NULL,
  "channel"          TEXT         NOT NULL,
  "messageId"        TEXT         NOT NULL,
  "customerId"       TEXT,
  "recipientName"    TEXT,
  "address"          TEXT,
  "subject"          TEXT,
  "body"             TEXT         NOT NULL,
  "ruleName"         TEXT,
  "subjectType"      TEXT,
  "subjectId"        TEXT,
  "docKind"          TEXT,
  "docRefId"         TEXT,
  "docSha256"        TEXT,
  "status"           TEXT         NOT NULL,
  "messageCreatedAt" TIMESTAMP(3) NOT NULL,
  "sentAt"           TIMESTAMP(3),
  "archivedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageArchive_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MessageArchive_channel_check" CHECK ("channel" IN ('whatsapp', 'email'))
);
CREATE UNIQUE INDEX "MessageArchive_channel_messageId_key" ON "MessageArchive"("channel", "messageId");
CREATE INDEX "MessageArchive_customerId_messageCreatedAt_idx" ON "MessageArchive"("customerId", "messageCreatedAt");
CREATE INDEX "MessageArchive_messageCreatedAt_idx" ON "MessageArchive"("messageCreatedAt");

-- The archive keeps what was sent for legal claims: no row is changed or deleted by the application. The only way out is
-- an explicit purge by the migrate / owner role (not built): SET hiqbah.message_archive_purge = 'admin-purge-confirmed'.
-- A throwaway test database whose provisioning sets hiqbah.audit_purge = 'test-cleanup' may clean its fixture rows the
-- same way. Neither is ever honoured for the runtime role (flowcom_app), which also holds no UPDATE / DELETE here.
CREATE OR REPLACE FUNCTION message_archive_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'flowcom_app' AND (
       coalesce(current_setting('hiqbah.message_archive_purge', true), '') = 'admin-purge-confirmed'
    OR coalesce(current_setting('hiqbah.audit_purge', true), '') = 'test-cleanup') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD WHEN TG_OP = 'UPDATE' THEN NEW ELSE NULL END;
  END IF;
  RAISE EXCEPTION 'MESSAGE_ARCHIVE_IMMUTABLE: archived messages are never changed or deleted (%)', TG_OP USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER message_archive_immutable BEFORE UPDATE OR DELETE ON "MessageArchive" FOR EACH ROW EXECUTE FUNCTION message_archive_immutable();
CREATE TRIGGER message_archive_no_truncate BEFORE TRUNCATE ON "MessageArchive" FOR EACH STATEMENT EXECUTE FUNCTION message_archive_immutable();

-- 7 ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "EmailMessage", "EmailSendAttempt", "EmailSuppression", "EmailProviderEvent" TO flowcom_app;
    GRANT SELECT, INSERT ON "MessageArchive" TO flowcom_app;
    REVOKE UPDATE, DELETE ON "MessageArchive" FROM flowcom_app;
  END IF;
END $$;

COMMIT;
