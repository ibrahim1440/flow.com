-- «التفويض الدائم» — StandingAuthorisation (batch 22 WP-A; council ruling 2, FOLLOWUPS.md, BATCH22-DESIGN §2 WP-A).
-- ADDITIVE ONLY, one transaction (PostgreSQL 16 / 17). Who authorised the scheduler to post a register's entries
-- without a person running them, recorded once, in one generic table:
--
--   1. "StandingAuthorisation": the register (RECURRING_AUTOPOST — one recurring JOURNAL, scopeId = the schedule;
--      DEFERRAL_RECOGNITION / DEPRECIATION — register-wide, scopeId NULL), who authorised it and when, whether it was a
--      self-authorisation the SoD setting allowed (sodBypass, listed in «استثناءات فصل المهام»), and its revocation
--      (who, when, why — a person, an edit / cancel of the schedule, or the runner when the authoriser's rights lapsed:
--      revokeReason 'RIGHTS_LAPSED: …'). ONE LIVE ROW per (register, scope): partial UNIQUE index WHERE revokedAt IS NULL.
--      Never deleted, never re-opened: a revoked row is final, a new grant is a new row (standing_auth_guard). Audited
--      (ledger_audit_row) and not truncated (ledger_no_truncate).
--   2. RecurringSchedule.autoPost / autoPostApprovedBy / autoPostApprovedAt / autoPostSodBypass become a READ-ONLY MIRROR of
--      the schedule's live RECURRING_AUTOPOST row for one release (they are dropped in a later batch): the database
--      writes them (standing_auth_mirror, AFTER INSERT / UPDATE of an authorisation) and refuses any other write
--      (recurring_autopost_mirror_guard: only from inside the mirror trigger, pg_trigger_depth() > 1). The existing rows
--      are copied: a live authorisation for each schedule with auto-post on; a REVOKED, historical row for a schedule
--      whose auto-post ended but kept its authoriser (a cancelled schedule) — its mirror is then cleared.
--   3. Each run records the authorisation it ran under: RecurringRun / DeferralRun / FixedAssetDepreciationRun
--      ."standingAuthorisationId" (nullable FK, RESTRICT). A recurring run's snapshot carries it (frozen like the rest of
--      the snapshot); a run made by the scheduler for the register-wide runs carries it; a run a person made carries none.
--      standing_auth_run_link: the link names an authorisation of the run's register (and, for a recurring run, its
--      schedule and its snapshot's authoriser; for the others the run's createdBy), LIVE when the run is first written,
--      and never changes. The recurring runs that already carry an authoriser are linked to the copied rows (a row is
--      reconstructed, REVOKED, from the run snapshots when its authorisation was withdrawn before this release).
--   4. The runtime role (flowcom_app), when it exists, is granted the table and the functions.
-- Rollback: docs/hr/migration-review/rollback-20261124090000_standing_authorisation.sql.
BEGIN;

SELECT set_config('hiqbah.actor_id', 'migration', true), set_config('hiqbah.audit_reason', '20261124090000_standing_authorisation', true);

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "StandingAuthorisation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'hiqbah',
  "register" TEXT NOT NULL,
  "scopeId" TEXT,
  "authorisedBy" TEXT NOT NULL,
  "authorisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sodBypass" BOOLEAN NOT NULL DEFAULT false,
  "revokedAt" TIMESTAMP(3),
  "revokedBy" TEXT,
  "revokeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StandingAuthorisation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StandingAuthorisation_register_check" CHECK ("register" IN ('RECURRING_AUTOPOST', 'DEFERRAL_RECOGNITION', 'DEPRECIATION')
    AND (("register" = 'RECURRING_AUTOPOST') = ("scopeId" IS NOT NULL))),
  CONSTRAINT "StandingAuthorisation_revoke_check" CHECK ((("revokedAt" IS NULL) = ("revokedBy" IS NULL)) AND (("revokedAt" IS NULL) = ("revokeReason" IS NULL))
    AND ("revokeReason" IS NULL OR length(btrim("revokeReason")) BETWEEN 3 AND 500) AND ("revokedAt" IS NULL OR "revokedAt" >= "authorisedAt")
    AND length(btrim("authorisedBy")) >= 1)
);
-- ONE LIVE ROW per (register, scope).
CREATE UNIQUE INDEX "StandingAuthorisation_live_key" ON "StandingAuthorisation"("register", coalesce("scopeId", '')) WHERE "revokedAt" IS NULL;
CREATE INDEX "StandingAuthorisation_register_scopeId_idx" ON "StandingAuthorisation"("register", "scopeId");
CREATE INDEX "StandingAuthorisation_authorisedBy_idx" ON "StandingAuthorisation"("authorisedBy");

