-- Pipeline v2 (owner-approved; PIPELINE-V2-DESIGN.md §3, docs/sales/PIPELINE_STAGES.md):
--   فرصة مؤهلة → تجربة وتقييم العينات (skippable) → عرض السعر والتفاوض → مغلقة (رابحة / خاسرة: the deal's OUTCOME).
--   «التفاوض والاعتماد» (purpose NEGOTIATION) is merged into the QUOTATION stage, renamed «عرض السعر والتفاوض».
--
-- Keyed by PURPOSE, never by code or name, so it is right on every deployment (UAT_* codes included). Idempotent: a
-- second run changes nothing (deterministic event ids, ON CONFLICT, conditional updates). Sends NO message: the deal
-- moves are plain SQL, no "sales.deal_stage_changed" event is written to the outbox. Additive schema only: one
-- nullable column and one partial unique index, and the "StageMoveRequest" table (a rep's manual move waiting for a
-- supervisor, owner decision 3); "OpportunityStageEvent" (append-only) is only INSERTed into.
-- Owner decision 3 also adds the sub-privilege sales › deal_stage_move (move a deal directly), granted here to the
-- «مدير عام» role template and its members (audited in "AuthAuditLog"); «مندوب مبيعات» does NOT get it.
-- The enum value NEGOTIATION is KEPT (unused): Postgres cannot drop an enum value in place, release check 74 asserts
-- it, and rolled-back code may still send it.
-- Rollback: docs/hr/migration-review/rollback-20261217090000_pipeline_v2.sql. Verifier check 83.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Keyed system follow-ups (one OPEN row per key): `sample:<id>`, `deal-follow-up:<id>`.
ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "sourceKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Activity_open_sourceKey_key"
  ON "Activity" ("sourceKey") WHERE "sourceKey" IS NOT NULL AND "completedAt" IS NULL;

-- 1b. A manual stage move waiting for a supervisor (owner decision 3). One PENDING per deal (partial unique index): a
--     new request REPLACES the pending one (SUPERSEDED). Stage and person ids are plain ids, as on the stage events.
CREATE TABLE IF NOT EXISTS "StageMoveRequest" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "fromStageId" TEXT NOT NULL,
    "toStageId" TEXT NOT NULL,
    "reason" TEXT,
    "requestedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StageMoveRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "StageMoveRequest_opportunityId_status_idx" ON "StageMoveRequest"("opportunityId", "status");
CREATE INDEX IF NOT EXISTS "StageMoveRequest_status_createdAt_idx" ON "StageMoveRequest"("status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "StageMoveRequest_one_pending_key" ON "StageMoveRequest"("opportunityId") WHERE "status" = 'PENDING';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StageMoveRequest_opportunityId_fkey') THEN
    ALTER TABLE "StageMoveRequest" ADD CONSTRAINT "StageMoveRequest_opportunityId_fkey" FOREIGN KEY ("opportunityId")
      REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StageMoveRequest_shape_check') THEN
    ALTER TABLE "StageMoveRequest" ADD CONSTRAINT "StageMoveRequest_shape_check" CHECK (
      "status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'SUPERSEDED')
      AND "fromStageId" <> "toStageId"
      AND (("status" = 'PENDING') = ("decidedAt" IS NULL))
      AND ("status" <> 'REJECTED' OR length(btrim(coalesce("decisionNote", ''))) >= 2)
    );
  END IF;
  -- The application's runtime role uses it like every application table (grant-app-runtime.sql grants the same on its
  -- next run; the request is decided, never deleted by the application, and a deal's deletion cascades it).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StageMoveRequest" TO flowcom_app;
  END IF;
END $$;

-- 1c. sales › deal_stage_move for the «مدير عام» role template and the members who follow it (the role editor's own
--     model: the template's document, and each member's copy). Only where the role gives the sales module at all.
--     One "AuthAuditLog" row per member changed, like the role editor writes (via ROLE, the migration as the actor).
WITH r AS (
  UPDATE "AccessRole" a
     SET "permissions" = jsonb_set(jsonb_set(a."permissions"::jsonb, '{sales,sub}', coalesce(a."permissions"::jsonb #> '{sales,sub}', '{}'::jsonb), true),
                                   '{sales,sub,deal_stage_move}', 'true'::jsonb, true)::text,
         "version" = a."version" + 1, "updatedAt" = now()
   WHERE a."name" = 'مدير عام'
     AND CASE WHEN a."permissions" IS JSON OBJECT THEN (a."permissions"::jsonb) ? 'sales' ELSE false END
     AND CASE WHEN a."permissions" IS JSON OBJECT THEN coalesce(a."permissions"::jsonb #>> '{sales,sub,deal_stage_move}', 'false') <> 'true' ELSE false END
  RETURNING a."id", a."name"
), m AS (
  UPDATE "Employee" e
     SET "permissions" = jsonb_set(jsonb_set(e."permissions"::jsonb, '{sales,sub}', coalesce(e."permissions"::jsonb #> '{sales,sub}', '{}'::jsonb), true),
                                   '{sales,sub,deal_stage_move}', 'true'::jsonb, true)::text,
         "updatedAt" = now()
    FROM r
   WHERE e."accessRoleId" = r."id" AND CASE WHEN e."permissions" IS JSON OBJECT THEN (e."permissions"::jsonb) ? 'sales' ELSE false END
  RETURNING e."id", e."name", r."id" AS "roleId", r."name" AS "roleName"
)
INSERT INTO "AuthAuditLog" ("id", "userId", "action", "result", "sourceInterface", "ipHash", "metadata", "occurredAt")
SELECT 'pv2_dsm_' || m."id", NULL, 'EMPLOYEE_PERMISSIONS_CHANGED', 'SUCCESS', 'MIGRATION', 'migration',
       jsonb_build_object('targetEmployeeId', m."id", 'targetName', m."name", 'via', 'ROLE', 'roleId', m."roleId", 'roleName', m."roleName",
                          'reason', 'pipeline v2 (20261217090000_pipeline_v2): sales › deal_stage_move for «مدير عام»',
                          'changes', jsonb_build_array(jsonb_build_object('module', 'sales', 'sub', 'deal_stage_move', 'from', false, 'to', true))),
       now()
  FROM m
ON CONFLICT ("id") DO NOTHING;

-- 1d. Follow-up dates TYPED before v2 (the column was free then) become the deal's ONE keyed follow-up task
--     ('deal-follow-up:<deal>', due at that date, id 'dfu_'||md5(key)), so the first recompute from open activities
--     (follow-through.ts `syncDealNextFollowUp`) keeps the promise instead of erasing it. Only open deals with a date,
--     no keyed follow-up yet, and a date that is not the due date of one of their activities or workspace tasks (such a
--     date was derived from that row, not typed). Idempotent: the key, the deterministic id and ON CONFLICT.
INSERT INTO "Activity" ("id", "type", "subject", "opportunityId", "customerId", "dueAt", "ownerId", "sourceKey", "createdAt", "updatedAt")
SELECT 'dfu_' || md5('deal-follow-up:' || o."id"), 'TASK'::"ActivityType", 'متابعة الصفقة', o."id", o."customerId", o."nextFollowUpAt",
       o."ownerId", 'deal-follow-up:' || o."id", now(), now()
  FROM "Opportunity" o
 WHERE o."outcome" = 'OPEN' AND o."nextFollowUpAt" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "Activity" k WHERE k."sourceKey" = 'deal-follow-up:' || o."id")
   AND NOT EXISTS (SELECT 1 FROM "Activity" a WHERE a."opportunityId" = o."id" AND a."dueAt" = o."nextFollowUpAt")
   AND NOT EXISTS (SELECT 1 FROM "WorkTask" t WHERE t."opportunityId" = o."id" AND t."dueAt" = o."nextFollowUpAt")
ON CONFLICT DO NOTHING;

-- 2. History first: one event per deal that sits in the Negotiation stage (open or closed), outcomes NULL (a non-null
--    toOutcome would read as a second «رُبحت الصفقة»), no actor. Id 'pv2_<deal>'; after a rollback ('pv2r_<deal>…'
--    events) a re-apply writes its OWN event 'pv2_<deal>_<n>' (n = the rollbacks so far), so every move stays in the
--    history. A second run in the same cycle finds no deal in the stage and writes nothing.
INSERT INTO "OpportunityStageEvent" ("id", "opportunityId", "fromStageId", "toStageId", "fromOutcome", "toOutcome", "reason", "actorId", "createdAt")
SELECT 'pv2_' || o."id" || CASE WHEN rb.n > 0 THEN '_' || rb.n ELSE '' END, o."id", n."id", q."id", NULL, NULL,
       'Automatic: pipeline v2 — «التفاوض والاعتماد» merged into «عرض السعر والتفاوض»', NULL, now()
  FROM "Opportunity" o
  JOIN "PipelineStage" n ON n."id" = o."stageId" AND n."purpose" = 'NEGOTIATION'
 CROSS JOIN (SELECT "id" FROM "PipelineStage" WHERE "purpose" = 'QUOTATION') q
 CROSS JOIN LATERAL (
   SELECT count(*) AS n FROM "OpportunityStageEvent" r
    WHERE r."opportunityId" = o."id"
      AND (r."id" = 'pv2r_' || o."id" OR (starts_with(r."id", 'pv2r_' || o."id" || '_') AND substr(r."id", length(o."id") + 7) ~ '^[0-9]+$'))
 ) rb
ON CONFLICT ("id") DO NOTHING;

-- 3. Move the deals (open AND closed, so the retired row holds none). A no-op with no Quotation stage.
UPDATE "Opportunity" o SET "stageId" = q."id", "updatedAt" = now()
  FROM "PipelineStage" n, (SELECT "id" FROM "PipelineStage" WHERE "purpose" = 'QUOTATION') q
 WHERE n."id" = o."stageId" AND n."purpose" = 'NEGOTIATION';

-- 4. The retired stage's «إشعارات الحالات» rule is DISABLED, never deleted: inactive (the sender reads only active
--    rules), its recipients and text kept, so re-activating the stage brings it back exactly as it was. Done here so
--    no message can go out before the next sync. Same condition as step 5.
UPDATE "WhatsAppStatusRule" r SET "active" = false, "inactiveSince" = coalesce(r."inactiveSince", now()), "updatedAt" = now()
  FROM "PipelineStage" s
 WHERE r."source" = 'deal_stage' AND r."statusKey" = s."code" AND r."active"
   AND s."purpose" = 'NEGOTIATION'
   AND NOT EXISTS (SELECT 1 FROM "Opportunity" o WHERE o."stageId" = s."id" AND o."outcome" = 'OPEN');

-- 5. Retire Negotiation — only when nothing open is left in it (a deployment with no Quotation stage keeps it).
--    The row, its id and its code stay, so every historical event still resolves to «التفاوض والاعتماد».
UPDATE "PipelineStage" s SET "purpose" = NULL, "isActive" = false, "updatedAt" = now()
 WHERE s."purpose" = 'NEGOTIATION'
   AND NOT EXISTS (SELECT 1 FROM "Opportunity" o WHERE o."stageId" = s."id" AND o."outcome" = 'OPEN');

-- 6. Rename the merged stage (id, code, position and probability kept).
UPDATE "PipelineStage" SET "nameAr" = 'عرض السعر والتفاوض', "nameEn" = 'Quotation & negotiation', "updatedAt" = now()
 WHERE "purpose" = 'QUOTATION' AND ("nameAr" <> 'عرض السعر والتفاوض' OR "nameEn" <> 'Quotation & negotiation');

COMMIT;
