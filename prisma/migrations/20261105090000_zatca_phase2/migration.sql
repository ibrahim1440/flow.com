-- ZATCA Phase 2 (Fatoora) e-invoicing — accounting phase A4 (feat/zatca-phase2), on top of sales invoicing A2
-- (20261103090000_sales_invoicing). Owner authorisation: ZATCA Phase 2. Nothing here talks to ZATCA: the
-- application does, and only when the owner switches it on (ZatcaSettings.mode + ZATCA_ENABLED on the server).
--
-- The database guarantees (docs/accounting/POSTING-CONTRACT.md §11, docs/zatca/RUNBOOK.md):
--   1. THE CHAIN — an EGS unit starts at ICV 0 with the initial PIH (base64 of the hex SHA-256 of "0"); its ICV only
--      ever moves by exactly one, and only together with the hash of the document that took it; it never resets,
--      never skips; its environment and serial never change, nor its CSR particulars once onboarded; a unit that
--      holds a CSID or signed a document is never deleted (zatca_egs_guard).
--   2. THE DOCUMENT — an e-invoice takes the EGS unit's current ICV and hash (the issuer moved them in the same
--      transaction, under the unit's row lock); its PIH is the hash of the document with ICV − 1 of the same unit
--      (or the initial PIH); it belongs to an ISSUED invoice with the same UUID, cleared if standard and reported if
--      simplified; the signed XML is stored as bytes with its SHA-256 and never changes; the cleared XML is written
--      once, as returned; ZATCA's decision (cleared / reported / rejected) is final; nothing is deleted
--      (zatca_document_guard). One e-invoice per invoice; one document per (EGS unit, ICV).
--   3. THE INVOICE COLUMNS — SalesInvoice.zatcaIcv / zatcaPih / zatcaInvoiceHash / zatcaXmlRef are written once;
--      zatcaQr once, and once more only to the cleared QR (zatca_sinv_columns; A2's guard already freezes the rest).
--   4. CSIDs — token, secret and certificate never change; ACTIVE → SUPERSEDED / REVOKED only (zatca_csid_guard).
--   5. NUMBERING CUT-OVER — a series counter may be set to start after a previous system's last number only while
--      the series has issued nothing; then it moves by one only and is never deleted (zatca_counter_guard).
--   6. THE LOG — ZatcaLog is append-only; ZatcaLog / ZatcaDocument / ZatcaEgsUnit / ZatcaCsid refuse TRUNCATE.
--   7. AUDIT — settings, EGS units and CSIDs are written to "AccountingAuditLog" without keys, secrets or XML
--      (zatca_audit_row).
--
-- ADDITIVE: five new, empty tables; two nullable "SalesInvoice" columns (channel, externalOrderRef: one document per
-- external order) with a CHECK every existing row satisfies (NULL) and a unique index; zatca_* functions; their triggers on the new tables, plus one BEFORE UPDATE
-- trigger on "SalesInvoice" (its zatca* columns only) and one on "SalesDocumentCounter". No existing row is read or
-- rewritten. Grants: re-run scripts/hr/grant-hr-runtime.sql (tables + zatca_* functions).
-- Atomic: one transaction. Rollback: docs/hr/migration-review/rollback-20261105090000_zatca_phase2.sql.
BEGIN;

-- CreateTable
CREATE TABLE "ZatcaSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "mode" TEXT NOT NULL DEFAULT 'OFF',
    "activeEgsId" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZatcaSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZatcaEgsUnit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "environment" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "commonName" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "organizationName" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "branchId" TEXT,
    "vatNumber" TEXT NOT NULL,
    "invoiceTypes" TEXT NOT NULL DEFAULT '1100',
    "location" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "csidState" TEXT NOT NULL DEFAULT 'NONE',
    "privateKeyEnc" TEXT,
    "publicKeyPem" TEXT,
    "csrPem" TEXT,
    "keyVersion" INTEGER NOT NULL DEFAULT 0,
    "pendingPrivateKeyEnc" TEXT,
    "pendingCsrPem" TEXT,
    "icv" BIGINT NOT NULL DEFAULT 0,
    "lastHash" TEXT NOT NULL DEFAULT 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',
    "lastDocumentAt" TIMESTAMP(3),
    "complianceChecks" JSONB,
    "complianceCheckedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZatcaEgsUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZatcaCsid" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "egsId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "certSerial" TEXT NOT NULL,
    "certIssuer" TEXT NOT NULL,
    "certSha256" TEXT NOT NULL,
    "certNotBefore" TIMESTAMP(3),
    "certNotAfter" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "ZatcaCsid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZatcaDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "invoiceId" TEXT NOT NULL,
    "egsId" TEXT NOT NULL,
    "csidId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "icv" BIGINT NOT NULL,
    "pih" TEXT NOT NULL,
    "invoiceHash" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "flow" TEXT NOT NULL,
    "signedXml" BYTEA NOT NULL,
    "signedXmlSha256" TEXT NOT NULL,
    "clearedXml" BYTEA,
    "clearedXmlSha256" TEXT,
    "qr" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "lastHttpStatus" INTEGER,
    "lastError" TEXT,
    "warnings" JSONB,
    "errors" JSONB,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "reportingDeadline" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZatcaDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZatcaLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
    "egsId" TEXT,
    "documentId" TEXT,
    "action" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "outcome" TEXT NOT NULL,
    "durationMs" INTEGER,
    "attempt" INTEGER,
    "request" JSONB,
    "response" JSONB,
    "actorId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZatcaLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ZatcaEgsUnit_serialNumber_key" ON "ZatcaEgsUnit"("serialNumber");

-- CreateIndex
CREATE INDEX "ZatcaEgsUnit_environment_csidState_idx" ON "ZatcaEgsUnit"("environment", "csidState");

-- CreateIndex
CREATE INDEX "ZatcaCsid_egsId_kind_status_idx" ON "ZatcaCsid"("egsId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ZatcaDocument_invoiceId_key" ON "ZatcaDocument"("invoiceId");

-- CreateIndex
CREATE INDEX "ZatcaDocument_status_nextAttemptAt_idx" ON "ZatcaDocument"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ZatcaDocument_flow_status_signedAt_idx" ON "ZatcaDocument"("flow", "status", "signedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ZatcaDocument_egsId_icv_key" ON "ZatcaDocument"("egsId", "icv");

-- CreateIndex
CREATE INDEX "ZatcaLog_egsId_at_idx" ON "ZatcaLog"("egsId", "at");

-- CreateIndex
CREATE INDEX "ZatcaLog_documentId_at_idx" ON "ZatcaLog"("documentId", "at");

-- CreateIndex
CREATE INDEX "ZatcaLog_action_at_idx" ON "ZatcaLog"("action", "at");

-- AddForeignKey
ALTER TABLE "ZatcaCsid" ADD CONSTRAINT "ZatcaCsid_egsId_fkey" FOREIGN KEY ("egsId") REFERENCES "ZatcaEgsUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZatcaDocument" ADD CONSTRAINT "ZatcaDocument_egsId_fkey" FOREIGN KEY ("egsId") REFERENCES "ZatcaEgsUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable (A4 · an invoice from an external order source, e.g. the Salla web shop later: nullable, NULL in every row)
ALTER TABLE "SalesInvoice" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "externalOrderRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SalesInvoice_tenantId_channel_externalOrderRef_key" ON "SalesInvoice"("tenantId", "channel", "externalOrderRef");


-- ── CHECKs ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_channel_check" CHECK (("channel" IS NULL OR "channel" ~ '^[A-Z0-9_]{1,20}$')
  AND ("externalOrderRef" IS NULL OR ("channel" IS NOT NULL AND length(btrim("externalOrderRef")) BETWEEN 1 AND 100)));

ALTER TABLE "ZatcaSettings" ADD CONSTRAINT "ZatcaSettings_check" CHECK ("id" = 'singleton' AND "mode" IN ('OFF', 'SANDBOX', 'SIMULATION', 'PRODUCTION'));

ALTER TABLE "ZatcaEgsUnit" ADD CONSTRAINT "ZatcaEgsUnit_check" CHECK (
      "environment" IN ('SANDBOX', 'SIMULATION', 'PRODUCTION')
  AND "csidState" IN ('NONE', 'COMPLIANCE', 'PRODUCTION', 'RENEWED', 'REVOKED')
  AND "vatNumber" ~ '^3[0-9]{13}3$'
  AND "invoiceTypes" ~ '^[01]{4}$' AND "invoiceTypes" <> '0000'
  AND "serialNumber" ~ '^1-.+\|2-.+\|3-.+$'
  AND "icv" >= 0 AND "keyVersion" >= 0
  AND (length("lastHash") = 44 OR "lastHash" = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==')
  AND ("csidState" = 'NONE' OR ("privateKeyEnc" IS NOT NULL AND "csrPem" IS NOT NULL)));

ALTER TABLE "ZatcaCsid" ADD CONSTRAINT "ZatcaCsid_check" CHECK (
      "kind" IN ('COMPLIANCE', 'PRODUCTION') AND "status" IN ('ACTIVE', 'SUPERSEDED', 'REVOKED')
  AND ("status" = 'ACTIVE') = ("supersededAt" IS NULL));

ALTER TABLE "ZatcaDocument" ADD CONSTRAINT "ZatcaDocument_check" CHECK (
      "environment" IN ('SANDBOX', 'SIMULATION', 'PRODUCTION')
  AND "flow" IN ('CLEARANCE', 'REPORTING')
  AND "status" IN ('PENDING', 'CLEARED', 'CLEARED_WITH_WARNINGS', 'REPORTED', 'REPORTED_WITH_WARNINGS', 'REJECTED', 'ERROR')
  AND "icv" > 0 AND length("invoiceHash") = 44
  AND (length("pih") = 44 OR ("icv" = 1 AND "pih" = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==')) AND "attempts" >= 0
  AND ("status" NOT IN ('CLEARED', 'CLEARED_WITH_WARNINGS') OR ("flow" = 'CLEARANCE' AND "clearedXml" IS NOT NULL))
  AND ("status" NOT IN ('REPORTED', 'REPORTED_WITH_WARNINGS') OR "flow" = 'REPORTING')
  AND ("clearedXml" IS NULL) = ("clearedXmlSha256" IS NULL));

ALTER TABLE "ZatcaLog" ADD CONSTRAINT "ZatcaLog_check" CHECK (
  "action" IN ('COMPLIANCE_CSID', 'COMPLIANCE_CHECK', 'PRODUCTION_CSID', 'RENEW_CSID', 'CLEARANCE', 'REPORTING', 'EGS_CREATED', 'KEYS_GENERATED', 'SETTINGS', 'NUMBERING', 'REVOKED'));

-- ── 1 · the EGS unit: the counter only moves by one, with its hash; identity fixed; never deleted once used ──
CREATE OR REPLACE FUNCTION zatca_egs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."icv" > 0 OR OLD."csidState" <> 'NONE' THEN
      RAISE EXCEPTION 'ZATCA: an EGS unit that holds a CSID or has signed a document is never deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."icv" <> 0 OR NEW."lastHash" <> 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==' THEN
      RAISE EXCEPTION 'ZATCA: an EGS unit starts at ICV 0 with the initial PIH' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."environment" <> OLD."environment" OR NEW."serialNumber" <> OLD."serialNumber" OR NEW."tenantId" <> OLD."tenantId" THEN
    RAISE EXCEPTION 'ZATCA: an EGS unit keeps its id, environment and serial number' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."csidState" <> 'NONE' AND (NEW."vatNumber" <> OLD."vatNumber" OR NEW."commonName" <> OLD."commonName" OR NEW."organizationName" <> OLD."organizationName"
       OR NEW."branchName" <> OLD."branchName" OR NEW."invoiceTypes" <> OLD."invoiceTypes" OR NEW."location" <> OLD."location" OR NEW."industry" <> OLD."industry") THEN
    RAISE EXCEPTION 'ZATCA: the CSR particulars of an onboarded EGS unit never change (onboard a new unit)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."icv" = OLD."icv" THEN
    IF NEW."lastHash" <> OLD."lastHash" THEN
      RAISE EXCEPTION 'ZATCA: the last hash changes only with the next ICV' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW."icv" <> OLD."icv" + 1 THEN
    RAISE EXCEPTION 'ZATCA: the ICV of an EGS unit never resets or skips (% → %)', OLD."icv", NEW."icv" USING ERRCODE = 'integrity_constraint_violation';
  ELSIF NEW."lastHash" = OLD."lastHash" THEN
    RAISE EXCEPTION 'ZATCA: the next ICV comes with the hash of its document' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."privateKeyEnc" IS NOT NULL AND NEW."privateKeyEnc" IS DISTINCT FROM OLD."privateKeyEnc" AND NEW."keyVersion" <> OLD."keyVersion" + 1 THEN
    RAISE EXCEPTION 'ZATCA: a key is replaced only by a renewal (key version + 1)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."csidState" = 'REVOKED' AND NEW."csidState" <> 'REVOKED' THEN
    RAISE EXCEPTION 'ZATCA: a revoked EGS unit stays revoked' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER zatca_egs_guard BEFORE INSERT OR UPDATE OR DELETE ON "ZatcaEgsUnit" FOR EACH ROW EXECUTE FUNCTION zatca_egs_guard();

-- ── 2 · the CSID: its token, secret and certificate never change; ACTIVE → SUPERSEDED / REVOKED only ──
CREATE OR REPLACE FUNCTION zatca_csid_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ZATCA: a CSID record is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'supersededAt']) <> (to_jsonb(OLD) - ARRAY['status', 'supersededAt']) THEN
    RAISE EXCEPTION 'ZATCA: a CSID record never changes (only its status)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'ACTIVE' AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'ZATCA: a superseded or revoked CSID stays so' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER zatca_csid_guard BEFORE UPDATE OR DELETE ON "ZatcaCsid" FOR EACH ROW EXECUTE FUNCTION zatca_csid_guard();

-- ── 3 · the document: next in the EGS chain; the signed XML as signed, forever; the cleared XML written once ──
CREATE OR REPLACE FUNCTION zatca_document_guard() RETURNS trigger AS $$
DECLARE e RECORD; prev text; inv RECORD;
  fixed text[] := ARRAY['status', 'attempts', 'nextAttemptAt', 'leaseUntil', 'lastHttpStatus', 'lastError', 'warnings', 'errors',
                        'submittedAt', 'decidedAt', 'updatedAt', 'clearedXml', 'clearedXmlSha256'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ZATCA: an e-invoice is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The EGS unit has already moved to this ICV and hash in this transaction (row locked by the issuer).
    SELECT "icv", "lastHash", "environment" INTO e FROM "ZatcaEgsUnit" WHERE "id" = NEW."egsId" FOR UPDATE;
    IF NOT FOUND OR e."icv" <> NEW."icv" OR e."lastHash" <> NEW."invoiceHash" OR e."environment" <> NEW."environment" THEN
      RAISE EXCEPTION 'ZATCA: a document takes the next ICV of its EGS unit with its own hash' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."icv" = 1 THEN
      prev := 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';
    ELSE
      SELECT d."invoiceHash" INTO prev FROM "ZatcaDocument" d WHERE d."egsId" = NEW."egsId" AND d."icv" = NEW."icv" - 1;
    END IF;
    IF prev IS NULL OR NEW."pih" <> prev THEN
      RAISE EXCEPTION 'ZATCA: the PIH is the hash of the previous document of the same EGS unit' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."signedXmlSha256" <> encode(sha256(NEW."signedXml"), 'hex') THEN
      RAISE EXCEPTION 'ZATCA: the signed XML digest does not match its bytes' USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."status", i."uuid"::text AS uuid, i."family" INTO inv FROM "SalesInvoice" i WHERE i."id" = NEW."invoiceId";
    IF NOT FOUND OR inv."status" <> 'ISSUED' OR inv.uuid <> NEW."uuid"
       OR (inv."family" = 'STANDARD') <> (NEW."flow" = 'CLEARANCE') THEN
      RAISE EXCEPTION 'ZATCA: an e-invoice belongs to an ISSUED invoice, with its UUID, cleared if standard and reported if simplified' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'PENDING' OR NEW."clearedXml" IS NOT NULL THEN
      RAISE EXCEPTION 'ZATCA: an e-invoice is born PENDING' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF (to_jsonb(NEW) - fixed) <> (to_jsonb(OLD) - fixed) THEN
    RAISE EXCEPTION 'ZATCA: the signed e-invoice never changes (a correction is a credit or debit note)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."clearedXml" IS NOT NULL AND (NEW."clearedXml" IS DISTINCT FROM OLD."clearedXml" OR NEW."clearedXmlSha256" IS DISTINCT FROM OLD."clearedXmlSha256") THEN
    RAISE EXCEPTION 'ZATCA: the cleared XML is stored once, as ZATCA returned it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."clearedXml" IS NOT NULL AND NEW."clearedXmlSha256" <> encode(sha256(NEW."clearedXml"), 'hex') THEN
    RAISE EXCEPTION 'ZATCA: the cleared XML digest does not match its bytes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('CLEARED', 'CLEARED_WITH_WARNINGS', 'REPORTED', 'REPORTED_WITH_WARNINGS', 'REJECTED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'ZATCA: ZATCA''s decision on an e-invoice is final (%)', OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER zatca_document_guard BEFORE INSERT OR UPDATE OR DELETE ON "ZatcaDocument" FOR EACH ROW EXECUTE FUNCTION zatca_document_guard();

-- ── 4 · the invoice's ZATCA columns (A2 left them writable after issue): written once, the QR once more at clearance ──
CREATE OR REPLACE FUNCTION zatca_sinv_columns() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'ISSUED' THEN
    IF NEW."zatcaIcv" IS NOT NULL OR NEW."zatcaPih" IS NOT NULL OR NEW."zatcaInvoiceHash" IS NOT NULL OR NEW."zatcaQr" IS NOT NULL OR NEW."zatcaStatus" IS NOT NULL OR NEW."zatcaXmlRef" IS NOT NULL THEN
      IF NEW."status" <> 'ISSUED' THEN
        RAISE EXCEPTION 'ZATCA: only an issued invoice carries e-invoice data' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF (OLD."zatcaIcv" IS NOT NULL AND NEW."zatcaIcv" IS DISTINCT FROM OLD."zatcaIcv")
     OR (OLD."zatcaPih" IS NOT NULL AND NEW."zatcaPih" IS DISTINCT FROM OLD."zatcaPih")
     OR (OLD."zatcaInvoiceHash" IS NOT NULL AND NEW."zatcaInvoiceHash" IS DISTINCT FROM OLD."zatcaInvoiceHash")
     OR (OLD."zatcaXmlRef" IS NOT NULL AND NEW."zatcaXmlRef" IS DISTINCT FROM OLD."zatcaXmlRef") THEN
    RAISE EXCEPTION 'ZATCA: an invoice keeps its ICV, PIH, hash and e-invoice reference' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."zatcaQr" IS NOT NULL AND NEW."zatcaQr" IS DISTINCT FROM OLD."zatcaQr"
     AND NOT (NEW."zatcaStatus" IN ('CLEARED', 'CLEARED_WITH_WARNINGS') AND OLD."zatcaStatus" IS DISTINCT FROM NEW."zatcaStatus") THEN
    RAISE EXCEPTION 'ZATCA: the QR changes only once, to the cleared QR' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."zatcaStatus" IS NOT NULL AND NEW."zatcaStatus" NOT IN ('PENDING', 'CLEARED', 'CLEARED_WITH_WARNINGS', 'REPORTED', 'REPORTED_WITH_WARNINGS', 'REJECTED', 'ERROR') THEN
    RAISE EXCEPTION 'ZATCA: unknown e-invoice status %', NEW."zatcaStatus" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER zatca_sinv_columns BEFORE UPDATE ON "SalesInvoice" FOR EACH ROW EXECUTE FUNCTION zatca_sinv_columns();

-- ── 5 · the numbering counters: a series may start after a previous system's last number (cut-over), set only
--      before the series issues anything; afterwards it moves by one only, and is never deleted ──
CREATE OR REPLACE FUNCTION zatca_counter_guard() RETURNS trigger AS $$
DECLARE used boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM "SalesInvoice" i WHERE i."tenantId" = coalesce(NEW."tenantId", OLD."tenantId") AND i."series" = coalesce(NEW."series", OLD."series") AND i."status" = 'ISSUED') INTO used;
  IF TG_OP = 'DELETE' THEN
    IF used OR OLD."value" > 0 THEN
      RAISE EXCEPTION 'NUMBERING: a counter of a series in use is never deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."value" <> 1 AND used THEN
      RAISE EXCEPTION 'NUMBERING: the start of a series is set before it issues anything' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."series" <> OLD."series" OR NEW."tenantId" <> OLD."tenantId" THEN
    RAISE EXCEPTION 'NUMBERING: a counter keeps its series' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."value" <> OLD."value" + 1 AND (used OR NEW."value" < 0) THEN
    RAISE EXCEPTION 'NUMBERING: a series in use only moves to its next number (% → %)', OLD."value", NEW."value" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER zatca_counter_guard BEFORE INSERT OR UPDATE OR DELETE ON "SalesDocumentCounter" FOR EACH ROW EXECUTE FUNCTION zatca_counter_guard();

-- ── 6 · the Fatoora log is append-only; nothing here is truncated ──
CREATE OR REPLACE FUNCTION zatca_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ZATCA: % is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER zatca_log_append_only BEFORE UPDATE OR DELETE ON "ZatcaLog" FOR EACH ROW EXECUTE FUNCTION zatca_append_only();
CREATE TRIGGER zatca_no_truncate BEFORE TRUNCATE ON "ZatcaLog" FOR EACH STATEMENT EXECUTE FUNCTION zatca_append_only();
CREATE TRIGGER zatca_no_truncate BEFORE TRUNCATE ON "ZatcaDocument" FOR EACH STATEMENT EXECUTE FUNCTION zatca_append_only();
CREATE TRIGGER zatca_no_truncate BEFORE TRUNCATE ON "ZatcaEgsUnit" FOR EACH STATEMENT EXECUTE FUNCTION zatca_append_only();
CREATE TRIGGER zatca_no_truncate BEFORE TRUNCATE ON "ZatcaCsid" FOR EACH STATEMENT EXECUTE FUNCTION zatca_append_only();

-- ── 7 · audit (who / when / before / after / IP, into the A1 "AccountingAuditLog") — without keys, secrets or XML ──
CREATE OR REPLACE FUNCTION zatca_audit_row() RETURNS trigger AS $$
DECLARE b jsonb; a jsonb; r jsonb; act text;
  hidden text[] := ARRAY['privateKeyEnc', 'pendingPrivateKeyEnc', 'tokenEnc', 'secretEnc', 'signedXml', 'clearedXml', 'csrPem', 'pendingCsrPem'];
BEGIN
  b := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) - hidden END;
  a := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) - hidden END;
  IF TG_OP = 'UPDATE' AND a = b THEN RETURN NULL; END IF;
  r := coalesce(a, b);
  act := TG_OP;
  IF TG_OP = 'UPDATE' AND (a ? 'status') AND (a->>'status') IS DISTINCT FROM (b->>'status') THEN act := 'STATUS_' || (a->>'status'); END IF;
  IF TG_OP = 'UPDATE' AND (a ? 'csidState') AND (a->>'csidState') IS DISTINCT FROM (b->>'csidState') THEN act := 'CSID_' || (a->>'csidState'); END IF;
  INSERT INTO "AccountingAuditLog" ("id", "tenantId", "at", "actorId", "action", "entityType", "entityId", "before", "after", "reason", "ip", "userAgent")
  VALUES (gen_random_uuid()::text, coalesce(r->>'tenantId', 'hiqbah'), now(),
          coalesce(nullif(current_setting('hiqbah.actor_id', true), ''), r->>'updatedById', r->>'createdById', 'system'),
          act, TG_TABLE_NAME, coalesce(r->>'id', '-'), b, a,
          nullif(current_setting('hiqbah.audit_reason', true), ''), nullif(current_setting('hiqbah.audit_ip', true), ''),
          nullif(current_setting('hiqbah.audit_ua', true), ''));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER zatca_audit_row AFTER INSERT OR UPDATE OR DELETE ON "ZatcaSettings" FOR EACH ROW EXECUTE FUNCTION zatca_audit_row();
CREATE TRIGGER zatca_audit_row AFTER INSERT OR UPDATE OR DELETE ON "ZatcaEgsUnit" FOR EACH ROW EXECUTE FUNCTION zatca_audit_row();
CREATE TRIGGER zatca_audit_row AFTER INSERT OR UPDATE OR DELETE ON "ZatcaCsid" FOR EACH ROW EXECUTE FUNCTION zatca_audit_row();

COMMIT;
