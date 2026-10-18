-- E6 cupping close policy (owner decisions C-1…C-5, DECISIONS-2026-10-16 second set).
--
-- Additive only: three nullable-or-defaulted additions, no rewrite of existing rows.
--   • CuppingSession gains the closure record. Every existing row keeps closeKind = NULL,
--     including sessions that are already Closed: they are not reclassified (C-4).
--   • CuppingSettings: the administrator-configurable minimum of distinct staff scorers,
--     2–20, default 2 (C-5). One row, created here with the default.
--   • CuppingAuditLog: append-only history of closures and settings changes (C-1).
-- Nothing is dropped, renamed, retyped or deleted. Rollback: see erp/docs/ops/CUPPING-CLOSE-POLICY.md.
-- One transaction: a failure part-way leaves no partial schema behind.

BEGIN;

-- AlterTable
ALTER TABLE "CuppingSession" ADD COLUMN     "closeKind" TEXT,
ADD COLUMN     "closeReason" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedById" TEXT,
ADD COLUMN     "closedByName" TEXT,
ADD COLUMN     "minScorersAtClose" INTEGER,
ADD COLUMN     "scorersAtClose" INTEGER;

-- CreateTable
CREATE TABLE "CuppingSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "minScorers" INTEGER NOT NULL DEFAULT 2,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CuppingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuppingAuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CuppingAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CuppingAuditLog_entityType_entityId_idx" ON "CuppingAuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "CuppingAuditLog_createdAt_idx" ON "CuppingAuditLog"("createdAt");

-- ── Database rules (not expressible in the Prisma schema) ──────────────────────────────

-- True when the text holds at least one visible character. Not visible: whitespace (any
-- Unicode space, tab, newline, U+0085) and every Default_Ignorable_Code_Point (Unicode 15:
-- U+00AD, U+034F, U+061C, U+115F–U+1160, U+17B4–U+17B5, U+180B–U+180F, U+200B–U+200F,
-- U+202A–U+202E, U+2060–U+206F, U+3164, U+FE00–U+FE0F, U+FEFF, U+FFA0, U+FFF0–U+FFF8,
-- U+1BCA0–U+1BCA3, U+1D173–U+1D17A, U+E0000–U+E0FFF), plus the blank-looking U+2800.
-- The API strips a superset (\s, \p{Cf}, \p{Default_Ignorable_Code_Point}, U+0085, the
-- Hangul fillers, U+2800), so whatever it accepts also passes here.
-- Every function below pins its search_path, so it also works where the caller's path is empty
-- (pg_restore, pg_dump).
CREATE OR REPLACE FUNCTION cupping_has_visible_text(t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT t IS NOT NULL AND regexp_replace(
    t,
    '[[:space:]\u0085\u00A0\u00AD\u034F\u061C\u115F\u1160\u1680\u17B4\u17B5\u180B-\u180F\u2000-\u200F\u2028-\u202F\u205F-\u206F\u2800\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E0FFF]',
    '', 'g') <> '';
$$;

-- The closure record is coherent. Existing rows (closeKind NULL) satisfy every check.
ALTER TABLE "CuppingSession"
  ADD CONSTRAINT "CuppingSession_closeKind_values"
    CHECK ("closeKind" IS NULL OR "closeKind" IN ('COMPLETE', 'INCOMPLETE')),
  ADD CONSTRAINT "CuppingSession_closeKind_closed"
    CHECK ("closeKind" IS NULL OR ("status" = 'Closed' AND "closedAt" IS NOT NULL
      AND "minScorersAtClose" IS NOT NULL AND "scorersAtClose" IS NOT NULL)),
  ADD CONSTRAINT "CuppingSession_complete_meets_minimum"
    CHECK ("closeKind" IS DISTINCT FROM 'COMPLETE' OR "scorersAtClose" >= "minScorersAtClose"),
  ADD CONSTRAINT "CuppingSession_incomplete_below_minimum_with_reason"
    CHECK ("closeKind" IS DISTINCT FROM 'INCOMPLETE'
      OR ("scorersAtClose" < "minScorersAtClose" AND cupping_has_visible_text("closeReason")));

-- Complete staff scorers of a session (owner decision 3, 16 Oct 2026): distinct authenticated
-- staff (employeeId) with an evaluation of EVERY required cup — each CuppingSessionBatch of a
-- multi-cup session, or the one cup-less evaluation of a single-cup session. Partial scorers
-- and guests (employeeId NULL) do not count. The application uses the same definition.
CREATE OR REPLACE FUNCTION cupping_complete_scorers(sid text) RETURNS integer
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  WITH req AS (
    SELECT count(*)::int AS n FROM public."CuppingSessionBatch" WHERE "sessionId" = sid
  ), per AS (
    SELECT s."employeeId",
           count(DISTINCT s."sessionBatchId") FILTER (
             WHERE s."sessionBatchId" IN (SELECT b."id" FROM public."CuppingSessionBatch" b WHERE b."sessionId" = sid)
           ) AS cups,
           bool_or(s."sessionBatchId" IS NULL) AS cupless
    FROM public."CuppingScore" s
    WHERE s."sessionId" = sid AND s."employeeId" IS NOT NULL
    GROUP BY s."employeeId"
  )
  SELECT count(*)::int FROM per, req
  WHERE (req.n = 0 AND per.cupless) OR (req.n > 0 AND per.cups = req.n);
$$;

-- A recorded closure is final: the session cannot be reopened and the record cannot be
-- rewritten. Deleting a session (an administrator action that already existed) is unaffected.
-- When a closure is recorded — by an UPDATE (the application's close) or by a raw INSERT of an
-- already-closed row — its scorersAtClose must be the complete-scorer count at that moment, so
-- the CHECKs above (COMPLETE ⇒ ≥ minimum, INCOMPLETE ⇒ < minimum) judge the real figure, not a
-- supplied one. A full pg_restore creates this trigger after loading the data, so restores are
-- unaffected; a data-only restore uses --disable-triggers (see CUPPING-CLOSE-POLICY.md).
CREATE OR REPLACE FUNCTION cupping_closure_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."closeKind" IS NOT NULL
       AND NEW."scorersAtClose" IS DISTINCT FROM public.cupping_complete_scorers(NEW."id") THEN
      RAISE EXCEPTION 'Cupping: scorersAtClose (%) is not the number of complete staff scorers (%)',
        NEW."scorersAtClose", public.cupping_complete_scorers(NEW."id")
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- No session is ever reopened or re-statused once closed, including sessions closed before
  -- this policy (closeKind NULL) and a stray lowercase 'closed'; no application flow does it.
  IF lower(OLD."status") = 'closed' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Cupping: a closed session cannot be reopened'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."closeKind" IS NULL AND NEW."closeKind" IS NOT NULL
     AND NEW."scorersAtClose" IS DISTINCT FROM public.cupping_complete_scorers(NEW."id") THEN
    RAISE EXCEPTION 'Cupping: scorersAtClose (%) is not the number of complete staff scorers (%)',
      NEW."scorersAtClose", public.cupping_complete_scorers(NEW."id")
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."closeKind" IS NOT NULL AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."closeKind" IS DISTINCT FROM OLD."closeKind"
    OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt"
    OR NEW."closedById" IS DISTINCT FROM OLD."closedById"
    OR NEW."closedByName" IS DISTINCT FROM OLD."closedByName"
    OR NEW."closeReason" IS DISTINCT FROM OLD."closeReason"
    OR NEW."minScorersAtClose" IS DISTINCT FROM OLD."minScorersAtClose"
    OR NEW."scorersAtClose" IS DISTINCT FROM OLD."scorersAtClose") THEN
    RAISE EXCEPTION 'Cupping: a recorded session closure cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CuppingSession_closure_final" BEFORE INSERT OR UPDATE ON "CuppingSession"
  FOR EACH ROW EXECUTE FUNCTION cupping_closure_guard();

-- New evaluations only for an open session. INSERT only: existing rows of closed sessions are
-- untouched, and their updates (e.g. employeeId set to NULL when an employee is deleted) still
-- work.
CREATE OR REPLACE FUNCTION cupping_score_open_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."CuppingSession" WHERE "id" = NEW."sessionId" AND "status" = 'Open') THEN
    RAISE EXCEPTION 'Cupping: scores can only be added to an open session'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CuppingScore_open_session_only" BEFORE INSERT ON "CuppingScore"
  FOR EACH ROW EXECUTE FUNCTION cupping_score_open_only();

