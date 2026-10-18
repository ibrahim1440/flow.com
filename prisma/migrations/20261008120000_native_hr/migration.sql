
-- CreateEnum
CREATE TYPE "HrEmploymentStatus" AS ENUM ('PROBATION', 'ACTIVE', 'NOTICE', 'SUSPENDED', 'SEPARATED');

-- CreateEnum
CREATE TYPE "HrEmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "HrContractType" AS ENUM ('FIXED_TERM', 'OPEN_ENDED');

-- CreateEnum
CREATE TYPE "HrContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ENDED');

-- CreateEnum
CREATE TYPE "HrAttendanceStatus" AS ENUM ('OPEN', 'CLOSED', 'ABSENT');

-- CreateEnum
CREATE TYPE "HrDecisionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "HrLeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HrLeaveEntryType" AS ENUM ('OPENING', 'ACCRUAL', 'GRANT', 'TAKE', 'REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "HrDayBasis" AS ENUM ('CALENDAR_DAYS', 'FIXED_30');

-- CreateEnum
CREATE TYPE "HrPolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "HrPayrollRunStatus" AS ENUM ('DRAFT', 'REVIEW', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HrAdvanceStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'DISBURSED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HrApplicantStage" AS ENUM ('APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "HrDepartment" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "HrDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrEmployee" (
    "id" TEXT NOT NULL,
    "employeeNo" TEXT NOT NULL,
    "fullNameAr" TEXT NOT NULL,
    "fullNameEn" TEXT,
    "jobTitle" TEXT NOT NULL,
    "departmentId" TEXT,
    "branchId" TEXT,
    "managerId" TEXT,
    "status" "HrEmploymentStatus" NOT NULL DEFAULT 'PROBATION',
    "employmentType" "HrEmploymentType" NOT NULL DEFAULT 'FULL_TIME',
    "hireDate" DATE NOT NULL,
    "probationEndDate" DATE,
    "separationDate" DATE,
    "workPhone" TEXT,
    "workEmail" TEXT,
    "accountId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "HrEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrEmployeePrivate" (
    "employeeId" TEXT NOT NULL,
    "idType" TEXT,
    "idNumber" TEXT,
    "idExpiry" DATE,
    "nationality" TEXT,
    "contributionGroup" TEXT,
    "dateOfBirth" DATE,
    "gender" TEXT,
    "personalPhone" TEXT,
    "personalEmail" TEXT,
    "address" TEXT,
    "bankName" TEXT,
    "iban" TEXT,
    "emergencyName" TEXT,
    "emergencyRelation" TEXT,
    "emergencyPhone" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "HrEmployeePrivate_pkey" PRIMARY KEY ("employeeId")
);

