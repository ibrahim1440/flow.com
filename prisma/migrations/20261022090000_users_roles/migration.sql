-- Users, roles & permissions (Figma Phase 8, page 596:2: UR-01 … UR-12; batch "Users & roles").
-- ADDITIVE ONLY: two new tables, "AccessRole" (custom roles; the system templates stay in code) and
-- "PermissionOverride" (explicit per-user exceptions to a role: grant or deny, reason, expiry), with
-- their indexes, CHECKs and foreign keys; and four new columns on "Employee": the nullable
-- "accessRoleId" (FK to "AccessRole", ON DELETE SET NULL, indexed), the nullable
-- "passwordTempExpiresAt", and two booleans NOT NULL DEFAULT false ("passwordMustChange",
-- "pinResetRequired": a constant default, so PostgreSQL records it in the catalogue and rewrites no
-- row). Nothing existing is dropped, renamed, retyped, made NOT NULL or back-filled; no existing row
-- is read or written. Every existing account keeps its role and its permission document, which stay
-- the ones the session applies.
-- Atomic: the whole file runs in one transaction. The new index and FK on "Employee" take a SHARE ROW
-- EXCLUSIVE lock on that table for the time of the build (sign-ins and account edits wait; the table
-- holds a few dozen rows).
-- Rollback: docs/hr/migration-review/rollback-20261022090000_users_roles.sql.
BEGIN;

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "accessRoleId" TEXT,
ADD COLUMN     "passwordMustChange" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordTempExpiresAt" TIMESTAMP(3),
ADD COLUMN     "pinResetRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AccessRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT NOT NULL DEFAULT '{}',
    "basedOn" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessRole_pkey" PRIMARY KEY ("id"),
    -- A role has a name a person can read (1–80 characters after trimming).
    CONSTRAINT "AccessRole_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
    CONSTRAINT "AccessRole_version_check" CHECK ("version" >= 1)
);

-- CreateTable
CREATE TABLE "PermissionOverride" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "sub" TEXT,
    "effect" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "roleValue" TEXT NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "reviewAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    "endReason" TEXT,

    CONSTRAINT "PermissionOverride_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PermissionOverride_effect_check" CHECK ("effect" IN ('GRANT', 'DENY')),
    -- A module level is none / view / edit; an action is true / false.
    CONSTRAINT "PermissionOverride_value_check" CHECK (
        ("sub" IS NULL AND "value" IN ('none', 'view', 'edit') AND "roleValue" IN ('none', 'view', 'edit'))
        OR ("sub" IS NOT NULL AND "value" IN ('true', 'false') AND "roleValue" IN ('true', 'false'))),
    -- Every exception has a reason (Figma UR-09: «لكل استثناء سبب»).
    CONSTRAINT "PermissionOverride_reason_check" CHECK (length(btrim("reason")) >= 3),
    -- Ended together: when, and why.
    CONSTRAINT "PermissionOverride_ended_check" CHECK (("endedAt" IS NULL) = ("endReason" IS NULL)),
    CONSTRAINT "PermissionOverride_endReason_check" CHECK ("endReason" IS NULL OR "endReason" IN ('REMOVED', 'EXPIRED', 'REPLACED'))
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessRole_name_key" ON "AccessRole"("name");

-- CreateIndex
CREATE INDEX "PermissionOverride_employeeId_endedAt_idx" ON "PermissionOverride"("employeeId", "endedAt");

-- CreateIndex
CREATE INDEX "PermissionOverride_endedAt_expiresAt_idx" ON "PermissionOverride"("endedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "Employee_accessRoleId_idx" ON "Employee"("accessRoleId");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_accessRoleId_fkey" FOREIGN KEY ("accessRoleId") REFERENCES "AccessRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionOverride" ADD CONSTRAINT "PermissionOverride_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
