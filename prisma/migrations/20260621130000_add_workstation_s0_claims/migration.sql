-- CreateTable
CREATE TABLE "WorkItemClaim" (
    "id" TEXT NOT NULL,
    "stationType" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemRef" TEXT NOT NULL,
    "activeItemRef" TEXT,
    "claimedById" TEXT NOT NULL,
    "claimedByName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "releasedByName" TEXT,

    CONSTRAINT "WorkItemClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkstationActionLog" (
    "id" TEXT NOT NULL,
    "stationType" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT,
    "employeeId" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "sourceInterface" TEXT NOT NULL DEFAULT 'STATION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkstationActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkItemClaim_activeItemRef_key" ON "WorkItemClaim"("activeItemRef");

-- CreateIndex
CREATE INDEX "WorkItemClaim_stationType_status_idx" ON "WorkItemClaim"("stationType", "status");

-- CreateIndex
CREATE INDEX "WorkItemClaim_itemType_itemId_idx" ON "WorkItemClaim"("itemType", "itemId");

-- CreateIndex
CREATE INDEX "WorkItemClaim_itemRef_idx" ON "WorkItemClaim"("itemRef");

-- CreateIndex
CREATE INDEX "WorkItemClaim_claimedById_idx" ON "WorkItemClaim"("claimedById");

-- CreateIndex
CREATE INDEX "WorkItemClaim_claimedAt_idx" ON "WorkItemClaim"("claimedAt");

-- CreateIndex
CREATE INDEX "WorkItemClaim_status_expiresAt_idx" ON "WorkItemClaim"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkstationActionLog_idempotencyKey_key" ON "WorkstationActionLog"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WorkstationActionLog_stationType_createdAt_idx" ON "WorkstationActionLog"("stationType", "createdAt");

-- CreateIndex
CREATE INDEX "WorkstationActionLog_itemType_itemId_idx" ON "WorkstationActionLog"("itemType", "itemId");

-- CreateIndex
CREATE INDEX "WorkstationActionLog_employeeId_idx" ON "WorkstationActionLog"("employeeId");

-- CreateIndex
CREATE INDEX "WorkstationActionLog_status_idx" ON "WorkstationActionLog"("status");
