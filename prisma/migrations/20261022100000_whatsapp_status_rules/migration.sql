-- WhatsApp status notifications («إشعارات الحالات»): the status catalogue and its rules.
--
-- Additive only. One new table with its unique key, one index and one CHECK; nothing existing is
-- altered, dropped or rewritten, and no existing row is touched. The previous application build
-- never reads this table and keeps working against this schema.
--
-- The table starts empty. The application fills it from the statuses that exist in the system
-- (order statuses, pipeline stages, quotation statuses…) the first time an administrator opens
-- the screen; every row it creates is switched OFF (enabled = false, renotify = false), so nothing
-- is sent because of this migration. It does not touch "AutomationSettings": the sending mode
-- (OFF / TEST / LIVE) stays whatever the administrator saved. A status that disappears from its source keeps its row, marked active = false.
--
-- No tenantId, per docs/saas-readiness.md (tenant-owned when the Tenant model exists).

-- CreateTable
CREATE TABLE "WhatsAppStatusRule" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "statusKey" TEXT NOT NULL,
    "labelAr" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "template" TEXT NOT NULL DEFAULT '',
    "renotify" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inactiveSince" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppStatusRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WhatsAppStatusRule_recipients_check" CHECK (jsonb_typeof("recipients") = 'array')
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppStatusRule_source_statusKey_key" ON "WhatsAppStatusRule"("source", "statusKey");

-- CreateIndex
CREATE INDEX "WhatsAppStatusRule_enabled_active_idx" ON "WhatsAppStatusRule"("enabled", "active");
