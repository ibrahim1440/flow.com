-- «مساحة عملي» · My Workspace — tasks, appointments, marketing occasions, the reminder outbox (feat/my-workspace).
-- Reference: docs/workspace/INTEGRATION.md.
--
-- ADDITIVE ONLY: 12 new tables prefixed "Work", their indexes, foreign keys from the new tables to
-- "Employee", "Customer", "Lead", "Opportunity" and "MktCampaign" (ON DELETE RESTRICT for the people who
-- own or wrote work, SET NULL for links, CASCADE for a person's own reminders / watch / invitations),
-- CHECK constraints on the new columns, and one trigger function keeping the task history append-only.
-- No existing table, column, row or constraint is altered, dropped, renamed or back-filled; the deployed
-- application never reads the new tables and runs unchanged on the result.
--
-- Rules the database itself holds (not only the service):
--   * every status / kind / priority column takes only its documented values (CHECK);
--   * a task ON_HOLD carries its reason; a cancelled task carries who and when; a DONE task its completion;
--   * an appointment ends after it starts; an occasion ends on or after its first day;
--   * a reminder belongs to exactly one task or one appointment;
--   * "WorkTaskEvent" refuses UPDATE, DELETE and TRUNCATE.
-- Atomic: the whole file runs in one transaction.
-- Rollback: docs/workspace/rollback-20261108090000_my_workspace.sql.
BEGIN;
-- CreateTable
CREATE TABLE "WorkTask" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TASK',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "holdReason" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "assigneeId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "dueBasis" TEXT NOT NULL DEFAULT 'EXACT',
    "plannedStartAt" TIMESTAMP(3),
    "plannedMinutes" INTEGER,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewerId" TEXT,
    "remindBeforeMinutes" INTEGER DEFAULT 60,
    "channel" TEXT,
    "customerId" TEXT,
    "leadId" TEXT,
    "opportunityId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "refLabel" TEXT,
    "occasionId" TEXT,
    "resultActivityId" TEXT,
    "recurRule" TEXT,
    "recurInterval" INTEGER,
    "recurUntil" TIMESTAMP(3),
    "seriesId" TEXT,
    "occurrence" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkTaskChecklistItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,

    CONSTRAINT "WorkTaskChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkTaskComment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkTaskComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkTaskAttachment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkTaskAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkTaskWatcher" (
    "taskId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,

    CONSTRAINT "WorkTaskWatcher_pkey" PRIMARY KEY ("taskId","employeeId")
);

-- CreateTable
CREATE TABLE "WorkTaskEvent" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkTaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkAppointment" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MEETING',
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "meetingUrl" TEXT,
    "externalAttendees" TEXT,
    "organizerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "customerId" TEXT,
    "leadId" TEXT,
    "opportunityId" TEXT,
    "taskId" TEXT,
    "remindBeforeMinutes" INTEGER DEFAULT 30,
    "recurRule" TEXT,
    "recurInterval" INTEGER,
    "recurUntil" TIMESTAMP(3),
    "seriesId" TEXT,
    "occurrence" INTEGER NOT NULL DEFAULT 1,
    "outcomeActivityId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkAppointmentParticipant" (
    "appointmentId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,

    CONSTRAINT "WorkAppointmentParticipant_pkey" PRIMARY KEY ("appointmentId","employeeId")
);

-- CreateTable
CREATE TABLE "WorkOccasion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OCCASION',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "location" TEXT,
    "notes" TEXT,
    "sourceUrl" TEXT,
    "sourceNote" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "campaignId" TEXT,
    "createdById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkOccasion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkReminder" (
    "id" TEXT NOT NULL,
    "taskId" TEXT,
    "appointmentId" TEXT,
    "kind" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "anchorAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "workDays" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4]::INTEGER[],
    "dayStart" TEXT NOT NULL DEFAULT '08:00',
    "dayEnd" TEXT NOT NULL DEFAULT '17:00',
    "hoursConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "defaultRemindBeforeMinutes" INTEGER NOT NULL DEFAULT 60,
    "escalateAfterHours" INTEGER DEFAULT 4,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkJobRun" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,

    CONSTRAINT "WorkJobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkTask_resultActivityId_key" ON "WorkTask"("resultActivityId");

-- CreateIndex
CREATE INDEX "WorkTask_assigneeId_status_dueAt_idx" ON "WorkTask"("assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "WorkTask_createdById_status_idx" ON "WorkTask"("createdById", "status");

-- CreateIndex
CREATE INDEX "WorkTask_status_dueAt_idx" ON "WorkTask"("status", "dueAt");

-- CreateIndex
CREATE INDEX "WorkTask_customerId_idx" ON "WorkTask"("customerId");

-- CreateIndex
CREATE INDEX "WorkTask_occasionId_idx" ON "WorkTask"("occasionId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkTask_seriesId_occurrence_key" ON "WorkTask"("seriesId", "occurrence");

-- CreateIndex
CREATE INDEX "WorkTaskChecklistItem_taskId_position_idx" ON "WorkTaskChecklistItem"("taskId", "position");

-- CreateIndex
CREATE INDEX "WorkTaskComment_taskId_createdAt_idx" ON "WorkTaskComment"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkTaskAttachment_taskId_createdAt_idx" ON "WorkTaskAttachment"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkTaskWatcher_employeeId_idx" ON "WorkTaskWatcher"("employeeId");

-- CreateIndex
CREATE INDEX "WorkTaskEvent_taskId_at_idx" ON "WorkTaskEvent"("taskId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "WorkAppointment_outcomeActivityId_key" ON "WorkAppointment"("outcomeActivityId");

-- CreateIndex
CREATE INDEX "WorkAppointment_organizerId_startAt_idx" ON "WorkAppointment"("organizerId", "startAt");

-- CreateIndex
CREATE INDEX "WorkAppointment_startAt_endAt_idx" ON "WorkAppointment"("startAt", "endAt");

-- CreateIndex
CREATE INDEX "WorkAppointment_customerId_idx" ON "WorkAppointment"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkAppointment_seriesId_occurrence_key" ON "WorkAppointment"("seriesId", "occurrence");

-- CreateIndex
CREATE INDEX "WorkAppointmentParticipant_employeeId_idx" ON "WorkAppointmentParticipant"("employeeId");

-- CreateIndex
CREATE INDEX "WorkOccasion_startDate_endDate_idx" ON "WorkOccasion"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "WorkOccasion_status_idx" ON "WorkOccasion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkReminder_dedupeKey_key" ON "WorkReminder"("dedupeKey");

-- CreateIndex
CREATE INDEX "WorkReminder_status_fireAt_idx" ON "WorkReminder"("status", "fireAt");

-- CreateIndex
CREATE INDEX "WorkReminder_taskId_idx" ON "WorkReminder"("taskId");

-- CreateIndex
CREATE INDEX "WorkReminder_appointmentId_idx" ON "WorkReminder"("appointmentId");

-- CreateIndex
CREATE INDEX "WorkJobRun_startedAt_idx" ON "WorkJobRun"("startedAt");

-- AddForeignKey
ALTER TABLE "WorkTask" ADD CONSTRAINT "WorkTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTask" ADD CONSTRAINT "WorkTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTask" ADD CONSTRAINT "WorkTask_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTask" ADD CONSTRAINT "WorkTask_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTask" ADD CONSTRAINT "WorkTask_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTask" ADD CONSTRAINT "WorkTask_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTask" ADD CONSTRAINT "WorkTask_occasionId_fkey" FOREIGN KEY ("occasionId") REFERENCES "WorkOccasion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTaskChecklistItem" ADD CONSTRAINT "WorkTaskChecklistItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTaskComment" ADD CONSTRAINT "WorkTaskComment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTaskComment" ADD CONSTRAINT "WorkTaskComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTaskAttachment" ADD CONSTRAINT "WorkTaskAttachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTaskAttachment" ADD CONSTRAINT "WorkTaskAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTaskWatcher" ADD CONSTRAINT "WorkTaskWatcher_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTaskWatcher" ADD CONSTRAINT "WorkTaskWatcher_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTaskEvent" ADD CONSTRAINT "WorkTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkAppointment" ADD CONSTRAINT "WorkAppointment_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkAppointment" ADD CONSTRAINT "WorkAppointment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkAppointment" ADD CONSTRAINT "WorkAppointment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkAppointment" ADD CONSTRAINT "WorkAppointment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkAppointmentParticipant" ADD CONSTRAINT "WorkAppointmentParticipant_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "WorkAppointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkAppointmentParticipant" ADD CONSTRAINT "WorkAppointmentParticipant_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOccasion" ADD CONSTRAINT "WorkOccasion_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MktCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkReminder" ADD CONSTRAINT "WorkReminder_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkReminder" ADD CONSTRAINT "WorkReminder_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "WorkAppointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkReminder" ADD CONSTRAINT "WorkReminder_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── CHECK constraints ─────────────────────────────────────────────────────────────────────
ALTER TABLE "WorkTask" ADD CONSTRAINT "WorkTask_kind_check" CHECK ("kind" IN ('TASK', 'FOLLOW_UP')),
  ADD CONSTRAINT "WorkTask_status_check" CHECK ("status" IN ('NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'IN_REVIEW', 'DONE', 'CANCELLED')),
  ADD CONSTRAINT "WorkTask_priority_check" CHECK ("priority" IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  ADD CONSTRAINT "WorkTask_due_basis_check" CHECK ("dueBasis" IN ('CLOCK', 'BUSINESS', 'EXACT')),
  ADD CONSTRAINT "WorkTask_channel_check" CHECK ("channel" IS NULL OR "channel" IN ('CALL', 'VISIT', 'MEETING')),
  ADD CONSTRAINT "WorkTask_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 300),
  ADD CONSTRAINT "WorkTask_hold_check" CHECK ("status" <> 'ON_HOLD' OR length(btrim(coalesce("holdReason", ''))) > 0),
  ADD CONSTRAINT "WorkTask_review_check" CHECK ("status" <> 'IN_REVIEW' OR "requiresReview"),
  ADD CONSTRAINT "WorkTask_done_check" CHECK ("status" <> 'DONE' OR "completedAt" IS NOT NULL),
  ADD CONSTRAINT "WorkTask_cancel_check" CHECK ("status" <> 'CANCELLED' OR ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL)),
  ADD CONSTRAINT "WorkTask_recur_check" CHECK (("recurRule" IS NULL AND "recurInterval" IS NULL) OR ("recurRule" IN ('DAILY', 'WEEKLY', 'MONTHLY') AND "recurInterval" BETWEEN 1 AND 365)),
  ADD CONSTRAINT "WorkTask_values_check" CHECK (("remindBeforeMinutes" IS NULL OR "remindBeforeMinutes" BETWEEN 0 AND 10080) AND ("plannedMinutes" IS NULL OR "plannedMinutes" BETWEEN 1 AND 14400) AND "version" >= 1 AND "occurrence" >= 1),
  ADD CONSTRAINT "WorkTask_ref_check" CHECK (("refType" IS NULL) = ("refId" IS NULL));
ALTER TABLE "WorkTaskComment" ADD CONSTRAINT "WorkTaskComment_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 4000);
ALTER TABLE "WorkTaskAttachment" ADD CONSTRAINT "WorkTaskAttachment_type_check" CHECK ("mimeType" IN ('application/pdf', 'image/jpeg', 'image/png')),
  ADD CONSTRAINT "WorkTaskAttachment_size_check" CHECK ("sizeBytes" BETWEEN 1 AND 5242880 AND octet_length("content") = "sizeBytes"),
  ADD CONSTRAINT "WorkTaskAttachment_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "WorkTaskAttachment_name_check" CHECK (length("fileName") BETWEEN 1 AND 200);
ALTER TABLE "WorkTaskChecklistItem" ADD CONSTRAINT "WorkTaskChecklistItem_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 300);
ALTER TABLE "WorkAppointment" ADD CONSTRAINT "WorkAppointment_kind_check" CHECK ("kind" IN ('MEETING', 'VISIT', 'CALL', 'OTHER')),
  ADD CONSTRAINT "WorkAppointment_status_check" CHECK ("status" IN ('SCHEDULED', 'DONE', 'CANCELLED')),
  ADD CONSTRAINT "WorkAppointment_time_check" CHECK ("endAt" > "startAt"),
  ADD CONSTRAINT "WorkAppointment_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 300),
  ADD CONSTRAINT "WorkAppointment_cancel_check" CHECK ("status" <> 'CANCELLED' OR ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL)),
  ADD CONSTRAINT "WorkAppointment_recur_check" CHECK (("recurRule" IS NULL AND "recurInterval" IS NULL) OR ("recurRule" IN ('DAILY', 'WEEKLY', 'MONTHLY') AND "recurInterval" BETWEEN 1 AND 365)),
  ADD CONSTRAINT "WorkAppointment_values_check" CHECK (("remindBeforeMinutes" IS NULL OR "remindBeforeMinutes" BETWEEN 0 AND 10080) AND "version" >= 1 AND "occurrence" >= 1);
ALTER TABLE "WorkOccasion" ADD CONSTRAINT "WorkOccasion_kind_check" CHECK ("kind" IN ('OCCASION', 'EXHIBITION', 'CAMPAIGN', 'HOLIDAY')),
  ADD CONSTRAINT "WorkOccasion_status_check" CHECK ("status" IN ('DRAFT', 'CONFIRMED', 'CANCELLED')),
  ADD CONSTRAINT "WorkOccasion_dates_check" CHECK ("endDate" >= "startDate"),
  ADD CONSTRAINT "WorkOccasion_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 300),
  ADD CONSTRAINT "WorkOccasion_confirm_check" CHECK ("status" <> 'CONFIRMED' OR ("confirmedAt" IS NOT NULL AND "confirmedById" IS NOT NULL));
ALTER TABLE "WorkReminder" ADD CONSTRAINT "WorkReminder_kind_check" CHECK ("kind" IN ('DUE_SOON', 'OVERDUE', 'ESCALATION', 'APPOINTMENT', 'SNOOZE')),
  ADD CONSTRAINT "WorkReminder_status_check" CHECK ("status" IN ('PENDING', 'SENDING', 'SENT', 'CANCELLED', 'SKIPPED', 'FAILED')),
  ADD CONSTRAINT "WorkReminder_owner_check" CHECK (("taskId" IS NULL) <> ("appointmentId" IS NULL)),
  ADD CONSTRAINT "WorkReminder_attempts_check" CHECK ("attempts" BETWEEN 0 AND 100);
ALTER TABLE "WorkSettings" ADD CONSTRAINT "WorkSettings_singleton_check" CHECK ("id" = 'default'),
  ADD CONSTRAINT "WorkSettings_hours_check" CHECK ("dayStart" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "dayEnd" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "dayEnd" > "dayStart"),
  ADD CONSTRAINT "WorkSettings_days_check" CHECK (cardinality("workDays") BETWEEN 1 AND 7 AND "workDays" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]),
  ADD CONSTRAINT "WorkSettings_values_check" CHECK ("defaultRemindBeforeMinutes" BETWEEN 0 AND 10080 AND ("escalateAfterHours" IS NULL OR "escalateAfterHours" BETWEEN 1 AND 720));
ALTER TABLE "WorkJobRun" ADD CONSTRAINT "WorkJobRun_status_check" CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  ADD CONSTRAINT "WorkJobRun_trigger_check" CHECK ("trigger" IN ('cron', 'request', 'manual'));

-- ─── The task history is append-only ───────────────────────────────────────────────────────
CREATE FUNCTION work_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER "WorkTaskEvent_append_only" BEFORE UPDATE OR DELETE ON "WorkTaskEvent"
  FOR EACH ROW EXECUTE FUNCTION work_append_only();
CREATE TRIGGER "WorkTaskEvent_no_truncate" BEFORE TRUNCATE ON "WorkTaskEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION work_append_only();

COMMIT;
