-- Roasting schedule «جدول التحميص» (Figma 377:2 RM6–RM8; ROASTERS.md §4–§6):
--   RoastPlan      the slots approved together on RM7 («اعتماد الخطة») for one coffee on one roaster,
--                  with the planner's quantities at approval. A plan reserves slots only: no batch, no
--                  stock movement, no order change (§5.9).
--   ScheduledSlot  a planned roast slot, never a batch: roaster, operator, coffee, start / end, planned
--                  green. Stored status PLANNED | IN_PROGRESS | RECORDED | CANCELLED; MISSED is derived
--                  on read by the application (no job). Machine and operator overlap are refused by the
--                  application in one transaction under an advisory lock (§5.5, §5.6).
--   ScheduleEvent  append-only trail of plan approvals and slot moves, reassignments, starts, links
--                  and cancellations (no foreign keys, audit convention).
--   Roaster.workingHours         nullable JSON: the days and hours slots are placed in (NULL = the
--                                built-in Sunday–Thursday 07:00–15:00, Asia/Riyadh).
--   RoastingBatch.scheduledSlotId nullable, unique: the slot a batch was recorded from (NULL for every
--                                existing batch).
--
-- Additive only: three new tables, two nullable columns, new indexes and constraints on the new
-- objects. No existing column, row or constraint changes. ADD COLUMN without a default is
-- metadata-only; the unique index on the new, all-NULL "RoastingBatch"."scheduledSlotId" is built
-- over NULLs. The previous application version never reads or writes the new objects and runs
-- unchanged on the result.
-- Atomic: the whole file runs in one transaction.
-- Rollback: docs/hr/migration-review/rollback-20261026090000_roast_schedule.sql.
BEGIN;

-- AlterTable
ALTER TABLE "Roaster" ADD COLUMN     "workingHours" JSONB;

-- AlterTable
ALTER TABLE "RoastingBatch" ADD COLUMN     "scheduledSlotId" TEXT;

-- CreateTable
CREATE TABLE "RoastPlan" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "roasterId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'DEMAND',
    "split" TEXT NOT NULL DEFAULT 'PROPOSED',
    "batchCount" INTEGER NOT NULL,
    "greenKg" DECIMAL(10,3) NOT NULL,
    "computedGreenKg" DECIMAL(10,3) NOT NULL,
    "overrideReason" TEXT,
    "inputs" JSONB NOT NULL,
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoastPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledSlot" (
    "id" TEXT NOT NULL,
    "planId" TEXT,
    "roasterId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'DEMAND',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "plannedGreenKg" DECIMAL(10,3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "startedAt" TIMESTAMP(3),
    "startedById" TEXT,
    "recordedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleEvent" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "planId" TEXT,
    "slotId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoastPlan_productId_createdAt_idx" ON "RoastPlan"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "RoastPlan_roasterId_createdAt_idx" ON "RoastPlan"("roasterId", "createdAt");

-- CreateIndex
CREATE INDEX "ScheduledSlot_roasterId_startsAt_idx" ON "ScheduledSlot"("roasterId", "startsAt");

-- CreateIndex
CREATE INDEX "ScheduledSlot_operatorId_startsAt_idx" ON "ScheduledSlot"("operatorId", "startsAt");

-- CreateIndex
CREATE INDEX "ScheduledSlot_productId_status_idx" ON "ScheduledSlot"("productId", "status");

-- CreateIndex
CREATE INDEX "ScheduledSlot_status_endsAt_idx" ON "ScheduledSlot"("status", "endsAt");

-- CreateIndex
CREATE INDEX "ScheduledSlot_planId_idx" ON "ScheduledSlot"("planId");

-- CreateIndex
CREATE INDEX "ScheduleEvent_slotId_createdAt_idx" ON "ScheduleEvent"("slotId", "createdAt");

-- CreateIndex
CREATE INDEX "ScheduleEvent_planId_idx" ON "ScheduleEvent"("planId");

-- CreateIndex
CREATE INDEX "ScheduleEvent_createdAt_idx" ON "ScheduleEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoastingBatch_scheduledSlotId_key" ON "RoastingBatch"("scheduledSlotId");

-- AddForeignKey
ALTER TABLE "RoastingBatch" ADD CONSTRAINT "RoastingBatch_scheduledSlotId_fkey" FOREIGN KEY ("scheduledSlotId") REFERENCES "ScheduledSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastPlan" ADD CONSTRAINT "RoastPlan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoastPlan" ADD CONSTRAINT "RoastPlan_roasterId_fkey" FOREIGN KEY ("roasterId") REFERENCES "Roaster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledSlot" ADD CONSTRAINT "ScheduledSlot_planId_fkey" FOREIGN KEY ("planId") REFERENCES "RoastPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledSlot" ADD CONSTRAINT "ScheduledSlot_roasterId_fkey" FOREIGN KEY ("roasterId") REFERENCES "Roaster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledSlot" ADD CONSTRAINT "ScheduledSlot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CoffeeProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Value domains and invariants of the new tables (the application validates first; these are the
-- database backstop).
ALTER TABLE "RoastPlan" ADD CONSTRAINT "RoastPlan_purpose_check" CHECK ("purpose" IN ('DEMAND', 'STOCK'));
ALTER TABLE "RoastPlan" ADD CONSTRAINT "RoastPlan_split_check" CHECK ("split" IN ('PROPOSED', 'ALTERNATIVE'));
ALTER TABLE "RoastPlan" ADD CONSTRAINT "RoastPlan_batchCount_check" CHECK ("batchCount" >= 1 AND "batchCount" <= 500);
ALTER TABLE "RoastPlan" ADD CONSTRAINT "RoastPlan_greenKg_check" CHECK ("greenKg" > 0 AND "computedGreenKg" >= 0);

ALTER TABLE "ScheduledSlot" ADD CONSTRAINT "ScheduledSlot_purpose_check" CHECK ("purpose" IN ('DEMAND', 'STOCK'));
ALTER TABLE "ScheduledSlot" ADD CONSTRAINT "ScheduledSlot_status_check" CHECK ("status" IN ('PLANNED', 'IN_PROGRESS', 'RECORDED', 'CANCELLED'));
ALTER TABLE "ScheduledSlot" ADD CONSTRAINT "ScheduledSlot_window_check" CHECK ("endsAt" > "startsAt");
ALTER TABLE "ScheduledSlot" ADD CONSTRAINT "ScheduledSlot_plannedGreenKg_check" CHECK ("plannedGreenKg" > 0);
ALTER TABLE "ScheduledSlot" ADD CONSTRAINT "ScheduledSlot_cancel_check" CHECK ("status" <> 'CANCELLED' OR ("cancelledAt" IS NOT NULL AND "cancelReason" IS NOT NULL));

ALTER TABLE "ScheduleEvent" ADD CONSTRAINT "ScheduleEvent_action_check" CHECK ("action" IN ('PLAN_APPROVED', 'SLOT_MOVED', 'SLOT_REASSIGNED', 'SLOT_STARTED', 'SLOT_LINKED', 'SLOT_CANCELLED'));

ALTER TABLE "Roaster" ADD CONSTRAINT "Roaster_workingHours_check" CHECK ("workingHours" IS NULL OR jsonb_typeof("workingHours") = 'object');

COMMIT;
