-- Workstations W2: station devices, the per-employee station PIN and station-scoped sessions
-- (owner approval 22 Oct 2026: D3, D4, D7, D11, D12; Figma UR-13 / UR-14 / UR-14b and WS-S1…S7).
--
-- Additive only: six new tables, three columns on "AuthSession" (one NOT NULL with a constant
-- default, so no rewrite and every existing row reads 'ERP'), one index, and the "AuthSession_method"
-- CHECK re-created as a superset (one more accepted value, STATION_PIN). No rename, no drop of data,
-- no change to an existing row. The previous application version never reads or writes any of it and
-- runs unchanged on the result (its sessions are all scope 'ERP').
--
--   Station             a station: name, type, place, its roaster (roasting), status
--   StationDevice       a shared device bound to one station: pending → active → revoked; the
--                       activation code and the hq_station cookie token are stored as hashes only
--   StationAssignment   who may sign in at a station (UR-13); supervisor is a label only (O-5)
--   StationPin          the employee's own station PIN verifier (not unique, no lookup index)
--   StationPinAttempt   failed attempts per employee per device; lockedAt = locked on that device
--   StationPolicy       idle minutes, PIN attempts, activation-code minutes (NULL = the defaults)
--   AuthSession.scope   ERP | STATION; a STATION session names its station and device

-- AlterTable
ALTER TABLE "AuthSession" ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'ERP',
ADD COLUMN     "stationDeviceId" TEXT,
ADD COLUMN     "stationId" TEXT;

-- CreateTable
CREATE TABLE "Station" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "place" TEXT,
    "roasterId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationDevice" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "deviceCode" TEXT NOT NULL,
    "tokenHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "activationCodeHash" TEXT,
    "activationExpiresAt" TIMESTAMP(3),
    "activationAttempts" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "registeredById" TEXT,
    "registeredByName" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokedByName" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "StationDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationAssignment" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "supervisor" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StationAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationPin" (
    "employeeId" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationPin_pkey" PRIMARY KEY ("employeeId")
);

-- CreateTable
CREATE TABLE "StationPinAttempt" (
    "employeeId" TEXT NOT NULL,
    "stationDeviceId" TEXT NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),

    CONSTRAINT "StationPinAttempt_pkey" PRIMARY KEY ("employeeId","stationDeviceId")
);

-- CreateTable
CREATE TABLE "StationPolicy" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "idleMinutes" INTEGER,
    "pinMaxAttempts" INTEGER,
    "activationMinutes" INTEGER,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Station_status_idx" ON "Station"("status");

-- CreateIndex
CREATE UNIQUE INDEX "StationDevice_tokenHash_key" ON "StationDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "StationDevice_stationId_status_idx" ON "StationDevice"("stationId", "status");

-- CreateIndex
CREATE INDEX "StationDevice_status_idx" ON "StationDevice"("status");

-- CreateIndex
CREATE INDEX "StationAssignment_employeeId_idx" ON "StationAssignment"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "StationAssignment_stationId_employeeId_key" ON "StationAssignment"("stationId", "employeeId");

-- CreateIndex
CREATE INDEX "StationPinAttempt_stationDeviceId_idx" ON "StationPinAttempt"("stationDeviceId");

-- CreateIndex
CREATE INDEX "AuthSession_stationDeviceId_idx" ON "AuthSession"("stationDeviceId");

-- AddForeignKey
ALTER TABLE "StationDevice" ADD CONSTRAINT "StationDevice_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAssignment" ADD CONSTRAINT "StationAssignment_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAssignment" ADD CONSTRAINT "StationAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationPin" ADD CONSTRAINT "StationPin_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationPinAttempt" ADD CONSTRAINT "StationPinAttempt_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "StationPin"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationPinAttempt" ADD CONSTRAINT "StationPinAttempt_stationDeviceId_fkey" FOREIGN KEY ("stationDeviceId") REFERENCES "StationDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CHECKs (the application writes only these values).
ALTER TABLE "AuthSession" DROP CONSTRAINT "AuthSession_method";
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_method" CHECK ("method" IN ('PIN', 'USERNAME_PIN', 'PASSWORD', 'STATION_PIN'));
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_scope_check" CHECK ("scope" IN ('ERP', 'STATION'));
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_station_binding_check" CHECK (
  ("scope" = 'ERP' AND "stationId" IS NULL AND "stationDeviceId" IS NULL)
  OR ("scope" = 'STATION' AND "stationId" IS NOT NULL AND "stationDeviceId" IS NOT NULL AND "method" = 'STATION_PIN'));
ALTER TABLE "Station" ADD CONSTRAINT "Station_type_check" CHECK ("type" IN ('ROASTING', 'QUALITY', 'PACKAGING'));
ALTER TABLE "Station" ADD CONSTRAINT "Station_status_check" CHECK ("status" IN ('ACTIVE', 'RETIRED'));
ALTER TABLE "Station" ADD CONSTRAINT "Station_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80);
ALTER TABLE "StationDevice" ADD CONSTRAINT "StationDevice_status_check" CHECK ("status" IN ('PENDING', 'ACTIVE', 'REVOKED'));
ALTER TABLE "StationDevice" ADD CONSTRAINT "StationDevice_deviceCode_check" CHECK ("deviceCode" ~ '^WS-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$');
ALTER TABLE "StationDevice" ADD CONSTRAINT "StationDevice_active_check" CHECK ("status" <> 'ACTIVE' OR ("tokenHash" IS NOT NULL AND "activatedAt" IS NOT NULL));
ALTER TABLE "StationDevice" ADD CONSTRAINT "StationDevice_revoked_check" CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL));
ALTER TABLE "StationPinAttempt" ADD CONSTRAINT "StationPinAttempt_failedCount_check" CHECK ("failedCount" >= 0);
ALTER TABLE "StationPolicy" ADD CONSTRAINT "StationPolicy_singleton_check" CHECK ("id" = 'singleton');
ALTER TABLE "StationPolicy" ADD CONSTRAINT "StationPolicy_values_check" CHECK (
  ("idleMinutes" IS NULL OR "idleMinutes" BETWEEN 1 AND 60)
  AND ("pinMaxAttempts" IS NULL OR "pinMaxAttempts" BETWEEN 3 AND 10)
  AND ("activationMinutes" IS NULL OR "activationMinutes" BETWEEN 1 AND 15));