-- An authorisation is granted live, revoked once (with who and why), and otherwise never changes nor is deleted. A
-- RECURRING_AUTOPOST names a recurring JOURNAL that is neither completed nor cancelled.
CREATE OR REPLACE FUNCTION standing_auth_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; st text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'STANDING_AUTH_KEPT: a standing authorisation is never deleted (revoke it)' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'STANDING_AUTH_FINAL: an authorisation is granted live (a revocation is recorded on it afterwards)' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."register" = 'RECURRING_AUTOPOST' THEN
      SELECT s."kind", s."status" INTO k, st FROM "RecurringSchedule" s WHERE s."id" = NEW."scopeId";
      IF NOT FOUND OR k <> 'JOURNAL' OR st IN ('COMPLETED', 'CANCELLED') THEN
        RAISE EXCEPTION 'STANDING_AUTH_SCOPE: auto-post is authorised on a recurring journal that is neither completed nor cancelled' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'STANDING_AUTH_FINAL: a revoked authorisation is final (grant a new one)' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."tenantId" <> OLD."tenantId" OR NEW."register" <> OLD."register" OR NEW."scopeId" IS DISTINCT FROM OLD."scopeId"
     OR NEW."authorisedBy" <> OLD."authorisedBy" OR NEW."authorisedAt" <> OLD."authorisedAt" OR NEW."sodBypass" <> OLD."sodBypass" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'STANDING_AUTH_FINAL: an authorisation never changes; it is only revoked, once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER standing_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON "StandingAuthorisation" FOR EACH ROW EXECUTE FUNCTION standing_auth_guard();

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
-- Historical rows FIRST (before the guard exists): a schedule whose auto-post ended but whose authoriser stayed on the
-- row (a cancelled schedule kept autoPostApprovedBy / At): the authorisation is recorded as REVOKED, then the mirror cleared.
ALTER TABLE "StandingAuthorisation" DISABLE TRIGGER standing_auth_guard;
INSERT INTO "StandingAuthorisation" ("id", "register", "scopeId", "authorisedBy", "authorisedAt", "sodBypass", "revokedAt", "revokedBy", "revokeReason", "createdAt", "updatedAt")
SELECT 'sa_' || replace(gen_random_uuid()::text, '-', ''), 'RECURRING_AUTOPOST', s."id", s."autoPostApprovedBy", s."autoPostApprovedAt", false,
       greatest(s."updatedAt", s."autoPostApprovedAt"), 'migration', 'MIGRATED: auto-post ended before this release (schedule ' || s."status" || ')', now(), now()
FROM "RecurringSchedule" s
WHERE NOT s."autoPost" AND s."autoPostApprovedBy" IS NOT NULL AND s."autoPostApprovedAt" IS NOT NULL;
-- The live authorisations: each schedule with auto-post on.
INSERT INTO "StandingAuthorisation" ("id", "register", "scopeId", "authorisedBy", "authorisedAt", "sodBypass", "createdAt", "updatedAt")
SELECT 'sa_' || replace(gen_random_uuid()::text, '-', ''), 'RECURRING_AUTOPOST', s."id", s."autoPostApprovedBy", s."autoPostApprovedAt", s."autoPostSodBypass", now(), now()
FROM "RecurringSchedule" s
WHERE s."autoPost" AND s."autoPostApprovedBy" IS NOT NULL AND s."autoPostApprovedAt" IS NOT NULL;
-- A run snapshot whose authorisation is not on its schedule any more (withdrawn before this release): reconstructed,
-- REVOKED, one per (schedule, authoriser, self-authorisation), from the runs themselves.
INSERT INTO "StandingAuthorisation" ("id", "register", "scopeId", "authorisedBy", "authorisedAt", "sodBypass", "revokedAt", "revokedBy", "revokeReason", "createdAt", "updatedAt")
SELECT 'sa_' || replace(gen_random_uuid()::text, '-', ''), 'RECURRING_AUTOPOST', r."scheduleId", r."autoPostBy", min(r."createdAt"), bool_or(r."autoPostSodBypass"),
       greatest(max(r."updatedAt"), min(r."createdAt")), 'migration', 'MIGRATED: reconstructed from the run snapshots (auto-post withdrawn before this release)', now(), now()
