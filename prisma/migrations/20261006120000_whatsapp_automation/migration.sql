-- WhatsApp automation: rules, the event outbox, the outbound message log and its settings.
--
-- Expand-only. Six new tables, three new enums and one defaulted column on "Customer";
-- nothing is dropped, narrowed or rewritten and no existing row is touched. The previous
-- application build keeps working against this schema: it never selects the new column and
-- never reads the new tables.
--
-- "Customer"."whatsappOptOut" is NOT NULL DEFAULT false, so every existing customer reads as
-- "may be messaged" — which is the state they were in before this migration, when nothing
-- was messaged at all. Sending is still off by default: "AutomationSettings" has no row until
-- an administrator opens the WhatsApp screen, and a missing row reads as sendMode = OFF.
--
-- No tenantId, per docs/saas-readiness.md. Every table here is tenant-owned when the Tenant
-- model exists.

-- CreateEnum
CREATE TYPE "AutomationEventStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "WhatsAppMessageStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WhatsAppSendMode" AS ENUM ('OFF', 'TEST', 'LIVE');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "whatsappOptOut" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "eventType" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'ar',
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "actorId" TEXT,
    "dedupeKey" TEXT,
    "status" "AutomationEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "matched" BOOLEAN NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "ruleId" TEXT,
    "ruleName" TEXT,
    "eventId" TEXT,
    "eventType" TEXT,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "stepIndex" INTEGER,
    "recipientKind" TEXT NOT NULL,
    "recipientName" TEXT,
    "phone" TEXT,
    "intendedPhone" TEXT,
    "body" TEXT NOT NULL,
    "status" "WhatsAppMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "statusNote" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextAttemptAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppSendAttempt" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "httpStatus" INTEGER,
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppSendAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "sendMode" "WhatsAppSendMode" NOT NULL DEFAULT 'OFF',
    "testPhone" TEXT,
    "lastSweepAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationRule_eventType_isActive_idx" ON "AutomationRule"("eventType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationEvent_dedupeKey_key" ON "AutomationEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "AutomationEvent_status_occurredAt_idx" ON "AutomationEvent"("status", "occurredAt");

-- CreateIndex
CREATE INDEX "AutomationEvent_subjectType_subjectId_idx" ON "AutomationEvent"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "AutomationRun_createdAt_idx" ON "AutomationRun"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRun_ruleId_eventId_key" ON "AutomationRun"("ruleId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_dedupeKey_key" ON "WhatsAppMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_status_scheduledAt_idx" ON "WhatsAppMessage"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_createdAt_idx" ON "WhatsAppMessage"("createdAt");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_subjectType_subjectId_idx" ON "WhatsAppMessage"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "WhatsAppSendAttempt_messageId_idx" ON "WhatsAppSendAttempt"("messageId");

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "AutomationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppSendAttempt" ADD CONSTRAINT "WhatsAppSendAttempt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "WhatsAppMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

