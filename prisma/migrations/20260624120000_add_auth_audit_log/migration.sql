-- CreateTable
CREATE TABLE "AuthAuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "identifierHash" TEXT,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reasonCode" TEXT,
    "sourceInterface" TEXT NOT NULL DEFAULT 'WEB',
    "workspaceRouting" TEXT,
    "ipHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthAuditLog_userId_occurredAt_idx" ON "AuthAuditLog"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuthAuditLog_identifierHash_occurredAt_idx" ON "AuthAuditLog"("identifierHash", "occurredAt");

-- CreateIndex
CREATE INDEX "AuthAuditLog_action_occurredAt_idx" ON "AuthAuditLog"("action", "occurredAt");

-- CreateIndex
CREATE INDEX "AuthAuditLog_result_occurredAt_idx" ON "AuthAuditLog"("result", "occurredAt");
