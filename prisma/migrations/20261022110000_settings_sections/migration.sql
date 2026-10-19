-- Settings sections (batch "Settings"; Figma F-P01 1205:2 settings navigation, roaster management 377:2
-- RM1–RM5). ADDITIVE ONLY: two nullable columns on "SystemConfig" (no default, so no existing row is
-- rewritten and nothing reads differently until somebody writes them), four new tables, their indexes,
-- two foreign keys between the new tables and CHECK constraints that judge new columns / new rows only.
-- Nothing is dropped, renamed, retyped, made NOT NULL or back-filled.
--   SystemConfig.inventoryLowStockGreenKg (DECIMAL(10,3), CHECK > 0 and ≤ 100000): Settings › Inventory,
--     the green-coffee low-stock line. NULL = the built-in 20 kg applies, exactly as today;
--   SystemConfig.invoiceDefaultVatPercent (DECIMAL(5,2), CHECK 0–100): Settings › Invoicing & tax, the
--     VAT percent a new quotation line starts with. NULL = the built-in 15%, exactly as today;
--   Roaster / RoasterMaintenance / RoasterOperator: Settings › Production & roasting › Roasters
--     (ROASTERS.md §4) — machine configuration, maintenance windows and operator assignment. No
--     foreign key to "Employee" (ids only, audit convention); RoasterMaintenance → Roaster RESTRICT
--     (a roaster is retired, never deleted), RoasterOperator → Roaster CASCADE;
--   SettingsAuditLog: append-only (by the application) trail of every change made from these
--     settings pages, with before / after (no foreign keys, audit convention).
-- Atomic: the whole file runs in one transaction. ADD COLUMN without a default is metadata-only; the
-- CHECKs on the new columns validate against NULLs only. No existing table is scanned or rewritten.
-- Rollback: docs/hr/migration-review/rollback-20261022110000_settings_sections.sql.
BEGIN;

-- AlterTable
ALTER TABLE "SystemConfig" ADD COLUMN     "inventoryLowStockGreenKg" DECIMAL(10,3),
ADD COLUMN     "invoiceDefaultVatPercent" DECIMAL(5,2);

ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_inventoryLowStockGreenKg_check"
  CHECK ("inventoryLowStockGreenKg" IS NULL OR ("inventoryLowStockGreenKg" > 0 AND "inventoryLowStockGreenKg" <= 100000));
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_invoiceDefaultVatPercent_check"
  CHECK ("invoiceDefaultVatPercent" IS NULL OR ("invoiceDefaultVatPercent" >= 0 AND "invoiceDefaultVatPercent" <= 100));

-- CreateTable
CREATE TABLE "Roaster" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturerModel" TEXT,
    "type" TEXT NOT NULL,
    "nominalCapacityKg" DECIMAL(10,3) NOT NULL,
    "defaultTargetKg" DECIMAL(10,3) NOT NULL,
    "minBatchKg" DECIMAL(10,3) NOT NULL,
    "maxBatchKg" DECIMAL(10,3) NOT NULL,
    "cycleMinutes" INTEGER NOT NULL,
    "defaultOperatorId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "statusReason" TEXT,
    "statusUntil" TIMESTAMP(3),
    "statusSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Roaster_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Roaster_type_check" CHECK ("type" IN ('PRODUCTION', 'SAMPLE')),
    CONSTRAINT "Roaster_status_check" CHECK ("status" IN ('AVAILABLE', 'MAINTENANCE', 'STOPPED', 'RETIRED')),
    -- ROASTERS.md §5.2 (1): 0 < min ≤ target ≤ max ≤ nominal. A configuration that breaks it cannot be saved.
    CONSTRAINT "Roaster_limits_check" CHECK ("minBatchKg" > 0 AND "minBatchKg" <= "defaultTargetKg"
      AND "defaultTargetKg" <= "maxBatchKg" AND "maxBatchKg" <= "nominalCapacityKg"),
    CONSTRAINT "Roaster_cycleMinutes_check" CHECK ("cycleMinutes" > 0 AND "cycleMinutes" <= 1440),
    -- A reason is required for maintenance and stop (ROASTERS.md §4).
    CONSTRAINT "Roaster_statusReason_check" CHECK ("status" NOT IN ('MAINTENANCE', 'STOPPED')
      OR ("statusReason" IS NOT NULL AND length(btrim("statusReason")) > 0))
);

-- CreateTable
CREATE TABLE "RoasterMaintenance" (
    "id" TEXT NOT NULL,
    "roasterId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recurrenceWeeks" INTEGER,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "requestedById" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoasterMaintenance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RoasterMaintenance_kind_check" CHECK ("kind" IN ('ROUTINE', 'ONE_OFF')),
    CONSTRAINT "RoasterMaintenance_status_check" CHECK ("status" IN ('PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
    CONSTRAINT "RoasterMaintenance_window_check" CHECK ("endsAt" > "startsAt"),
    CONSTRAINT "RoasterMaintenance_recurrence_check" CHECK ("recurrenceWeeks" IS NULL
      OR ("kind" = 'ROUTINE' AND "recurrenceWeeks" BETWEEN 1 AND 52))
);

-- CreateTable
CREATE TABLE "RoasterOperator" (
    "id" TEXT NOT NULL,
    "roasterId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoasterOperator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettingsAuditLog" (
    "id" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "changed" TEXT[],
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettingsAuditLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SettingsAuditLog_section_check" CHECK ("section" IN ('production', 'inventory', 'invoicing')),
    CONSTRAINT "SettingsAuditLog_action_check" CHECK ("action" IN ('SETTINGS_UPDATED', 'ROASTER_CREATED', 'ROASTER_UPDATED',
      'ROASTER_STATUS_CHANGED', 'MAINTENANCE_CREATED', 'MAINTENANCE_UPDATED', 'OPERATOR_ASSIGNED', 'OPERATOR_UNASSIGNED'))
);

-- CreateIndex
CREATE INDEX "Roaster_type_status_idx" ON "Roaster"("type", "status");

-- One name per roaster, whatever its case (ROASTERS.md §7 «Name required, unique»).
CREATE UNIQUE INDEX "Roaster_name_norm_key" ON "Roaster" (lower(btrim("name")));

-- At most one default per type (ROASTERS.md §4 `isDefault`).
CREATE UNIQUE INDEX "Roaster_one_default_per_type" ON "Roaster" ("type") WHERE "isDefault";

-- CreateIndex
CREATE INDEX "RoasterMaintenance_roasterId_startsAt_idx" ON "RoasterMaintenance"("roasterId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoasterOperator_roasterId_employeeId_key" ON "RoasterOperator"("roasterId", "employeeId");

-- CreateIndex
CREATE INDEX "SettingsAuditLog_entityType_entityId_createdAt_idx" ON "SettingsAuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "SettingsAuditLog_section_createdAt_idx" ON "SettingsAuditLog"("section", "createdAt");

-- AddForeignKey
ALTER TABLE "RoasterMaintenance" ADD CONSTRAINT "RoasterMaintenance_roasterId_fkey" FOREIGN KEY ("roasterId") REFERENCES "Roaster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoasterOperator" ADD CONSTRAINT "RoasterOperator_roasterId_fkey" FOREIGN KEY ("roasterId") REFERENCES "Roaster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