-- One settings row, minimum 2–20.
ALTER TABLE "CuppingSettings"
  ADD CONSTRAINT "CuppingSettings_singleton" CHECK ("id" = 'singleton'),
  ADD CONSTRAINT "CuppingSettings_minScorers_range" CHECK ("minScorers" BETWEEN 2 AND 20);
INSERT INTO "CuppingSettings" ("id", "minScorers", "updatedAt")
  VALUES ('singleton', 2, CURRENT_TIMESTAMP)
  ON CONFLICT ("id") DO NOTHING;
-- The policy row is changed, never removed (a missing row would silently fall back to defaults).
CREATE OR REPLACE FUNCTION cupping_settings_no_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Cupping: the settings row cannot be deleted; change minScorers instead'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "CuppingSettings_no_delete" BEFORE DELETE ON "CuppingSettings"
  FOR EACH ROW EXECUTE FUNCTION cupping_settings_no_delete();
CREATE TRIGGER "CuppingSettings_no_truncate" BEFORE TRUNCATE ON "CuppingSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION cupping_settings_no_delete();

-- Append-only audit history.
CREATE OR REPLACE FUNCTION cupping_audit_forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Cupping: % on % is not allowed (append-only record)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "CuppingAuditLog_append_only" BEFORE UPDATE OR DELETE ON "CuppingAuditLog"
  FOR EACH ROW EXECUTE FUNCTION cupping_audit_forbid_mutation();
CREATE TRIGGER "CuppingAuditLog_no_truncate" BEFORE TRUNCATE ON "CuppingAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION cupping_audit_forbid_mutation();

COMMIT;