FROM "RecurringRun" r
WHERE r."autoPostBy" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "StandingAuthorisation" a WHERE a."scopeId" = r."scheduleId" AND a."authorisedBy" = r."autoPostBy")
GROUP BY r."scheduleId", r."autoPostBy";
ALTER TABLE "StandingAuthorisation" ENABLE TRIGGER standing_auth_guard;
UPDATE "RecurringSchedule" SET "autoPostApprovedBy" = NULL, "autoPostApprovedAt" = NULL, "autoPostSodBypass" = false
WHERE NOT "autoPost" AND ("autoPostApprovedBy" IS NOT NULL OR "autoPostApprovedAt" IS NOT NULL OR "autoPostSodBypass");

-- The mirror: the database writes the four columns from the live authorisation; nothing else may.
CREATE OR REPLACE FUNCTION standing_auth_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE live RECORD;
BEGIN
  IF NEW."register" <> 'RECURRING_AUTOPOST' THEN
    RETURN NULL;
  END IF;
  SELECT a."authorisedBy", a."authorisedAt", a."sodBypass" INTO live FROM "StandingAuthorisation" a
   WHERE a."register" = 'RECURRING_AUTOPOST' AND a."scopeId" = NEW."scopeId" AND a."revokedAt" IS NULL;
  IF FOUND THEN
    UPDATE "RecurringSchedule" SET "autoPost" = true, "autoPostApprovedBy" = live."authorisedBy", "autoPostApprovedAt" = live."authorisedAt", "autoPostSodBypass" = live."sodBypass"
     WHERE "id" = NEW."scopeId";
  ELSE
    UPDATE "RecurringSchedule" SET "autoPost" = false, "autoPostApprovedBy" = NULL, "autoPostApprovedAt" = NULL, "autoPostSodBypass" = false
     WHERE "id" = NEW."scopeId" AND ("autoPost" OR "autoPostApprovedBy" IS NOT NULL OR "autoPostApprovedAt" IS NOT NULL OR "autoPostSodBypass");
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER standing_auth_mirror AFTER INSERT OR UPDATE ON "StandingAuthorisation" FOR EACH ROW EXECUTE FUNCTION standing_auth_mirror();

CREATE OR REPLACE FUNCTION recurring_autopost_mirror_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW; -- written by standing_auth_mirror
  END IF;
  IF (TG_OP = 'INSERT' AND (NEW."autoPost" OR NEW."autoPostApprovedBy" IS NOT NULL OR NEW."autoPostApprovedAt" IS NOT NULL OR NEW."autoPostSodBypass"))
     OR (TG_OP = 'UPDATE' AND (NEW."autoPost" IS DISTINCT FROM OLD."autoPost" OR NEW."autoPostApprovedBy" IS DISTINCT FROM OLD."autoPostApprovedBy"
         OR NEW."autoPostApprovedAt" IS DISTINCT FROM OLD."autoPostApprovedAt" OR NEW."autoPostSodBypass" IS DISTINCT FROM OLD."autoPostSodBypass")) THEN
    RAISE EXCEPTION 'STANDING_AUTH_MIRROR: auto-post is read from "StandingAuthorisation" (grant or revoke it there); these columns are its read-only copy' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recurring_autopost_mirror_guard BEFORE INSERT OR UPDATE ON "RecurringSchedule" FOR EACH ROW EXECUTE FUNCTION recurring_autopost_mirror_guard();

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "RecurringRun" ADD COLUMN "standingAuthorisationId" TEXT;
ALTER TABLE "DeferralRun" ADD COLUMN "standingAuthorisationId" TEXT;
ALTER TABLE "FixedAssetDepreciationRun" ADD COLUMN "standingAuthorisationId" TEXT;

-- The recurring runs that carry an authoriser: linked to their schedule's row of that authoriser (the latest granted
-- on / before the run, else the earliest). The run guard refuses any change of a final run, so it is set aside for this
-- one statement (the snapshot columns do not change).
ALTER TABLE "RecurringRun" DISABLE TRIGGER recurring_run_guard;
UPDATE "RecurringRun" r SET "standingAuthorisationId" = (
  SELECT a."id" FROM "StandingAuthorisation" a
   WHERE a."register" = 'RECURRING_AUTOPOST' AND a."scopeId" = r."scheduleId" AND a."authorisedBy" = r."autoPostBy"
   ORDER BY (a."authorisedAt" <= r."createdAt") DESC, CASE WHEN a."authorisedAt" <= r."createdAt" THEN a."authorisedAt" END DESC NULLS LAST, a."authorisedAt" ASC
   LIMIT 1)
WHERE r."autoPostBy" IS NOT NULL;
ALTER TABLE "RecurringRun" ENABLE TRIGGER recurring_run_guard;

