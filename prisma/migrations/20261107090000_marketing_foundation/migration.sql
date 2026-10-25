-- Smart Marketing Department «قسم التسويق الذكي» — foundation (feat/smart-marketing).
-- Reference: docs/marketing/ARCHITECTURE.md, docs/marketing/DATA-MODEL.md.
--
-- ADDITIVE ONLY: 30 new tables prefixed "Mkt", their indexes, foreign keys between the new tables,
-- foreign keys from the new tables to "CoffeeProduct" (ON DELETE SET NULL / CASCADE for the
-- economics row), CHECK constraints on the new columns, and one trigger function that keeps three
-- trails append-only. No existing table, column, row or constraint is altered, dropped, renamed or
-- back-filled; the deployed application never reads the new tables and runs unchanged on the result.
--
-- Rules the database itself holds (not only the service):
--   * every status / kind column takes only its documented values (CHECK);
--   * an approval is never decided by the person who requested it;
--   * an asset version keeps its bytes in exactly one place (row or Blob);
--   * metrics are never negative; NULL stays NULL («غير متاح» — never stored as zero);
--   * "MktAuditLog" refuses UPDATE and DELETE; "MktPostChange" and "MktConsentEvent" refuse UPDATE.
--     Their DELETE stays possible on purpose: a change row goes with its post (ON DELETE CASCADE) and
--     a consent event with its consent record (a personal-data erasure request).
-- Atomic: the whole file runs in one transaction.
-- Rollback: docs/marketing/rollback-20261107090000_marketing_foundation.sql.
BEGIN;

