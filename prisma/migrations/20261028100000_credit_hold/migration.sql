-- Credit warnings, the manual sales hold («إيقاف البيع») with grace days, and Vercel Blob storage
-- for the customer file (feat/credit-hold). Owner design: warnings are derived on read from the
-- existing statement / aging logic; a hold is ALWAYS placed by a person holding
-- customers › sales_hold, never automatically.
--
-- ADDITIVE ONLY:
--   "Customer"."defaultHoldDays"   nullable INTEGER, «مدة الإيقاف الافتراضية» (1..365 days; NULL = not
--                                  set). ADD COLUMN without a default is metadata-only; every existing
--                                  row reads NULL and passes its CHECK.
--   "CustomerSalesHold"            new, empty table: one row per hold, lifted in place (who, when,
--                                  why, how). At most one unlifted hold per customer (partial unique
--                                  index). FKs from the new table only: Customer ON DELETE CASCADE,
--                                  Employee ON DELETE SET NULL (placed by / lifted by).
--   "CustomerCreditLog"            new, empty, append-only by convention (the application never
--                                  updates or deletes a row; the customer's deletion and the resets
--                                  take them): every grace, hold, lift and automatic lift. FKs from
--                                  the new table only: Customer ON DELETE CASCADE, Employee ON DELETE
--                                  SET NULL.
--   "CustomerFile"                 customer files move to a private Vercel Blob store. Existing rows
--                                  keep their bytes in "content" and keep working:
--                                    * "content" becomes NULLABLE (DROP NOT NULL — every existing row
--                                      has bytes, so nothing changes for them);
--                                    * new nullable "blobPathname" (the private blob's pathname; the
--                                      browser never sees it) with a unique index;
--                                    * the size CHECK is replaced: exactly one of content / blob is
--                                      set; bytes in the row stay 1 B..5 MB with octet_length(content)
--                                      = "sizeBytes" (the old rule, unchanged for them); a blob is
--                                      1 B..20 MB.
--                                  Every existing row satisfies the new CHECK (content NOT NULL, no
--                                  blob, 1..5 MB, length = size — the old CHECK guaranteed it), so the
--                                  ADD CONSTRAINT validates without a rewrite and cannot fail on
--                                  production data (preflight-p4 counts any row that would).
--   "Employee"."workEmail"         nullable TEXT: the company e-mail («البريد الإلكتروني للشركة») of an
--                                  account with no linked HR person (a linked account's is its
--                                  person's "HrEmployee"."workEmail"). System notifications are
--                                  e-mailed there. NULL for every existing account (metadata-only ADD
--                                  COLUMN; CHECK on shape); uniqueness is the application's.
--   "SystemIncident"               new, empty table: the small incident record that deduplicates the
--                                  storage alerts (one open incident per kind — partial unique index —
--                                  with what happened, how many files went to the DB fallback or were
--                                  refused meanwhile, and when it was alerted / resolved).
--   "SystemAlert"                  new, empty table: the in-app alerts the bell shows to the accounts
--                                  that hold Settings at edit (the system had no in-app notification
--                                  mechanism), with their e-mail delivery status. No FKs.
-- Nothing is dropped except the CHECK it replaces, and nothing is renamed, retyped or back-filled.
-- The previous application version never reads the new objects; it still writes "content" on every
-- upload, which the new CHECK accepts.
-- Atomic: the whole file runs in one transaction. Rollback:
-- docs/hr/migration-review/rollback-20261028100000_credit_hold.sql.
BEGIN;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "defaultHoldDays" INTEGER;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_defaultHoldDays_check" CHECK ("defaultHoldDays" IS NULL OR "defaultHoldDays" BETWEEN 1 AND 365);

-- CreateTable
CREATE TABLE "CustomerSalesHold" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "autoLiftAtEnd" BOOLEAN NOT NULL DEFAULT false,
    "autoLiftOnPayment" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt" TIMESTAMP(3),
    "liftedById" TEXT,
    "liftKind" TEXT,
    "liftReason" TEXT,

    CONSTRAINT "CustomerSalesHold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CustomerSalesHold_basis_check" CHECK ("basis" IN ('OVER_LIMIT', 'OVERDUE', 'BOTH', 'OTHER')),
    CONSTRAINT "CustomerSalesHold_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
    CONSTRAINT "CustomerSalesHold_ends_check" CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt"),
    -- «حتى السداد»: an open-ended hold lifts on payment (or by hand); a timed one may lift at its end.
    CONSTRAINT "CustomerSalesHold_autolift_check" CHECK (NOT "autoLiftAtEnd" OR "endsAt" IS NOT NULL),
    CONSTRAINT "CustomerSalesHold_lift_check" CHECK (
        ("liftedAt" IS NULL AND "liftKind" IS NULL AND "liftedById" IS NULL AND "liftReason" IS NULL)
        OR ("liftedAt" IS NOT NULL AND "liftKind" IN ('MANUAL', 'EXPIRED', 'PAID'))
    ),
    CONSTRAINT "CustomerSalesHold_liftReason_check" CHECK ("liftReason" IS NULL OR length("liftReason") <= 500)
);

