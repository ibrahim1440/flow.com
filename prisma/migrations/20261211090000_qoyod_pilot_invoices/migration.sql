-- «وضع التجربة مع قيود» (owner's pilot, Nov–Dec 2026): ZATCA stays off in this system until the official go-live; the
-- tax invoice the customer receives is the one Qoyod issued. The accountant issues the same invoice here (internal copy,
-- TRN series) and attaches Qoyod's PDF with its number; the rep sends that PDF to the customer by WhatsApp and e-mail.
-- Additive only:
--   1. "SystemConfig"."qoyodPilotUntil": an invoice issued before this date is an internal copy (never a tax invoice:
--      watermarked, no QR, never sent from here). NULL = no pilot (the system as before).
--   2. "SalesInvoiceQoyod": Qoyod's tax-invoice PDF of one issued document (one row per document; a replacement bumps
--      "version" and keeps the send counters).
--   3. "EmailMessage": attachmentKind may also be 'qoyod_pdf'.
--   4. "WhatsAppMessage": "attachmentKind" / "attachmentRefId" (a document sent as a WhatsApp file; 'qoyod_pdf' only).
BEGIN;

ALTER TABLE "SystemConfig" ADD COLUMN "qoyodPilotUntil" DATE;

CREATE TABLE "SalesInvoiceQoyod" (
  "id"           TEXT         NOT NULL,
  "invoiceId"    TEXT         NOT NULL,
  "qoyodNumber"  TEXT         NOT NULL,
  "filename"     TEXT         NOT NULL,
  "mimeType"     TEXT         NOT NULL,
  "byteSize"     INTEGER      NOT NULL,
  "checksum"     TEXT         NOT NULL,
  "content"      BYTEA        NOT NULL,
  "version"      INTEGER      NOT NULL DEFAULT 1,
  "uploadedById" TEXT         NOT NULL,
  "uploadedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sendCount"    INTEGER      NOT NULL DEFAULT 0,
  "lastSentAt"   TIMESTAMP(3),
  "lastSentById" TEXT,
  CONSTRAINT "SalesInvoiceQoyod_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SalesInvoiceQoyod_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SalesInvoiceQoyod_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SalesInvoiceQoyod_lastSentById_fkey" FOREIGN KEY ("lastSentById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "SalesInvoiceQoyod_shape_check" CHECK (
    length(btrim("qoyodNumber")) BETWEEN 1 AND 60 AND "qoyodNumber" !~ '[\r\n]'
    AND length("filename") BETWEEN 1 AND 200
    AND "mimeType" = 'application/pdf'
    AND "byteSize" BETWEEN 1 AND 5242880 AND octet_length("content") = "byteSize"
    AND "checksum" ~ '^[0-9a-f]{64}$'
    AND "version" >= 1 AND "sendCount" >= 0
    AND (("sendCount" = 0) = ("lastSentAt" IS NULL))
  )
);
CREATE UNIQUE INDEX "SalesInvoiceQoyod_invoiceId_key" ON "SalesInvoiceQoyod"("invoiceId");
CREATE INDEX "SalesInvoiceQoyod_qoyodNumber_idx" ON "SalesInvoiceQoyod"("qoyodNumber");

-- A Qoyod copy belongs to an ISSUED document only (a draft has no tax invoice in Qoyod yet).
CREATE FUNCTION sales_invoice_qoyod_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SalesInvoice" WHERE id = NEW."invoiceId" AND status = 'ISSUED') THEN
    RAISE EXCEPTION 'QOYOD_COPY_NOT_ISSUED: a Qoyod tax invoice is attached to an issued document only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."invoiceId" <> OLD."invoiceId" THEN
    RAISE EXCEPTION 'QOYOD_COPY_MOVED: a Qoyod copy never moves to another document' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_invoice_qoyod_guard BEFORE INSERT OR UPDATE ON "SalesInvoiceQoyod" FOR EACH ROW EXECUTE FUNCTION sales_invoice_qoyod_guard();

ALTER TABLE "EmailMessage" DROP CONSTRAINT "EmailMessage_shape_check";
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_shape_check" CHECK (
  "channel" = 'email'
  AND "dedupeKey" LIKE 'email:%'
  AND "planMode" IN ('OFF', 'TEST', 'LIVE')
  AND ("attachmentKind" IS NULL OR ("attachmentKind" IN ('quote_pdf', 'qoyod_pdf') AND "attachmentRefId" IS NOT NULL))
  AND ("attachmentSha256" IS NULL OR "attachmentSha256" ~ '^[0-9a-f]{64}$')
  AND ("toEmail" IS NULL OR "toEmail" = lower("toEmail"))
  AND length("subject") <= 200 AND "subject" !~ '[\r\n]'
  AND ("bodyArchivedAt" IS NULL OR "status"::text NOT IN ('QUEUED', 'SENDING'))
);

ALTER TABLE "WhatsAppMessage" ADD COLUMN "attachmentKind" TEXT, ADD COLUMN "attachmentRefId" TEXT;
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_attachment_check" CHECK (
  "attachmentKind" IS NULL OR ("attachmentKind" = 'qoyod_pdf' AND "attachmentRefId" IS NOT NULL)
);

-- The runtime role reads and writes the copies (as the other invoicing tables); the bytes are never DELETEd by the app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "SalesInvoiceQoyod" TO flowcom_app;
  END IF;
END $$;

COMMIT;
