-- Commission plan builder (feat/commission-builder). Owner request: configurable sales commission
-- plans made of components — order-sequence commission on new clients, a target-achievement bonus
-- and a marginal over-target incentive — with a ready-made template that reproduces the current
-- policy («ثالثاً: هيكل العمولات والحوافز»). The existing engine (CommissionPlanVersion,
-- CommissionAssignment, CommissionAccrual, CommissionLedgerEntry) is EXTENDED, not duplicated: a
-- version either keeps its tiered rules (components NULL, every existing row) or carries components.
--
-- ADDITIVE ONLY:
--   "CommissionPlan"."templateKey"               TEXT NULL — the template a plan was made from.
--   "CommissionPlanVersion"."components"         JSONB NULL — NULL = the tiered rules exactly as
--                                                before; CHECK: NULL or a JSON object.
--   "Customer"."newClientCommissionExcluded"      BOOLEAN NOT NULL DEFAULT false (metadata-only),
--   "Customer"."newClientExclusionReason/ById/At" nullable; CHECK: an exclusion carries a reason.
--   "Customer"."commissionPriorOrders"            INTEGER NULL (opening setup; CHECK 0..999).
--   "CommissionSettings"       new, empty singleton («إعدادات العمولات»): new-client window, lapse,
--                              eligibility, activation date (NULL = not activated); CHECKs.
--   "CommissionAuditLog"       new, empty: every settings / opening / exclusion change; CHECKs.
--   "CommissionPeriodResult"   new, empty: the monthly A/B/C result per employee (a projection).
--   "CommissionBonusDecision"  new, empty: management decisions on the discretionary / override
--                              bonus; append-only by the application, one live row per month
--                              (partial unique index), CHECKs on its own rows.
-- No existing row is written, nothing is renamed, dropped or back-filled; existing plans, versions,
-- assignments, accruals and ledger entries keep their meaning (every existing version reads NULL).
-- The previous application version never reads the new columns or tables.
-- Grants: re-run scripts/release/grant-app-runtime.sql and scripts/hr/grant-hr-runtime.sql.
-- Atomic: the whole file runs in one transaction. Rollback:
-- docs/hr/migration-review/rollback-20261101090000_commission_builder.sql.
BEGIN;

ALTER TABLE "CommissionPlan" ADD COLUMN "templateKey" TEXT;
ALTER TABLE "CommissionPlan" ADD CONSTRAINT "CommissionPlan_templateKey_check"
  CHECK ("templateKey" IS NULL OR "templateKey" ~ '^[A-Z0-9_]{2,40}$');

ALTER TABLE "CommissionPlanVersion" ADD COLUMN "components" JSONB;
ALTER TABLE "CommissionPlanVersion" ADD CONSTRAINT "CommissionPlanVersion_components_check"
  CHECK ("components" IS NULL OR jsonb_typeof("components") = 'object');

ALTER TABLE "Customer" ADD COLUMN "newClientCommissionExcluded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "newClientExclusionReason" TEXT,
  ADD COLUMN "newClientExclusionById" TEXT,
  ADD COLUMN "newClientExclusionAt" TIMESTAMP(3),
  ADD COLUMN "commissionPriorOrders" INTEGER;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_commissionPriorOrders_check"
  CHECK ("commissionPriorOrders" IS NULL OR "commissionPriorOrders" BETWEEN 0 AND 999);
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_newClientExclusion_check"
  CHECK (NOT "newClientCommissionExcluded"
         OR ("newClientExclusionReason" IS NOT NULL AND length(btrim("newClientExclusionReason")) >= 3));

CREATE TABLE "CommissionPeriodResult" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "targetAmount" DECIMAL(18,2),
    "qualifiedBase" DECIMAL(18,2) NOT NULL,
    "collectedBase" DECIMAL(18,2) NOT NULL,
    "achievementPercent" DECIMAL(12,6),
    "diffAmount" DECIMAL(18,2),
    "diffPercent" DECIMAL(12,6),
    "clientCommission" DECIMAL(18,2) NOT NULL,
    "targetBonus" DECIMAL(18,2) NOT NULL,
    "overTargetIncentive" DECIMAL(18,2) NOT NULL,
    "totalVariable" DECIMAL(18,2) NOT NULL,
    "bracketIndex" INTEGER,
    "bracketKind" TEXT,
    "decisionStatus" TEXT NOT NULL DEFAULT 'NONE',
    "breakdown" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "computedById" TEXT,

    CONSTRAINT "CommissionPeriodResult_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommissionPeriodResult_period_check" CHECK ("periodEnd" > "periodStart"),
    CONSTRAINT "CommissionPeriodResult_amounts_check" CHECK ("qualifiedBase" >= 0 AND "collectedBase" >= 0
      AND "clientCommission" >= 0 AND "targetBonus" >= 0 AND "overTargetIncentive" >= 0 AND "totalVariable" >= 0),
    CONSTRAINT "CommissionPeriodResult_decision_check" CHECK ("decisionStatus" IN ('NONE', 'PENDING', 'DECIDED')),
    CONSTRAINT "CommissionPeriodResult_bracketKind_check" CHECK ("bracketKind" IS NULL OR "bracketKind" IN ('NONE', 'FIXED', 'DISCRETIONARY')),
    CONSTRAINT "CommissionPeriodResult_breakdown_check" CHECK (jsonb_typeof("breakdown") = 'object')
);