-- CreateTable
CREATE TABLE "MktSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "killAll" BOOLEAN NOT NULL DEFAULT false,
    "killPublishing" BOOLEAN NOT NULL DEFAULT false,
    "killAds" BOOLEAN NOT NULL DEFAULT false,
    "killMessaging" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "approvalPolicy" JSONB NOT NULL DEFAULT '{}',
    "maxMessagesPerDay" INTEGER NOT NULL DEFAULT 500,
    "maxMarketingPerCustomerPerWeek" INTEGER NOT NULL DEFAULT 2,
    "quietHoursStart" INTEGER NOT NULL DEFAULT 22,
    "quietHoursEnd" INTEGER NOT NULL DEFAULT 9,
    "attributionModel" TEXT NOT NULL DEFAULT 'LAST_TOUCH',
    "attributionWindowDays" INTEGER NOT NULL DEFAULT 7,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktBrandKit" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "brandNameAr" TEXT NOT NULL DEFAULT 'حقبة',
    "brandNameEn" TEXT NOT NULL DEFAULT 'Hiqbah',
    "colors" JSONB NOT NULL DEFAULT '[]',
    "fonts" JSONB NOT NULL DEFAULT '[]',
    "toneAr" TEXT,
    "toneEn" TEXT,
    "doList" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dontList" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "examples" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "logoAssetId" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktBrandKit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktProductEconomics" (
    "productId" TEXT NOT NULL,
    "avgOrderValue" DECIMAL(18,2),
    "vatIncluded" BOOLEAN NOT NULL DEFAULT false,
    "grossMarginPct" DECIMAL(6,4),
    "variableCostPerOrder" DECIMAL(18,2),
    "targetCac" DECIMAL(18,2),
    "repurchaseCycleDays" INTEGER,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktProductEconomics_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "MktCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productId" TEXT,
    "audience" TEXT,
    "offer" TEXT,
    "landingUrl" TEXT,
    "utmCampaign" TEXT NOT NULL,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "plannedBudget" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "targetCac" DECIMAL(18,2),
    "targetRoas" DECIMAL(8,3),
    "minSpendForDecision" DECIMAL(18,2),
    "minConversionsForDecision" INTEGER,
    "externalRefs" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "ownerId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktAsset" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "campaignId" TEXT,
    "productId" TEXT,
    "rights" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "rightsNote" TEXT,
    "text" TEXT,
    "brief" JSONB,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktAssetVersion" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "isOriginal" BOOLEAN NOT NULL DEFAULT false,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "content" BYTEA,
    "blobPathname" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktAssetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktPost" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "campaignId" TEXT,
    "productId" TEXT,
    "objective" TEXT NOT NULL,
    "audience" TEXT,
    "contentType" TEXT NOT NULL DEFAULT 'POST',
    "caption" TEXT NOT NULL DEFAULT '',
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "link" TEXT,
    "cta" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "brief" JSONB,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktPostVariant" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "caption" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "externalPostId" TEXT,
    "externalUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "manualConfirmedById" TEXT,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktPostVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktPostAsset" (
    "postId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "versionId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MktPostAsset_pkey" PRIMARY KEY ("postId","assetId")
);

-- CreateTable
CREATE TABLE "MktPostChange" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "field" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktPostChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktPublishJob" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAt" TIMESTAMP(3) NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktPublishJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktApproval" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "payloadHash" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT,
    "requestNote" TEXT,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktConnection" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "accountId" TEXT,
    "accountName" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenCiphertext" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "config" JSONB NOT NULL DEFAULT '{}',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "connectedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktBudget" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeRef" TEXT,
    "campaignId" TEXT,
    "planned" DECIMAL(18,2) NOT NULL,
    "dailyCap" DECIMAL(18,2),
    "maxAutoIncreasePct" DECIMAL(6,4),
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktMetricSnapshot" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "platform" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "campaignId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'PAID',
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "spend" DECIMAL(18,2),
    "impressions" INTEGER,
    "reach" INTEGER,
    "clicks" INTEGER,
    "linkClicks" INTEGER,
    "landingPageViews" INTEGER,
    "videoViews" INTEGER,
    "engagements" INTEGER,
    "followersDelta" INTEGER,
    "leads" INTEGER,
    "purchases" INTEGER,
    "conversionValue" DECIMAL(18,2),
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enteredById" TEXT,

    CONSTRAINT "MktMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktStoreCustomer" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'STORE',
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "firstOrderAt" TIMESTAMP(3),
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "erpCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktStoreCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktStoreOrder" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'STORE',
    "externalId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "customerId" TEXT,
    "rawStatus" TEXT,
    "status" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "subtotal" DECIMAL(18,2),
    "discount" DECIMAL(18,2),
    "shipping" DECIMAL(18,2),
    "tax" DECIMAL(18,2),
    "total" DECIMAL(18,2) NOT NULL,
    "refunded" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "couponCode" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "isFirstOrder" BOOLEAN,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "landingUrl" TEXT,
    "referrer" TEXT,
    "campaignId" TEXT,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "payloadHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktStoreOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktTouch" (
    "id" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "channel" TEXT NOT NULL,
    "platform" TEXT,
    "campaignId" TEXT,
    "messageId" TEXT,
    "orderId" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "MktTouch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktCart" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'STORE',
    "externalId" TEXT NOT NULL,
    "customerId" TEXT,
    "phone" TEXT,
    "value" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "recoveryUrl" TEXT,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "abandonedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "convertedOrderExternalId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktCart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktConsent" (
    "phone" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktConsent_pkey" PRIMARY KEY ("phone","channel")
);

-- CreateTable
CREATE TABLE "MktConsentEvent" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" TEXT,
    "actorId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktWaTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'ar',
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'LOCAL_DRAFT',
    "body" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "purpose" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktWaTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktJourney" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktJourney_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktJourneyEnrollment" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktJourneyEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktMessage" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "phone" TEXT NOT NULL,
    "enrollmentId" TEXT,
    "campaignId" TEXT,
    "templateId" TEXT,
    "category" TEXT NOT NULL,
    "preview" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "statusNote" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "providerId" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cost" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "trackedUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktDecision" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "evidence" JSONB NOT NULL,
    "confidence" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "outcomeNote" TEXT,
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktAlert" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "MktAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktJobRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,

    CONSTRAINT "MktJobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktAuditLog" (
    "id" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktWebhookEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "topic" TEXT,
    "signatureOk" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "MktWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MktCampaign_utmCampaign_key" ON "MktCampaign"("utmCampaign");

-- CreateIndex
CREATE INDEX "MktCampaign_status_idx" ON "MktCampaign"("status");

-- CreateIndex
CREATE INDEX "MktCampaign_productId_idx" ON "MktCampaign"("productId");

-- CreateIndex
CREATE INDEX "MktAsset_campaignId_idx" ON "MktAsset"("campaignId");

-- CreateIndex
CREATE INDEX "MktAsset_productId_idx" ON "MktAsset"("productId");

-- CreateIndex
CREATE INDEX "MktAsset_kind_archived_idx" ON "MktAsset"("kind", "archived");

-- CreateIndex
CREATE UNIQUE INDEX "MktAssetVersion_blobPathname_key" ON "MktAssetVersion"("blobPathname");

-- CreateIndex
CREATE UNIQUE INDEX "MktAssetVersion_assetId_version_key" ON "MktAssetVersion"("assetId", "version");

-- CreateIndex
CREATE INDEX "MktPost_scheduledAt_idx" ON "MktPost"("scheduledAt");

-- CreateIndex
CREATE INDEX "MktPost_status_idx" ON "MktPost"("status");

-- CreateIndex
CREATE INDEX "MktPost_campaignId_idx" ON "MktPost"("campaignId");

-- CreateIndex
CREATE INDEX "MktPostVariant_status_idx" ON "MktPostVariant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MktPostVariant_postId_platform_key" ON "MktPostVariant"("postId", "platform");

-- CreateIndex
CREATE INDEX "MktPostChange_postId_at_idx" ON "MktPostChange"("postId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "MktPublishJob_idempotencyKey_key" ON "MktPublishJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MktPublishJob_status_runAt_idx" ON "MktPublishJob"("status", "runAt");

-- CreateIndex
CREATE INDEX "MktApproval_status_createdAt_idx" ON "MktApproval"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MktApproval_subjectType_subjectId_idx" ON "MktApproval"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "MktConnection_platform_key" ON "MktConnection"("platform");

-- CreateIndex
CREATE INDEX "MktBudget_period_idx" ON "MktBudget"("period");

-- CreateIndex
-- NULLS NOT DISTINCT (PostgreSQL 15+): one TOTAL line per period, not one per NULL.
CREATE UNIQUE INDEX "MktBudget_period_scope_scopeRef_campaignId_key" ON "MktBudget"("period", "scope", "scopeRef", "campaignId") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "MktMetricSnapshot_campaignId_day_idx" ON "MktMetricSnapshot"("campaignId", "day");

-- CreateIndex
CREATE INDEX "MktMetricSnapshot_day_idx" ON "MktMetricSnapshot"("day");

-- CreateIndex
CREATE UNIQUE INDEX "MktMetricSnapshot_day_platform_level_externalId_source_key" ON "MktMetricSnapshot"("day", "platform", "level", "externalId", "source");

-- CreateIndex
CREATE INDEX "MktStoreCustomer_phone_idx" ON "MktStoreCustomer"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "MktStoreCustomer_source_externalId_key" ON "MktStoreCustomer"("source", "externalId");

-- CreateIndex
CREATE INDEX "MktStoreOrder_placedAt_idx" ON "MktStoreOrder"("placedAt");

-- CreateIndex
CREATE INDEX "MktStoreOrder_campaignId_idx" ON "MktStoreOrder"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "MktStoreOrder_source_externalId_key" ON "MktStoreOrder"("source", "externalId");

-- CreateIndex
CREATE INDEX "MktTouch_subjectKey_at_idx" ON "MktTouch"("subjectKey", "at");

-- CreateIndex
CREATE INDEX "MktTouch_orderId_idx" ON "MktTouch"("orderId");

-- CreateIndex
CREATE INDEX "MktCart_status_abandonedAt_idx" ON "MktCart"("status", "abandonedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MktCart_source_externalId_key" ON "MktCart"("source", "externalId");

-- CreateIndex
CREATE INDEX "MktConsentEvent_phone_channel_at_idx" ON "MktConsentEvent"("phone", "channel", "at");

-- CreateIndex
CREATE UNIQUE INDEX "MktWaTemplate_name_language_key" ON "MktWaTemplate"("name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "MktJourney_kind_key" ON "MktJourney"("kind");

-- CreateIndex
CREATE INDEX "MktJourneyEnrollment_status_nextRunAt_idx" ON "MktJourneyEnrollment"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "MktJourneyEnrollment_journeyId_subjectKey_key" ON "MktJourneyEnrollment"("journeyId", "subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "MktMessage_dedupeKey_key" ON "MktMessage"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "MktMessage_providerId_key" ON "MktMessage"("providerId");

-- CreateIndex
CREATE INDEX "MktMessage_status_scheduledAt_idx" ON "MktMessage"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "MktMessage_phone_createdAt_idx" ON "MktMessage"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "MktMessage_campaignId_idx" ON "MktMessage"("campaignId");

-- CreateIndex
CREATE INDEX "MktDecision_campaignId_createdAt_idx" ON "MktDecision"("campaignId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MktAlert_dedupeKey_key" ON "MktAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "MktAlert_status_createdAt_idx" ON "MktAlert"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MktJobRun_job_startedAt_idx" ON "MktJobRun"("job", "startedAt");

-- CreateIndex
CREATE INDEX "MktAuditLog_entityType_entityId_at_idx" ON "MktAuditLog"("entityType", "entityId", "at");

-- CreateIndex
CREATE INDEX "MktAuditLog_at_idx" ON "MktAuditLog"("at");

-- CreateIndex
CREATE INDEX "MktWebhookEvent_status_receivedAt_idx" ON "MktWebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MktWebhookEvent_source_eventKey_key" ON "MktWebhookEvent"("source", "eventKey");

-- AddForeignKey
ALTER TABLE "MktProductEconomics" ADD CONSTRAINT "MktProductEconomics_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktCampaign" ADD CONSTRAINT "MktCampaign_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktAsset" ADD CONSTRAINT "MktAsset_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MktCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktAsset" ADD CONSTRAINT "MktAsset_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktAssetVersion" ADD CONSTRAINT "MktAssetVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MktAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktPost" ADD CONSTRAINT "MktPost_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MktCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktPost" ADD CONSTRAINT "MktPost_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktPostVariant" ADD CONSTRAINT "MktPostVariant_postId_fkey" FOREIGN KEY ("postId") REFERENCES "MktPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktPostAsset" ADD CONSTRAINT "MktPostAsset_postId_fkey" FOREIGN KEY ("postId") REFERENCES "MktPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktPostAsset" ADD CONSTRAINT "MktPostAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MktAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktPostChange" ADD CONSTRAINT "MktPostChange_postId_fkey" FOREIGN KEY ("postId") REFERENCES "MktPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktPublishJob" ADD CONSTRAINT "MktPublishJob_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "MktPostVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktBudget" ADD CONSTRAINT "MktBudget_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MktCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktMetricSnapshot" ADD CONSTRAINT "MktMetricSnapshot_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MktCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktStoreOrder" ADD CONSTRAINT "MktStoreOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "MktStoreCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktStoreOrder" ADD CONSTRAINT "MktStoreOrder_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MktCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktTouch" ADD CONSTRAINT "MktTouch_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MktStoreOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktCart" ADD CONSTRAINT "MktCart_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "MktStoreCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktConsentEvent" ADD CONSTRAINT "MktConsentEvent_phone_channel_fkey" FOREIGN KEY ("phone", "channel") REFERENCES "MktConsent"("phone", "channel") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktJourneyEnrollment" ADD CONSTRAINT "MktJourneyEnrollment_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "MktJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktMessage" ADD CONSTRAINT "MktMessage_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "MktJourneyEnrollment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktMessage" ADD CONSTRAINT "MktMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MktCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktDecision" ADD CONSTRAINT "MktDecision_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MktCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── CHECK constraints ─────────────────────────────────────────────────────────────────────
ALTER TABLE "MktSettings" ADD CONSTRAINT "MktSettings_singleton_check" CHECK ("id" = 'default'),
  ADD CONSTRAINT "MktSettings_limits_check" CHECK ("maxMessagesPerDay" BETWEEN 0 AND 100000 AND "maxMarketingPerCustomerPerWeek" BETWEEN 0 AND 14
    AND "quietHoursStart" BETWEEN 0 AND 23 AND "quietHoursEnd" BETWEEN 0 AND 23 AND "attributionWindowDays" BETWEEN 1 AND 90),
  ADD CONSTRAINT "MktSettings_attribution_check" CHECK ("attributionModel" IN ('FIRST_TOUCH', 'LAST_TOUCH', 'LINEAR'));
ALTER TABLE "MktBrandKit" ADD CONSTRAINT "MktBrandKit_singleton_check" CHECK ("id" = 'default');
ALTER TABLE "MktProductEconomics" ADD CONSTRAINT "MktProductEconomics_values_check" CHECK (
  ("grossMarginPct" IS NULL OR "grossMarginPct" BETWEEN 0 AND 1)
  AND ("avgOrderValue" IS NULL OR "avgOrderValue" >= 0)
  AND ("variableCostPerOrder" IS NULL OR "variableCostPerOrder" >= 0)
  AND ("targetCac" IS NULL OR "targetCac" >= 0)
  AND ("repurchaseCycleDays" IS NULL OR "repurchaseCycleDays" BETWEEN 1 AND 365));
ALTER TABLE "MktCampaign" ADD CONSTRAINT "MktCampaign_objective_check" CHECK ("objective" IN ('AWARENESS', 'ENGAGEMENT', 'TRAFFIC', 'LEADS', 'CONVERSIONS', 'SALES', 'RETENTION')),
  ADD CONSTRAINT "MktCampaign_status_check" CHECK ("status" IN ('DRAFT', 'PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED')),
  ADD CONSTRAINT "MktCampaign_utm_check" CHECK ("utmCampaign" ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  ADD CONSTRAINT "MktCampaign_dates_check" CHECK ("startAt" IS NULL OR "endAt" IS NULL OR "endAt" >= "startAt"),
  ADD CONSTRAINT "MktCampaign_money_check" CHECK (("plannedBudget" IS NULL OR "plannedBudget" >= 0) AND ("targetCac" IS NULL OR "targetCac" >= 0)
    AND ("targetRoas" IS NULL OR "targetRoas" >= 0) AND ("minSpendForDecision" IS NULL OR "minSpendForDecision" >= 0)
    AND ("minConversionsForDecision" IS NULL OR "minConversionsForDecision" >= 0));
ALTER TABLE "MktAsset" ADD CONSTRAINT "MktAsset_kind_check" CHECK ("kind" IN ('IMAGE', 'VIDEO', 'DESIGN_SOURCE', 'DOCUMENT', 'COPY')),
  ADD CONSTRAINT "MktAsset_rights_check" CHECK ("rights" IN ('OWNED', 'LICENSED', 'UGC_PERMISSION', 'STOCK', 'UNKNOWN'));
ALTER TABLE "MktAssetVersion" ADD CONSTRAINT "MktAssetVersion_storage_check" CHECK (("content" IS NULL) <> ("blobPathname" IS NULL)),
  ADD CONSTRAINT "MktAssetVersion_values_check" CHECK ("version" >= 1 AND "sizeBytes" BETWEEN 1 AND 52428800 AND length("sha256") = 64);
ALTER TABLE "MktPost" ADD CONSTRAINT "MktPost_objective_check" CHECK ("objective" IN ('AWARENESS', 'ENGAGEMENT', 'TRAFFIC', 'CONVERSIONS', 'SALES')),
  ADD CONSTRAINT "MktPost_type_check" CHECK ("contentType" IN ('POST', 'REEL', 'STORY', 'VIDEO', 'CAROUSEL', 'SHORT', 'ARTICLE', 'PIN')),
  ADD CONSTRAINT "MktPost_status_check" CHECK ("status" IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED'));
ALTER TABLE "MktPostVariant" ADD CONSTRAINT "MktPostVariant_status_check" CHECK ("status" IN ('PENDING', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'MANUAL_REQUIRED', 'MANUAL_DONE', 'CANCELLED'));
ALTER TABLE "MktPublishJob" ADD CONSTRAINT "MktPublishJob_status_check" CHECK ("status" IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'MANUAL_REQUIRED', 'CANCELLED')),
  ADD CONSTRAINT "MktPublishJob_attempts_check" CHECK ("attempts" BETWEEN 0 AND 20);
ALTER TABLE "MktApproval" ADD CONSTRAINT "MktApproval_subject_check" CHECK ("subjectType" IN ('POST', 'CAMPAIGN', 'BUDGET_CHANGE', 'AD_CHANGE', 'MESSAGE_CAMPAIGN', 'TRACKING_CHANGE', 'SENSITIVE_REPLY', 'JOURNEY')),
  ADD CONSTRAINT "MktApproval_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  -- Four eyes: whoever asked never decides.
  ADD CONSTRAINT "MktApproval_four_eyes_check" CHECK ("decidedById" IS NULL OR "decidedById" <> "requestedById"),
  ADD CONSTRAINT "MktApproval_decided_check" CHECK (("status" IN ('APPROVED', 'REJECTED')) = ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL) OR "status" = 'CANCELLED');
ALTER TABLE "MktConnection" ADD CONSTRAINT "MktConnection_status_check" CHECK ("status" IN ('NOT_CONFIGURED', 'PENDING', 'CONNECTED', 'EXPIRED', 'ERROR', 'DISABLED'));
ALTER TABLE "MktBudget" ADD CONSTRAINT "MktBudget_scope_check" CHECK ("scope" IN ('TOTAL', 'PLATFORM', 'CAMPAIGN', 'PRODUCT')),
  ADD CONSTRAINT "MktBudget_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'),
  ADD CONSTRAINT "MktBudget_ref_check" CHECK (("scope" = 'CAMPAIGN') = ("campaignId" IS NOT NULL) AND (("scope" IN ('PLATFORM', 'PRODUCT')) = ("scopeRef" IS NOT NULL))),
  ADD CONSTRAINT "MktBudget_money_check" CHECK ("planned" >= 0 AND ("dailyCap" IS NULL OR "dailyCap" >= 0) AND ("maxAutoIncreasePct" IS NULL OR "maxAutoIncreasePct" BETWEEN 0 AND 1));
ALTER TABLE "MktMetricSnapshot" ADD CONSTRAINT "MktMetricSnapshot_level_check" CHECK ("level" IN ('ACCOUNT', 'CAMPAIGN', 'ADSET', 'AD', 'POST')),
  ADD CONSTRAINT "MktMetricSnapshot_kind_check" CHECK ("kind" IN ('PAID', 'ORGANIC')),
  ADD CONSTRAINT "MktMetricSnapshot_source_check" CHECK ("source" IN ('API', 'MANUAL', 'IMPORT')),
  ADD CONSTRAINT "MktMetricSnapshot_nonneg_check" CHECK (
    ("spend" IS NULL OR "spend" >= 0) AND ("impressions" IS NULL OR "impressions" >= 0) AND ("reach" IS NULL OR "reach" >= 0)
    AND ("clicks" IS NULL OR "clicks" >= 0) AND ("linkClicks" IS NULL OR "linkClicks" >= 0) AND ("landingPageViews" IS NULL OR "landingPageViews" >= 0)
    AND ("videoViews" IS NULL OR "videoViews" >= 0) AND ("engagements" IS NULL OR "engagements" >= 0) AND ("leads" IS NULL OR "leads" >= 0)
    AND ("purchases" IS NULL OR "purchases" >= 0) AND ("conversionValue" IS NULL OR "conversionValue" >= 0));
ALTER TABLE "MktStoreOrder" ADD CONSTRAINT "MktStoreOrder_status_check" CHECK ("status" IN ('PENDING', 'PAID', 'FULFILLED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED')),
  ADD CONSTRAINT "MktStoreOrder_money_check" CHECK ("total" >= 0 AND "refunded" >= 0 AND "refunded" <= "total");
ALTER TABLE "MktTouch" ADD CONSTRAINT "MktTouch_channel_check" CHECK ("channel" IN ('UTM', 'WHATSAPP', 'AD_CLICK', 'ORGANIC', 'REFERRAL'));
ALTER TABLE "MktCart" ADD CONSTRAINT "MktCart_status_check" CHECK ("status" IN ('OPEN', 'CONVERTED', 'EXPIRED'));
ALTER TABLE "MktConsent" ADD CONSTRAINT "MktConsent_status_check" CHECK ("status" IN ('OPTED_IN', 'OPTED_OUT')),
  ADD CONSTRAINT "MktConsent_source_check" CHECK ("source" IN ('CHECKOUT', 'FORM', 'IN_STORE', 'REPLY_STOP', 'ADMIN', 'IMPORT', 'KARZOUN')),
  ADD CONSTRAINT "MktConsent_phone_check" CHECK ("phone" ~ '^[1-9][0-9]{7,14}$');
ALTER TABLE "MktConsentEvent" ADD CONSTRAINT "MktConsentEvent_status_check" CHECK ("status" IN ('OPTED_IN', 'OPTED_OUT'));
ALTER TABLE "MktWaTemplate" ADD CONSTRAINT "MktWaTemplate_category_check" CHECK ("category" IN ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  ADD CONSTRAINT "MktWaTemplate_status_check" CHECK ("status" IN ('APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'LOCAL_DRAFT')),
  ADD CONSTRAINT "MktWaTemplate_name_check" CHECK ("name" ~ '^[a-z0-9_]+$' AND length("name") <= 512);
ALTER TABLE "MktJourney" ADD CONSTRAINT "MktJourney_kind_check" CHECK ("kind" IN ('ABANDONED_CART', 'WELCOME', 'POST_PURCHASE', 'REVIEW_REQUEST', 'REPLENISH', 'WINBACK', 'CROSS_SELL'));
ALTER TABLE "MktJourneyEnrollment" ADD CONSTRAINT "MktJourneyEnrollment_status_check" CHECK ("status" IN ('ACTIVE', 'COMPLETED', 'STOPPED', 'FAILED'));
ALTER TABLE "MktMessage" ADD CONSTRAINT "MktMessage_category_check" CHECK ("category" IN ('MARKETING', 'UTILITY', 'SERVICE')),
  ADD CONSTRAINT "MktMessage_status_check" CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'CANCELLED')),
  ADD CONSTRAINT "MktMessage_phone_check" CHECK ("phone" ~ '^[1-9][0-9]{7,14}$');
ALTER TABLE "MktDecision" ADD CONSTRAINT "MktDecision_verdict_check" CHECK ("verdict" IN ('SCALE', 'KEEP', 'OPTIMIZE', 'TEST', 'PAUSE', 'HUMAN_REVIEW', 'INSUFFICIENT_DATA')),
  ADD CONSTRAINT "MktDecision_status_check" CHECK ("status" IN ('PROPOSED', 'ACCEPTED', 'DISMISSED', 'EXECUTED'));
ALTER TABLE "MktAlert" ADD CONSTRAINT "MktAlert_severity_check" CHECK ("severity" IN ('INFO', 'WARNING', 'CRITICAL')),
  ADD CONSTRAINT "MktAlert_status_check" CHECK ("status" IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED'));
ALTER TABLE "MktJobRun" ADD CONSTRAINT "MktJobRun_status_check" CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'));
ALTER TABLE "MktAuditLog" ADD CONSTRAINT "MktAuditLog_actor_check" CHECK ("actorKind" IN ('USER', 'RULE', 'SYSTEM', 'WEBHOOK'));
ALTER TABLE "MktWebhookEvent" ADD CONSTRAINT "MktWebhookEvent_status_check" CHECK ("status" IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'));

-- ─── Append-only trails ────────────────────────────────────────────────────────────────────
CREATE FUNCTION "mkt_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "MktAuditLog_append_only" BEFORE UPDATE OR DELETE ON "MktAuditLog" FOR EACH ROW EXECUTE FUNCTION "mkt_append_only"();
CREATE TRIGGER "MktPostChange_append_only" BEFORE UPDATE ON "MktPostChange" FOR EACH ROW EXECUTE FUNCTION "mkt_append_only"();
CREATE TRIGGER "MktConsentEvent_append_only" BEFORE UPDATE ON "MktConsentEvent" FOR EACH ROW EXECUTE FUNCTION "mkt_append_only"();

COMMIT;