ALTER TABLE "RecurringRun" ADD CONSTRAINT "RecurringRun_standing_check" CHECK (("autoPostBy" IS NULL) = ("standingAuthorisationId" IS NULL));
CREATE INDEX "RecurringRun_standingAuthorisationId_idx" ON "RecurringRun"("standingAuthorisationId");
CREATE INDEX "DeferralRun_standingAuthorisationId_idx" ON "DeferralRun"("standingAuthorisationId");
CREATE INDEX "FixedAssetDepreciationRun_standingAuthorisationId_idx" ON "FixedAssetDepreciationRun"("standingAuthorisationId");
ALTER TABLE "RecurringRun" ADD CONSTRAINT "RecurringRun_standingAuthorisationId_fkey" FOREIGN KEY ("standingAuthorisationId") REFERENCES "StandingAuthorisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeferralRun" ADD CONSTRAINT "DeferralRun_standingAuthorisationId_fkey" FOREIGN KEY ("standingAuthorisationId") REFERENCES "StandingAuthorisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FixedAssetDepreciationRun" ADD CONSTRAINT "FixedAssetDepreciationRun_standingAuthorisationId_fkey" FOREIGN KEY ("standingAuthorisationId") REFERENCES "StandingAuthorisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The link names an authorisation of the run's register (a recurring run: its schedule and its snapshot's authoriser;
-- the others: the run's createdBy, the name the scheduler posted under), LIVE when the run is first written (a recurring
-- run: when its snapshot auto-posts), and never changes. Fields are read through to_jsonb (each table has its own).
CREATE OR REPLACE FUNCTION standing_auth_run_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n jsonb := to_jsonb(NEW); sid text := to_jsonb(NEW)->>'standingAuthorisationId'; a RECORD; reg text; who text;
BEGIN
  IF TG_OP = 'UPDATE' AND sid IS DISTINCT FROM (to_jsonb(OLD)->>'standingAuthorisationId') THEN
    RAISE EXCEPTION 'STANDING_AUTH_RUN: the authorisation a run was made under never changes' USING ERRCODE = 'P0001';
  END IF;
  IF sid IS NULL THEN
    RETURN NEW;
  END IF;
  reg := CASE TG_TABLE_NAME WHEN 'RecurringRun' THEN 'RECURRING_AUTOPOST' WHEN 'DeferralRun' THEN 'DEFERRAL_RECOGNITION' ELSE 'DEPRECIATION' END;
  who := CASE WHEN TG_TABLE_NAME = 'RecurringRun' THEN n->>'autoPostBy' ELSE n->>'createdBy' END;
  SELECT x."register", x."scopeId", x."authorisedBy", x."revokedAt" INTO a FROM "StandingAuthorisation" x WHERE x."id" = sid;
  IF NOT FOUND OR a."register" <> reg OR a."authorisedBy" IS DISTINCT FROM who
     OR (TG_TABLE_NAME = 'RecurringRun' AND a."scopeId" IS DISTINCT FROM n->>'scheduleId') THEN
    RAISE EXCEPTION 'STANDING_AUTH_RUN: the run names an authorisation of another register, schedule or authoriser' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' AND a."revokedAt" IS NOT NULL AND (TG_TABLE_NAME <> 'RecurringRun' OR (n->>'autoPost')::boolean) THEN
    RAISE EXCEPTION 'STANDING_AUTH_RUN: a run is made under a LIVE authorisation' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER standing_auth_run_link BEFORE INSERT OR UPDATE ON "RecurringRun" FOR EACH ROW EXECUTE FUNCTION standing_auth_run_link();
CREATE TRIGGER standing_auth_run_link BEFORE INSERT OR UPDATE ON "DeferralRun" FOR EACH ROW EXECUTE FUNCTION standing_auth_run_link();
CREATE TRIGGER standing_auth_run_link BEFORE INSERT OR UPDATE ON "FixedAssetDepreciationRun" FOR EACH ROW EXECUTE FUNCTION standing_auth_run_link();

-- The audit trail; never truncated.
CREATE TRIGGER ledger_audit_row AFTER INSERT OR UPDATE OR DELETE ON "StandingAuthorisation" FOR EACH ROW EXECUTE FUNCTION ledger_audit_row();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "StandingAuthorisation" FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "StandingAuthorisation" TO flowcom_app;
    GRANT EXECUTE ON FUNCTION standing_auth_guard(), standing_auth_mirror(), recurring_autopost_mirror_guard(), standing_auth_run_link() TO flowcom_app;
  END IF;
END $$;

COMMIT;