CREATE TABLE "CommissionBonusDecision" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "bracketIndex" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "CommissionBonusDecision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommissionBonusDecision_kind_check" CHECK ("kind" IN ('DISCRETIONARY', 'OVERRIDE')),
    CONSTRAINT "CommissionBonusDecision_amount_check" CHECK ("amount" >= 0),
    CONSTRAINT "CommissionBonusDecision_reason_check" CHECK (length(btrim("reason")) >= 3),
    CONSTRAINT "CommissionBonusDecision_bracket_check" CHECK ("bracketIndex" >= 0),
    CONSTRAINT "CommissionBonusDecision_superseded_check" CHECK ("supersededAt" IS NULL OR "supersededAt" >= "decidedAt")
);

CREATE TABLE "CommissionSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "newClientWindowValue" INTEGER NOT NULL DEFAULT 12,
    "newClientWindowUnit" TEXT NOT NULL DEFAULT 'MONTHS',
    "lapseValue" INTEGER NOT NULL DEFAULT 12,
    "lapseUnit" TEXT NOT NULL DEFAULT 'MONTHS',
    "eligibilityValue" INTEGER,
    "eligibilityUnit" TEXT,
    "activationDate" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommissionSettings_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "CommissionSettings_window_check" CHECK ("newClientWindowUnit" IN ('DAYS', 'MONTHS')
      AND "newClientWindowValue" BETWEEN 1 AND (CASE WHEN "newClientWindowUnit" = 'DAYS' THEN 3650 ELSE 120 END)),
    CONSTRAINT "CommissionSettings_lapse_check" CHECK ("lapseUnit" IN ('DAYS', 'MONTHS')
      AND "lapseValue" BETWEEN 1 AND (CASE WHEN "lapseUnit" = 'DAYS' THEN 3650 ELSE 120 END)),
    CONSTRAINT "CommissionSettings_eligibility_check" CHECK (("eligibilityValue" IS NULL AND "eligibilityUnit" IS NULL)
      OR ("eligibilityUnit" IN ('DAYS', 'MONTHS') AND "eligibilityValue" BETWEEN 1 AND (CASE WHEN "eligibilityUnit" = 'DAYS' THEN 3650 ELSE 120 END)))
);

CREATE TABLE "CommissionAuditLog" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "customerId" TEXT,
    "source" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionAuditLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommissionAuditLog_kind_check" CHECK ("kind" IN ('SETTINGS', 'OPENING', 'EXCLUSION')),
    CONSTRAINT "CommissionAuditLog_source_check" CHECK ("source" IN ('INLINE', 'CSV', 'SETTINGS', 'CUSTOMER_FILE')),
    CONSTRAINT "CommissionAuditLog_customer_check" CHECK (("kind" = 'SETTINGS') = ("customerId" IS NULL))
);

CREATE INDEX "CommissionAuditLog_customerId_createdAt_idx" ON "CommissionAuditLog"("customerId", "createdAt");
CREATE INDEX "CommissionAuditLog_kind_createdAt_idx" ON "CommissionAuditLog"("kind", "createdAt");
CREATE INDEX "CommissionPeriodResult_periodStart_idx" ON "CommissionPeriodResult"("periodStart");
CREATE INDEX "CommissionPeriodResult_planVersionId_idx" ON "CommissionPeriodResult"("planVersionId");
CREATE UNIQUE INDEX "CommissionPeriodResult_employeeId_periodStart_key" ON "CommissionPeriodResult"("employeeId", "periodStart");
CREATE INDEX "CommissionBonusDecision_employeeId_periodStart_idx" ON "CommissionBonusDecision"("employeeId", "periodStart");
CREATE UNIQUE INDEX "CommissionBonusDecision_one_live" ON "CommissionBonusDecision"("employeeId", "periodStart") WHERE "supersededAt" IS NULL;

ALTER TABLE "CommissionPeriodResult" ADD CONSTRAINT "CommissionPeriodResult_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionPeriodResult" ADD CONSTRAINT "CommissionPeriodResult_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "CommissionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionBonusDecision" ADD CONSTRAINT "CommissionBonusDecision_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionBonusDecision" ADD CONSTRAINT "CommissionBonusDecision_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "CommissionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