-- CreateTable
CREATE TABLE "HrDocument" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "confidential" BOOLEAN NOT NULL DEFAULT true,
    "expiresOn" DATE,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "HrDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrContract" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "contractNo" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" "HrContractType" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "probationDays" INTEGER,
    "noticeDays" INTEGER NOT NULL,
    "status" "HrContractStatus" NOT NULL DEFAULT 'DRAFT',
    "supersedesId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedBy" TEXT,
    "activatedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "HrContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrCompensation" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "basic" DECIMAL(18,2) NOT NULL,
    "housing" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "transport" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherAllowance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "contractId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrCompensation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrShift" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "graceMinutes" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrShiftAssignment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "weekdays" INTEGER[],
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrShiftAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrAttendance" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "shiftId" TEXT,
    "checkInAt" TIMESTAMP(3),
    "checkOutAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "workedMinutes" INTEGER,
    "lateMinutes" INTEGER,
    "overtimeMinutes" INTEGER,
    "status" "HrAttendanceStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HrAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrAttendanceCorrection" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attendanceId" TEXT,
    "workDate" DATE NOT NULL,
    "requestedCheckIn" TIMESTAMP(3),
    "requestedCheckOut" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "status" "HrDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "before" JSONB,

    CONSTRAINT "HrAttendanceCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrOvertime" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "attendanceId" TEXT,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "status" "HrDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "payrollRunId" TEXT,

    CONSTRAINT "HrOvertime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrLeaveType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "tracksBalance" BOOLEAN NOT NULL DEFAULT true,
    "accrualDaysPerYear" DECIMAL(6,2),
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isProposal" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrLeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrLeaveRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "status" "HrLeaveStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "requestedBy" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "HrLeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrLeaveLedger" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "entryType" "HrLeaveEntryType" NOT NULL,
    "days" DECIMAL(8,2) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "requestId" TEXT,
    "accrualKey" TEXT,
    "reason" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrLeaveLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrPayrollPolicy" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "status" "HrPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "dayBasis" "HrDayBasis" NOT NULL,
    "standardDailyHours" DECIMAL(5,2) NOT NULL,
    "overtimeMultiplier" DECIMAL(5,2) NOT NULL,
    "maxDeductionPercent" DECIMAL(5,2) NOT NULL,
    "unpaidLeaveComponents" TEXT[],
    "overtimeComponents" TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    "weekendDays" INTEGER[],
    "isProposal" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedBy" TEXT,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "HrPayrollPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrContributionRule" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "employeeRatePercent" DECIMAL(6,3) NOT NULL,
    "employerRatePercent" DECIMAL(6,3) NOT NULL,
    "baseComponents" TEXT[],
    "appliesToGroup" TEXT NOT NULL,
    "monthlyBaseCap" DECIMAL(18,2),
    "sourceNote" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrContributionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "accountingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HrSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrAccountMap" (
    "key" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HrAccountMap_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "HrJournalLink" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrJournalLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrPayrollRun" (
    "id" TEXT NOT NULL,
    "runNo" SERIAL NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'REGULAR',
    "correctsRunId" TEXT,
    "branchKey" TEXT NOT NULL DEFAULT 'COMPANY',
    "status" "HrPayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "policyId" TEXT NOT NULL,
    "preparedBy" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "totalGross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalNet" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalEmployer" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "accountingSkipped" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "HrPayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrPayrollLine" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "payableDays" DECIMAL(6,2) NOT NULL,
    "gross" DECIMAL(18,2) NOT NULL,
    "deductions" DECIMAL(18,2) NOT NULL,
    "net" DECIMAL(18,2) NOT NULL,
    "employer" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "exceptions" JSONB NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "HrPayrollLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrPayrollItem" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "quantity" DECIMAL(12,4),
    "rate" DECIMAL(18,6),
    "sourceType" TEXT,
    "sourceId" TEXT,
    "description" TEXT NOT NULL,

    CONSTRAINT "HrPayrollItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrPayrollAdjustment" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrPayrollAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrPayrollPayment" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrPayrollPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrCommissionReservation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "lineId" TEXT,
    "accountEmployeeId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "ledgerEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HrCommissionReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrAdvance" (
    "id" TEXT NOT NULL,
    "advanceNo" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "installmentCount" INTEGER NOT NULL,
    "firstInstallmentMonth" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "HrAdvanceStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "disbursedBy" TEXT,
    "disbursedAt" TIMESTAMP(3),
    "disbursedOn" DATE,
    "disbursementRef" TEXT,
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "HrAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrAdvanceInstallment" (
    "id" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "dueMonth" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "payrollRunId" TEXT,
    "payrollLineId" TEXT,
    "settledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HrAdvanceInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrAdvanceRepayment" (
    "id" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrAdvanceRepayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrAsset" (
    "id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "serialNo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "HrAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrAssetAssignment" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "assignedOn" DATE NOT NULL,
    "conditionOut" TEXT,
    "assignedBy" TEXT NOT NULL,
    "returnedOn" DATE,
    "conditionIn" TEXT,
    "returnedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrAssetAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrTraining" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "provider" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrTraining_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrReview" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "reviewerAccountId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "strengths" TEXT,
    "improvements" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "HrReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrIncident" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "occurredOn" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "actionTaken" TEXT,
    "confidential" BOOLEAN NOT NULL DEFAULT true,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrJobOpening" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "departmentId" TEXT,
    "branchId" TEXT,
    "openings" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrJobOpening_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrApplicant" (
    "id" TEXT NOT NULL,
    "applicantNo" TEXT NOT NULL,
    "openingId" TEXT,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "source" TEXT,
    "stage" "HrApplicantStage" NOT NULL DEFAULT 'APPLIED',
    "notes" TEXT,
    "hiredEmployeeId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HrApplicant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrInterview" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "interviewerAccountId" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrInterview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrOffer" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "basic" DECIMAL(18,2) NOT NULL,
    "housing" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "transport" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherAllowance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "startDate" DATE NOT NULL,
    "contractType" "HrContractType" NOT NULL,
    "contractMonths" INTEGER,
    "probationDays" INTEGER,
    "noticeDays" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "HrOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrSeparation" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "noticeDate" DATE NOT NULL,
    "lastWorkingDay" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "eosAmount" DECIMAL(18,2),
    "eosBasisNote" TEXT,
    "leaveEncashmentDays" DECIMAL(6,2),
    "otherSettlement" DECIMAL(18,2),
    "settlementNotes" TEXT,
    "deactivateAccount" BOOLEAN NOT NULL DEFAULT true,
    "initiatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "HrSeparation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrAuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "employeeId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HrDepartment_code_key" ON "HrDepartment"("code");

-- CreateIndex
CREATE UNIQUE INDEX "HrEmployee_employeeNo_key" ON "HrEmployee"("employeeNo");

-- CreateIndex
CREATE UNIQUE INDEX "HrEmployee_accountId_key" ON "HrEmployee"("accountId");

-- CreateIndex
CREATE INDEX "HrEmployee_status_idx" ON "HrEmployee"("status");

-- CreateIndex
CREATE INDEX "HrEmployee_branchId_idx" ON "HrEmployee"("branchId");

-- CreateIndex
CREATE INDEX "HrEmployee_managerId_idx" ON "HrEmployee"("managerId");

-- CreateIndex
CREATE INDEX "HrEmployee_departmentId_idx" ON "HrEmployee"("departmentId");

-- CreateIndex
CREATE INDEX "HrDocument_employeeId_idx" ON "HrDocument"("employeeId");

-- CreateIndex
CREATE INDEX "HrDocument_expiresOn_idx" ON "HrDocument"("expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "HrContract_contractNo_key" ON "HrContract"("contractNo");

-- CreateIndex
CREATE UNIQUE INDEX "HrContract_supersedesId_key" ON "HrContract"("supersedesId");

-- CreateIndex
CREATE INDEX "HrContract_status_endDate_idx" ON "HrContract"("status", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "HrContract_employeeId_version_key" ON "HrContract"("employeeId", "version");

-- CreateIndex
CREATE INDEX "HrCompensation_employeeId_effectiveFrom_idx" ON "HrCompensation"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "HrShift_code_key" ON "HrShift"("code");

-- CreateIndex
CREATE INDEX "HrShiftAssignment_employeeId_effectiveFrom_idx" ON "HrShiftAssignment"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "HrAttendance_workDate_idx" ON "HrAttendance"("workDate");

-- CreateIndex
CREATE UNIQUE INDEX "HrAttendance_employeeId_workDate_key" ON "HrAttendance"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "HrAttendanceCorrection_status_idx" ON "HrAttendanceCorrection"("status");

-- CreateIndex
CREATE INDEX "HrAttendanceCorrection_employeeId_workDate_idx" ON "HrAttendanceCorrection"("employeeId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "HrOvertime_attendanceId_key" ON "HrOvertime"("attendanceId");

-- CreateIndex
CREATE INDEX "HrOvertime_status_workDate_idx" ON "HrOvertime"("status", "workDate");

-- CreateIndex
CREATE INDEX "HrOvertime_employeeId_workDate_idx" ON "HrOvertime"("employeeId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "HrLeaveType_code_key" ON "HrLeaveType"("code");

-- CreateIndex
CREATE INDEX "HrLeaveRequest_employeeId_startDate_idx" ON "HrLeaveRequest"("employeeId", "startDate");

-- CreateIndex
CREATE INDEX "HrLeaveRequest_status_idx" ON "HrLeaveRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "HrLeaveRequest_requestedBy_idempotencyKey_key" ON "HrLeaveRequest"("requestedBy", "idempotencyKey");

-- CreateIndex
CREATE INDEX "HrLeaveLedger_employeeId_leaveTypeId_idx" ON "HrLeaveLedger"("employeeId", "leaveTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "HrLeaveLedger_employeeId_leaveTypeId_accrualKey_key" ON "HrLeaveLedger"("employeeId", "leaveTypeId", "accrualKey");

-- CreateIndex
CREATE UNIQUE INDEX "HrPayrollPolicy_version_key" ON "HrPayrollPolicy"("version");

-- CreateIndex
CREATE INDEX "HrPayrollPolicy_status_effectiveFrom_idx" ON "HrPayrollPolicy"("status", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "HrContributionRule_policyId_code_key" ON "HrContributionRule"("policyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "HrJournalLink_journalEntryId_key" ON "HrJournalLink"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "HrJournalLink_sourceType_sourceId_purpose_key" ON "HrJournalLink"("sourceType", "sourceId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "HrPayrollRun_runNo_key" ON "HrPayrollRun"("runNo");

-- CreateIndex
CREATE INDEX "HrPayrollRun_periodMonth_status_idx" ON "HrPayrollRun"("periodMonth", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HrPayrollLine_runId_employeeId_key" ON "HrPayrollLine"("runId", "employeeId");

-- CreateIndex
CREATE INDEX "HrPayrollItem_lineId_idx" ON "HrPayrollItem"("lineId");

-- CreateIndex
CREATE INDEX "HrPayrollAdjustment_runId_idx" ON "HrPayrollAdjustment"("runId");

-- CreateIndex
CREATE INDEX "HrCommissionReservation_accountEmployeeId_periodStart_idx" ON "HrCommissionReservation"("accountEmployeeId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "HrAdvance_advanceNo_key" ON "HrAdvance"("advanceNo");

-- CreateIndex
CREATE INDEX "HrAdvance_employeeId_status_idx" ON "HrAdvance"("employeeId", "status");

-- CreateIndex
CREATE INDEX "HrAdvanceInstallment_status_dueMonth_idx" ON "HrAdvanceInstallment"("status", "dueMonth");

-- CreateIndex
CREATE UNIQUE INDEX "HrAdvanceInstallment_advanceId_seq_key" ON "HrAdvanceInstallment"("advanceId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "HrAsset_tag_key" ON "HrAsset"("tag");

-- CreateIndex
CREATE INDEX "HrAssetAssignment_employeeId_idx" ON "HrAssetAssignment"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "HrJobOpening_code_key" ON "HrJobOpening"("code");

-- CreateIndex
CREATE UNIQUE INDEX "HrApplicant_applicantNo_key" ON "HrApplicant"("applicantNo");

-- CreateIndex
CREATE UNIQUE INDEX "HrApplicant_hiredEmployeeId_key" ON "HrApplicant"("hiredEmployeeId");

-- CreateIndex
CREATE INDEX "HrSeparation_employeeId_status_idx" ON "HrSeparation"("employeeId", "status");

-- CreateIndex
CREATE INDEX "HrAuditLog_entityType_entityId_idx" ON "HrAuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "HrAuditLog_employeeId_createdAt_idx" ON "HrAuditLog"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "HrAuditLog_createdAt_idx" ON "HrAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "HrEmployee" ADD CONSTRAINT "HrEmployee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "HrDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrEmployee" ADD CONSTRAINT "HrEmployee_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "FinBranch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrEmployee" ADD CONSTRAINT "HrEmployee_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "HrEmployee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrEmployee" ADD CONSTRAINT "HrEmployee_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrEmployeePrivate" ADD CONSTRAINT "HrEmployeePrivate_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrDocument" ADD CONSTRAINT "HrDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrContract" ADD CONSTRAINT "HrContract_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrContract" ADD CONSTRAINT "HrContract_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "HrContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrCompensation" ADD CONSTRAINT "HrCompensation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrShiftAssignment" ADD CONSTRAINT "HrShiftAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrShiftAssignment" ADD CONSTRAINT "HrShiftAssignment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "HrShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrAttendance" ADD CONSTRAINT "HrAttendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrAttendanceCorrection" ADD CONSTRAINT "HrAttendanceCorrection_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrAttendanceCorrection" ADD CONSTRAINT "HrAttendanceCorrection_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "HrAttendance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrOvertime" ADD CONSTRAINT "HrOvertime_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrOvertime" ADD CONSTRAINT "HrOvertime_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "HrAttendance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrLeaveRequest" ADD CONSTRAINT "HrLeaveRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrLeaveRequest" ADD CONSTRAINT "HrLeaveRequest_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "HrLeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrLeaveLedger" ADD CONSTRAINT "HrLeaveLedger_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrLeaveLedger" ADD CONSTRAINT "HrLeaveLedger_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "HrLeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrLeaveLedger" ADD CONSTRAINT "HrLeaveLedger_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "HrLeaveRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrContributionRule" ADD CONSTRAINT "HrContributionRule_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "HrPayrollPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrAccountMap" ADD CONSTRAINT "HrAccountMap_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrJournalLink" ADD CONSTRAINT "HrJournalLink_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrPayrollRun" ADD CONSTRAINT "HrPayrollRun_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "HrPayrollPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrPayrollLine" ADD CONSTRAINT "HrPayrollLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "HrPayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrPayrollLine" ADD CONSTRAINT "HrPayrollLine_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrPayrollItem" ADD CONSTRAINT "HrPayrollItem_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "HrPayrollLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrPayrollAdjustment" ADD CONSTRAINT "HrPayrollAdjustment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "HrPayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrPayrollAdjustment" ADD CONSTRAINT "HrPayrollAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrPayrollPayment" ADD CONSTRAINT "HrPayrollPayment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "HrPayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrCommissionReservation" ADD CONSTRAINT "HrCommissionReservation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "HrPayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrAdvance" ADD CONSTRAINT "HrAdvance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrAdvanceInstallment" ADD CONSTRAINT "HrAdvanceInstallment_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "HrAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrAdvanceRepayment" ADD CONSTRAINT "HrAdvanceRepayment_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "HrAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrAssetAssignment" ADD CONSTRAINT "HrAssetAssignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "HrAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrAssetAssignment" ADD CONSTRAINT "HrAssetAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrTraining" ADD CONSTRAINT "HrTraining_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrReview" ADD CONSTRAINT "HrReview_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrIncident" ADD CONSTRAINT "HrIncident_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrJobOpening" ADD CONSTRAINT "HrJobOpening_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "HrDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrJobOpening" ADD CONSTRAINT "HrJobOpening_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "FinBranch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrApplicant" ADD CONSTRAINT "HrApplicant_openingId_fkey" FOREIGN KEY ("openingId") REFERENCES "HrJobOpening"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrApplicant" ADD CONSTRAINT "HrApplicant_hiredEmployeeId_fkey" FOREIGN KEY ("hiredEmployeeId") REFERENCES "HrEmployee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrInterview" ADD CONSTRAINT "HrInterview_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "HrApplicant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrOffer" ADD CONSTRAINT "HrOffer_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "HrApplicant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrSeparation" ADD CONSTRAINT "HrSeparation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════════════
--  Native HR — hand-written database controls.
--  Prisma cannot express these; preserve them if this migration is ever regenerated
--  (see docs/migration-drift-and-db-constraints.md). The service layer enforces the
--  same rules first; these are the backstop for any other writer.
-- ═══════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hr_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'HR: % on % is not allowed (append-only record)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

-- Append-only records.
CREATE TRIGGER "HrAuditLog_append_only" BEFORE UPDATE OR DELETE ON "HrAuditLog"
  FOR EACH ROW EXECUTE FUNCTION hr_forbid_mutation();
CREATE TRIGGER "HrLeaveLedger_append_only" BEFORE UPDATE OR DELETE ON "HrLeaveLedger"
  FOR EACH ROW EXECUTE FUNCTION hr_forbid_mutation();
CREATE TRIGGER "HrPayrollPayment_append_only" BEFORE UPDATE OR DELETE ON "HrPayrollPayment"
  FOR EACH ROW EXECUTE FUNCTION hr_forbid_mutation();
CREATE TRIGGER "HrAdvanceRepayment_append_only" BEFORE UPDATE OR DELETE ON "HrAdvanceRepayment"
  FOR EACH ROW EXECUTE FUNCTION hr_forbid_mutation();
CREATE TRIGGER "HrJournalLink_append_only" BEFORE UPDATE OR DELETE ON "HrJournalLink"
  FOR EACH ROW EXECUTE FUNCTION hr_forbid_mutation();
CREATE TRIGGER "HrDocument_no_delete" BEFORE DELETE ON "HrDocument"
  FOR EACH ROW EXECUTE FUNCTION hr_forbid_mutation();

-- Amount and range checks.
ALTER TABLE "HrLeaveLedger" ADD CONSTRAINT "HrLeaveLedger_days_nonzero" CHECK ("days" <> 0);
ALTER TABLE "HrLeaveRequest"
  ADD CONSTRAINT "HrLeaveRequest_dates" CHECK ("endDate" >= "startDate"),
  ADD CONSTRAINT "HrLeaveRequest_days_positive" CHECK ("days" > 0);
ALTER TABLE "HrPayrollPayment" ADD CONSTRAINT "HrPayrollPayment_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "HrAdvanceRepayment" ADD CONSTRAINT "HrAdvanceRepayment_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "HrAdvance"
  ADD CONSTRAINT "HrAdvance_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "HrAdvance_installments_range" CHECK ("installmentCount" BETWEEN 1 AND 120),
  ADD CONSTRAINT "HrAdvance_month_format" CHECK ("firstInstallmentMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "HrAdvanceInstallment"
  ADD CONSTRAINT "HrAdvanceInstallment_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "HrAdvanceInstallment_status" CHECK ("status" IN ('SCHEDULED','RESERVED','SETTLED','COVERED')),
  ADD CONSTRAINT "HrAdvanceInstallment_reserved_has_run"
    CHECK (("status" IN ('RESERVED','SETTLED')) = ("payrollRunId" IS NOT NULL) OR "status" = 'COVERED');
ALTER TABLE "HrCompensation"
  ADD CONSTRAINT "HrCompensation_amounts" CHECK ("basic" > 0 AND "housing" >= 0 AND "transport" >= 0 AND "otherAllowance" >= 0),
  ADD CONSTRAINT "HrCompensation_dates" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");
ALTER TABLE "HrContract"
  ADD CONSTRAINT "HrContract_dates" CHECK ("endDate" IS NULL OR "endDate" >= "startDate"),
  ADD CONSTRAINT "HrContract_fixed_term_has_end" CHECK ("type" <> 'FIXED_TERM' OR "endDate" IS NOT NULL),
  ADD CONSTRAINT "HrContract_notice_nonnegative" CHECK ("noticeDays" >= 0);
ALTER TABLE "HrOvertime" ADD CONSTRAINT "HrOvertime_minutes_positive" CHECK ("minutes" > 0);
ALTER TABLE "HrPayrollRun"
  ADD CONSTRAINT "HrPayrollRun_month_format" CHECK ("periodMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT "HrPayrollRun_net_identity" CHECK ("totalNet" = "totalGross" - "totalDeductions");
ALTER TABLE "HrPayrollLine" ADD CONSTRAINT "HrPayrollLine_net_identity" CHECK ("net" = "gross" - "deductions");
ALTER TABLE "HrPayrollItem" ADD CONSTRAINT "HrPayrollItem_kind" CHECK ("kind" IN ('EARNING','DEDUCTION','EMPLOYER'));
ALTER TABLE "HrPayrollAdjustment"
  ADD CONSTRAINT "HrPayrollAdjustment_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "HrPayrollAdjustment_kind" CHECK ("kind" IN ('EARNING','DEDUCTION'));
ALTER TABLE "HrCommissionReservation"
  ADD CONSTRAINT "HrCommissionReservation_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "HrCommissionReservation_status" CHECK ("status" IN ('RESERVED','SETTLED','RELEASED'));
ALTER TABLE "HrReview" ADD CONSTRAINT "HrReview_rating_range" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "HrDocument" ADD CONSTRAINT "HrDocument_size" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 5242880);
ALTER TABLE "HrContributionRule"
  ADD CONSTRAINT "HrContributionRule_rates" CHECK ("employeeRatePercent" >= 0 AND "employeeRatePercent" <= 100
    AND "employerRatePercent" >= 0 AND "employerRatePercent" <= 100);
ALTER TABLE "HrPayrollPolicy"
  ADD CONSTRAINT "HrPayrollPolicy_values" CHECK ("standardDailyHours" > 0 AND "overtimeMultiplier" >= 1
    AND "maxDeductionPercent" > 0 AND "maxDeductionPercent" <= 100),
  ADD CONSTRAINT "HrPayrollPolicy_four_eyes" CHECK ("activatedBy" IS NULL OR "activatedBy" <> "createdBy");

-- One live record where only one may exist.
CREATE UNIQUE INDEX "HrContract_one_active" ON "HrContract" ("employeeId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "HrPayrollRun_one_regular" ON "HrPayrollRun" ("periodMonth", "branchKey")
  WHERE "kind" = 'REGULAR' AND "status" <> 'CANCELLED';
CREATE UNIQUE INDEX "HrCommissionReservation_one_reserved" ON "HrCommissionReservation" ("accountEmployeeId", "periodStart")
  WHERE "status" = 'RESERVED';
CREATE UNIQUE INDEX "HrAssetAssignment_one_open" ON "HrAssetAssignment" ("assetId") WHERE "returnedOn" IS NULL;
CREATE UNIQUE INDEX "HrSeparation_one_open" ON "HrSeparation" ("employeeId") WHERE "status" = 'INITIATED';
CREATE UNIQUE INDEX "HrPayrollPolicy_one_active_per_date" ON "HrPayrollPolicy" ("effectiveFrom") WHERE "status" = 'ACTIVE';

-- Compensation: versions of one person never overlap; a row is never rewritten except to
-- close an open version once; rows are never deleted.
CREATE OR REPLACE FUNCTION hr_compensation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: compensation versions are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."effectiveTo" IS NOT NULL
       OR NEW."employeeId" <> OLD."employeeId" OR NEW."effectiveFrom" <> OLD."effectiveFrom"
       OR NEW."basic" <> OLD."basic" OR NEW."housing" <> OLD."housing" OR NEW."transport" <> OLD."transport"
       OR NEW."otherAllowance" <> OLD."otherAllowance" THEN
      RAISE EXCEPTION 'HR: a compensation version can only be closed once; record a new version instead'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "HrCompensation" c
    WHERE c."employeeId" = NEW."employeeId" AND c."id" <> NEW."id"
      AND c."effectiveFrom" <= COALESCE(NEW."effectiveTo", 'infinity'::date)
      AND NEW."effectiveFrom" <= COALESCE(c."effectiveTo", 'infinity'::date)
  ) THEN
    RAISE EXCEPTION 'HR: compensation versions for one person cannot overlap'
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "HrCompensation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HrCompensation"
  FOR EACH ROW EXECUTE FUNCTION hr_compensation_guard();

-- Four-eyes on every decided request: the decider is neither the requester nor the
-- login of the person the request is about.
CREATE OR REPLACE FUNCTION hr_subject_account(emp text) RETURNS text AS $$
  SELECT "accountId" FROM "HrEmployee" WHERE "id" = emp;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION hr_four_eyes_decision() RETURNS trigger AS $$
BEGIN
  IF NEW."decidedBy" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."decidedBy" IS DISTINCT FROM NEW."decidedBy") THEN
    IF NEW."decidedBy" = NEW."requestedBy" OR NEW."decidedBy" = hr_subject_account(NEW."employeeId") THEN
      RAISE EXCEPTION 'HR: nobody decides their own request or a request about themselves'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "HrLeaveRequest_four_eyes" BEFORE INSERT OR UPDATE ON "HrLeaveRequest"
  FOR EACH ROW EXECUTE FUNCTION hr_four_eyes_decision();
CREATE TRIGGER "HrAttendanceCorrection_four_eyes" BEFORE INSERT OR UPDATE ON "HrAttendanceCorrection"
  FOR EACH ROW EXECUTE FUNCTION hr_four_eyes_decision();
CREATE TRIGGER "HrOvertime_four_eyes" BEFORE INSERT OR UPDATE ON "HrOvertime"
  FOR EACH ROW EXECUTE FUNCTION hr_four_eyes_decision();
CREATE TRIGGER "HrAdvance_four_eyes" BEFORE INSERT OR UPDATE ON "HrAdvance"
  FOR EACH ROW EXECUTE FUNCTION hr_four_eyes_decision();

-- Advances: the person who records the disbursement is not the person who approved it.
ALTER TABLE "HrAdvance" ADD CONSTRAINT "HrAdvance_disburser_not_approver"
  CHECK ("disbursedBy" IS NULL OR "decidedBy" IS NULL OR "disbursedBy" <> "decidedBy");

-- Reviews: nobody reviews themselves.
CREATE OR REPLACE FUNCTION hr_review_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."reviewerAccountId" = hr_subject_account(NEW."employeeId") THEN
    RAISE EXCEPTION 'HR: nobody reviews themselves' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "HrReview_not_self" BEFORE INSERT OR UPDATE ON "HrReview"
  FOR EACH ROW EXECUTE FUNCTION hr_review_guard();

-- Applicant conversion happens once.
CREATE OR REPLACE FUNCTION hr_applicant_hire_once() RETURNS trigger AS $$
BEGIN
  IF OLD."hiredEmployeeId" IS NOT NULL AND NEW."hiredEmployeeId" IS DISTINCT FROM OLD."hiredEmployeeId" THEN
    RAISE EXCEPTION 'HR: an applicant is converted to an employee only once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "HrApplicant_hire_once" BEFORE UPDATE ON "HrApplicant"
  FOR EACH ROW EXECUTE FUNCTION hr_applicant_hire_once();

-- Documents: the stored bytes and their hash are never rewritten.
CREATE OR REPLACE FUNCTION hr_document_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."content" <> OLD."content" OR NEW."sha256" <> OLD."sha256" OR NEW."employeeId" <> OLD."employeeId" THEN
    RAISE EXCEPTION 'HR: a stored document is never rewritten; upload a new one' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "HrDocument_immutable_content" BEFORE UPDATE ON "HrDocument"
  FOR EACH ROW EXECUTE FUNCTION hr_document_guard();

-- Payroll run lifecycle. Allowed transitions only; PAID and CANCELLED are terminal; a run
-- becomes APPROVED only when every line is approved and none is blocking; approval and
-- preparation are different people.
CREATE OR REPLACE FUNCTION hr_payroll_run_guard() RETURNS trigger AS $$
DECLARE n_pending int; n_blocking int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: payroll runs are cancelled, never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'HR: a payroll run starts as DRAFT' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('PAID', 'CANCELLED') THEN
    RAISE EXCEPTION 'HR: a % payroll run cannot change', OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'APPROVED' AND NEW."status" = 'APPROVED' AND (
       NEW."totalGross" <> OLD."totalGross" OR NEW."totalNet" <> OLD."totalNet"
       OR NEW."totalDeductions" <> OLD."totalDeductions" OR NEW."policyId" <> OLD."policyId") THEN
    RAISE EXCEPTION 'HR: an approved payroll run is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('REVIEW', 'CANCELLED'))
    OR (OLD."status" = 'REVIEW' AND NEW."status" IN ('DRAFT', 'APPROVED', 'CANCELLED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('PAID', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'HR: payroll run cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'APPROVED' AND OLD."status" <> 'APPROVED' THEN
    SELECT count(*) FILTER (WHERE "approvedBy" IS NULL), count(*) FILTER (WHERE "blocking")
      INTO n_pending, n_blocking FROM "HrPayrollLine" WHERE "runId" = NEW."id";
    IF n_pending > 0 OR n_blocking > 0 THEN
      RAISE EXCEPTION 'HR: % lines unapproved, % blocking — the run cannot be approved', n_pending, n_blocking
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "HrPayrollRun_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HrPayrollRun"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_run_guard();

-- Payslips are immutable once their run is approved, paid or cancelled. A line is approved
-- by someone who neither prepared the run nor is paid by the line.
CREATE OR REPLACE FUNCTION hr_payroll_line_guard() RETURNS trigger AS $$
DECLARE run_status text; preparer text;
BEGIN
  SELECT "status", "preparedBy" INTO run_status, preparer FROM "HrPayrollRun"
    WHERE "id" = COALESCE(NEW."runId", OLD."runId");
  IF run_status IN ('APPROVED', 'PAID', 'CANCELLED') THEN
    RAISE EXCEPTION 'HR: payslip lines of a % run are immutable', run_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."approvedBy" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."approvedBy" IS DISTINCT FROM NEW."approvedBy") THEN
    IF NEW."approvedBy" = preparer OR NEW."approvedBy" = hr_subject_account(NEW."employeeId") THEN
      RAISE EXCEPTION 'HR: a payroll line is approved by someone who neither prepared the run nor is paid by it'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "HrPayrollLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HrPayrollLine"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_line_guard();

CREATE OR REPLACE FUNCTION hr_payroll_item_guard() RETURNS trigger AS $$
DECLARE run_status text;
BEGIN
  SELECT r."status" INTO run_status FROM "HrPayrollLine" l JOIN "HrPayrollRun" r ON r."id" = l."runId"
    WHERE l."id" = COALESCE(NEW."lineId", OLD."lineId");
  IF run_status IN ('APPROVED', 'PAID', 'CANCELLED') THEN
    RAISE EXCEPTION 'HR: payslip items of a % run are immutable', run_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "HrPayrollItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HrPayrollItem"
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_item_guard();

-- A settled installment, a settled or released commission reservation, are history.
CREATE OR REPLACE FUNCTION hr_settled_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR: % rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" IN ('SETTLED', 'RELEASED', 'COVERED') THEN
    RAISE EXCEPTION 'HR: a % row is history and cannot change', OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "HrAdvanceInstallment_settled_guard" BEFORE UPDATE OR DELETE ON "HrAdvanceInstallment"
  FOR EACH ROW EXECUTE FUNCTION hr_settled_guard();
CREATE TRIGGER "HrCommissionReservation_settled_guard" BEFORE UPDATE OR DELETE ON "HrCommissionReservation"
  FOR EACH ROW EXECUTE FUNCTION hr_settled_guard();