-- CreateTable
CREATE TABLE "CustomerCreditLog" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "holdId" TEXT,
    "days" INTEGER,
    "untilAt" TIMESTAMP(3),
    "reason" TEXT,
    "detail" JSONB,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerCreditLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CustomerCreditLog_kind_check" CHECK ("kind" IN ('GRACE', 'HOLD', 'LIFT', 'AUTO_LIFT')),
    -- A grace is a number of days and the date it ends.
    CONSTRAINT "CustomerCreditLog_grace_check" CHECK ("kind" <> 'GRACE' OR ("days" BETWEEN 1 AND 90 AND "untilAt" IS NOT NULL)),
    CONSTRAINT "CustomerCreditLog_hold_check" CHECK ("kind" = 'GRACE' OR "holdId" IS NOT NULL),
    CONSTRAINT "CustomerCreditLog_reason_check" CHECK ("reason" IS NULL OR length("reason") <= 500)
);

-- CreateIndex
CREATE INDEX "CustomerSalesHold_customerId_createdAt_idx" ON "CustomerSalesHold"("customerId", "createdAt");
-- At most one hold in force per customer (the application refuses a second; this is the arbiter).
CREATE UNIQUE INDEX "CustomerSalesHold_one_open" ON "CustomerSalesHold"("customerId") WHERE "liftedAt" IS NULL;
CREATE INDEX "CustomerCreditLog_customerId_createdAt_idx" ON "CustomerCreditLog"("customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "CustomerSalesHold" ADD CONSTRAINT "CustomerSalesHold_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerSalesHold" ADD CONSTRAINT "CustomerSalesHold_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerSalesHold" ADD CONSTRAINT "CustomerSalesHold_liftedById_fkey" FOREIGN KEY ("liftedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditLog" ADD CONSTRAINT "CustomerCreditLog_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditLog" ADD CONSTRAINT "CustomerCreditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Customer files: bytes in the row (existing) or a private blob (new uploads).
ALTER TABLE "CustomerFile" ALTER COLUMN "content" DROP NOT NULL;
ALTER TABLE "CustomerFile" ADD COLUMN "blobPathname" TEXT;
ALTER TABLE "CustomerFile" DROP CONSTRAINT "CustomerFile_size_check";
ALTER TABLE "CustomerFile" ADD CONSTRAINT "CustomerFile_size_check" CHECK (
    ("content" IS NOT NULL AND "blobPathname" IS NULL AND "sizeBytes" BETWEEN 1 AND 5242880 AND octet_length("content") = "sizeBytes")
    OR ("content" IS NULL AND "blobPathname" IS NOT NULL AND "sizeBytes" BETWEEN 1 AND 20971520)
);
ALTER TABLE "CustomerFile" ADD CONSTRAINT "CustomerFile_blobPathname_check" CHECK ("blobPathname" IS NULL OR "blobPathname" ~ '^customers/[^/]+/[^/]+$');
CREATE UNIQUE INDEX "CustomerFile_blobPathname_key" ON "CustomerFile"("blobPathname");

-- The company e-mail of an account with no HR person.
ALTER TABLE "Employee" ADD COLUMN "workEmail" TEXT;
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_workEmail_check" CHECK ("workEmail" IS NULL OR (length("workEmail") <= 254 AND "workEmail" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));

-- CreateTable
CREATE TABLE "SystemIncident" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "cause" TEXT NOT NULL,
    "detail" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "fallbackCount" INTEGER NOT NULL DEFAULT 0,
    "refusedCount" INTEGER NOT NULL DEFAULT 0,
    "alertedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SystemIncident_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SystemIncident_kind_check" CHECK ("kind" IN ('BLOB_STORAGE')),
    CONSTRAINT "SystemIncident_status_check" CHECK ("status" IN ('OPEN', 'RESOLVED')),
    CONSTRAINT "SystemIncident_cause_check" CHECK ("cause" IN ('UPLOAD_FAILED', 'DOWNLOAD_FAILED', 'DELETE_FAILED', 'NOT_CONFIGURED')),
    CONSTRAINT "SystemIncident_counts_check" CHECK ("occurrences" >= 1 AND "fallbackCount" >= 0 AND "refusedCount" >= 0),
    CONSTRAINT "SystemIncident_resolved_check" CHECK (("status" = 'OPEN') = ("resolvedAt" IS NULL)),
    CONSTRAINT "SystemIncident_detail_check" CHECK ("detail" IS NULL OR length("detail") <= 500)
);
CREATE UNIQUE INDEX "SystemIncident_one_open" ON "SystemIncident"("kind") WHERE "status" = 'OPEN';
CREATE INDEX "SystemIncident_kind_openedAt_idx" ON "SystemIncident"("kind", "openedAt");

-- CreateTable
CREATE TABLE "SystemAlert" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "incidentId" TEXT,
    "titleAr" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "bodyAr" TEXT NOT NULL,
    "bodyEn" TEXT NOT NULL,
    "emailStatus" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "emailRecipients" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "readById" TEXT,

    CONSTRAINT "SystemAlert_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SystemAlert_kind_check" CHECK ("kind" IN ('STORAGE_INCIDENT', 'STORAGE_RECOVERED')),
    CONSTRAINT "SystemAlert_severity_check" CHECK ("severity" IN ('danger', 'warning', 'success', 'info')),
    CONSTRAINT "SystemAlert_emailStatus_check" CHECK ("emailStatus" IN ('SENT', 'FAILED', 'NOT_CONFIGURED', 'NO_RECIPIENTS'))
);
CREATE INDEX "SystemAlert_createdAt_idx" ON "SystemAlert"("createdAt");

COMMIT;
