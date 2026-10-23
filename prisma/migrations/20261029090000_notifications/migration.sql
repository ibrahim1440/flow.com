-- In-app notifications per user, with a bell for every signed-in account (feat/notifications).
-- Owner request: each person is told about the things that concern them — sales updates to the
-- sales staff, production to production, quality, the accountant, and their own work (a payslip
-- issued, a leave decided, their station PIN). E-mail is a second channel (lib/notify/email.ts).
--
-- ADDITIVE ONLY — three new, empty tables; no existing table, column or constraint is changed:
--   "Notification"            one row per recipient per event. FK to "Employee" ON DELETE CASCADE (the
--                             account's inbox goes with it). Unique ("recipientId", "dedupeKey"): the same
--                             event never produces two rows for one person (the writer inserts with
--                             ON CONFLICT DO NOTHING). Indexes for «my latest», «my unread» (partial, on
--                             the unread rows only), the category filter, retention (90 days) and the
--                             e-mail outbox (partial, PENDING rows only).
--   "NotificationPreference"  one row per account per category where the person changed the e-mail
--                             default. FK to "Employee" ON DELETE CASCADE.
--   "NotificationWatch"       the last notified state of a derived condition (a customer's credit
--                             standing), so a change is notified once and never repeated daily. No FK.
-- No row is written by the migration. Rollback: docs/hr/migration-review/rollback-20261029090000_notifications.sql.

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "titleAr" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "bodyAr" TEXT NOT NULL DEFAULT '',
    "bodyEn" TEXT NOT NULL DEFAULT '',
    "link" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "actorId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "emailState" TEXT NOT NULL DEFAULT 'NONE',
    "emailClaimedAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Notification_kind_check" CHECK ("kind" ~ '^[a-z]+\.[a-z_]+$' AND length("kind") <= 64),
    CONSTRAINT "Notification_category_check" CHECK ("category" IN ('sales', 'production', 'quality', 'finance', 'hr', 'me', 'system')),
    CONSTRAINT "Notification_severity_check" CHECK ("severity" IN ('info', 'success', 'warning', 'danger')),
    CONSTRAINT "Notification_text_check" CHECK (length("titleAr") BETWEEN 1 AND 300 AND length("titleEn") BETWEEN 1 AND 300 AND length("bodyAr") <= 2000 AND length("bodyEn") <= 2000),
    CONSTRAINT "Notification_link_check" CHECK ("link" IS NULL OR ("link" LIKE '/dashboard%' AND length("link") <= 500)),
    CONSTRAINT "Notification_dedupeKey_check" CHECK (length("dedupeKey") BETWEEN 1 AND 300),
    CONSTRAINT "Notification_emailState_check" CHECK ("emailState" IN ('NONE', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'OFF', 'NO_ADDRESS', 'NOT_CONFIGURED', 'EXPIRED'))
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "employeeId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("employeeId","category"),
    CONSTRAINT "NotificationPreference_category_check" CHECK ("category" IN ('sales', 'production', 'quality', 'finance', 'hr', 'me', 'system'))
);

-- CreateTable
CREATE TABLE "NotificationWatch" (
    "key" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationWatch_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "NotificationWatch_key_check" CHECK (length("key") BETWEEN 1 AND 200 AND length("state") <= 200)
);

-- CreateIndex
CREATE INDEX "Notification_recipientId_createdAt_idx" ON "Notification"("recipientId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_recipientId_category_createdAt_idx" ON "Notification"("recipientId", "category", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_recipientId_dedupeKey_key" ON "Notification"("recipientId", "dedupeKey");

-- «My unread» (the bell's count) reads only the unread rows.
CREATE INDEX "Notification_unread_idx" ON "Notification"("recipientId", "createdAt") WHERE "readAt" IS NULL;

-- The e-mail outbox: only the rows waiting to be e-mailed.
CREATE INDEX "Notification_email_pending_idx" ON "Notification"("createdAt") WHERE "emailState" = 'PENDING';

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
