-- R1-e gate (owner/orchestrator decision on 481bcb9b): an explicit «may have been delivered» flag instead of reading it
-- from the status note. Set by the senders when the answer to a send is lost (a dropped connection, a time-out, a 5xx)
-- and by the recovery of a row left SENDING:
--   "WhatsAppMessage" / "EmailMessage" — the message log's «إعادة» refuses a doubtful WhatsApp message (409
--     REVIEW_REQUIRED) and a doubtful e-mail once 24 h have passed since its first attempt (Resend keeps the
--     idempotency key 24 h, so within that window a retry cannot send twice);
--   "MktMessage" — the campaign messages (never resent on their own; the review screen comes later).
-- Existing rows are marked from the note the sender wrote for them.
BEGIN;

ALTER TABLE "WhatsAppMessage" ADD COLUMN "deliveryDoubt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmailMessage" ADD COLUMN "deliveryDoubt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MktMessage" ADD COLUMN "deliveryDoubt" BOOLEAN NOT NULL DEFAULT false;

UPDATE "WhatsAppMessage" SET "deliveryDoubt" = true WHERE status = 'FAILED' AND "statusNote" LIKE 'Interrupted while sending:%';
UPDATE "EmailMessage" SET "deliveryDoubt" = true WHERE status = 'FAILED' AND "statusNote" LIKE 'Interrupted while sending:%';
UPDATE "MktMessage" SET "deliveryDoubt" = true WHERE status = 'FAILED' AND "statusNote" LIKE '%قد تكون وصلت%';

-- «تحتاج مراجعة» lists and counts read only the doubtful rows.
CREATE INDEX "WhatsAppMessage_deliveryDoubt_idx" ON "WhatsAppMessage" ("status") WHERE "deliveryDoubt";
CREATE INDEX "EmailMessage_deliveryDoubt_idx" ON "EmailMessage" ("status") WHERE "deliveryDoubt";
CREATE INDEX "MktMessage_deliveryDoubt_idx" ON "MktMessage" ("status") WHERE "deliveryDoubt";

-- The runtime role writes all three tables already (the senders); restated so this migration stands on its own.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "WhatsAppMessage", "EmailMessage", "MktMessage" TO flowcom_app;
  END IF;
END $$;

COMMIT;
