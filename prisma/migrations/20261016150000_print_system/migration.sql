-- G-20 / G-21 Universal Printing System (owner decisions A-1…A-8, B-1…B-10,
-- DECISIONS-2026-10-16, orchestration/2026-10-15 @ 1b1e2f16).
--
-- Additive only: four new tables, their indexes, CHECK constraints, one append-only trigger and
-- four read-only preset rows plus the settings singleton (job cap 200 labels). Nothing existing is altered, dropped, renamed, retyped or rewritten.
-- Rollback: erp/docs/print/print-system-rollback.sql (manual, with a backup, together with an older
-- application version; export PrintAuditLog first).

BEGIN;

-- CreateTable
CREATE TABLE "PrintProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "paperWidthMm" DOUBLE PRECISION NOT NULL,
    "paperHeightMm" DOUBLE PRECISION NOT NULL,
    "labelWidthMm" DOUBLE PRECISION NOT NULL,
    "labelHeightMm" DOUBLE PRECISION NOT NULL,
    "marginTopMm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marginLeftMm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marginRightMm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marginBottomMm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gapXMm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gapYMm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "columns" INTEGER NOT NULL DEFAULT 1,
    "rows" INTEGER NOT NULL DEFAULT 1,
    "orientation" TEXT NOT NULL DEFAULT 'PORTRAIT',
    "scalePct" INTEGER NOT NULL DEFAULT 100,
    "dpi" INTEGER NOT NULL DEFAULT 203,
    "offsetXMm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "offsetYMm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "defaultStartSlot" INTEGER NOT NULL DEFAULT 1,
    "defaultCopies" INTEGER NOT NULL DEFAULT 1,
    "isPreset" BOOLEAN NOT NULL DEFAULT false,
    "presetKey" TEXT,
    "ownerId" TEXT,
    "ownerName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintTemplatePreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "notesMaxLines" INTEGER,
    "showLogo" BOOLEAN NOT NULL DEFAULT true,
    "namedScorersConfirmedAt" TIMESTAMP(3),
    "namedScorersConfirmedById" TEXT,
    "profileId" TEXT,
    "ownerId" TEXT,
    "ownerName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintTemplatePreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "maxLabelsPerJob" INTEGER NOT NULL DEFAULT 200,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintAuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "templateKey" TEXT,
    "language" TEXT,
    "profileId" TEXT,
    "profileName" TEXT,
    "profile" JSONB,
    "items" JSONB,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "copiesTotal" INTEGER NOT NULL DEFAULT 0,
    "totalLabels" INTEGER NOT NULL DEFAULT 0,
    "totalPages" INTEGER NOT NULL DEFAULT 0,
    "startSlot" INTEGER,
    "warnings" JSONB,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrintAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrintProfile_presetKey_key" ON "PrintProfile"("presetKey");

-- CreateIndex
CREATE INDEX "PrintProfile_isPreset_idx" ON "PrintProfile"("isPreset");

-- CreateIndex
CREATE INDEX "PrintTemplatePreset_templateKey_idx" ON "PrintTemplatePreset"("templateKey");

-- CreateIndex
CREATE INDEX "PrintAuditLog_action_createdAt_idx" ON "PrintAuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "PrintAuditLog_actorId_createdAt_idx" ON "PrintAuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "PrintAuditLog_createdAt_idx" ON "PrintAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "PrintTemplatePreset" ADD CONSTRAINT "PrintTemplatePreset_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PrintProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Database rules (not expressible in the Prisma schema) ──────────────────────────────
-- The same ranges as src/lib/print/profiles.ts (PROFILE_LIMITS); the API validates first and
-- these are the backstop.

ALTER TABLE "PrintProfile"
  ADD CONSTRAINT "PrintProfile_name_len" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
  ADD CONSTRAINT "PrintProfile_kind_values" CHECK ("kind" IN ('A4_PLAIN', 'A4_SHEET', 'THERMAL_ROLL', 'CUSTOM')),
  ADD CONSTRAINT "PrintProfile_orientation_values" CHECK ("orientation" IN ('PORTRAIT', 'LANDSCAPE')),
  ADD CONSTRAINT "PrintProfile_paper_range" CHECK ("paperWidthMm" BETWEEN 20 AND 1000 AND "paperHeightMm" BETWEEN 20 AND 1000),
  ADD CONSTRAINT "PrintProfile_label_range" CHECK ("labelWidthMm" BETWEEN 10 AND 1000 AND "labelHeightMm" BETWEEN 10 AND 1000),
  ADD CONSTRAINT "PrintProfile_margin_range" CHECK ("marginTopMm" BETWEEN 0 AND 100 AND "marginLeftMm" BETWEEN 0 AND 100
    AND "marginRightMm" BETWEEN 0 AND 100 AND "marginBottomMm" BETWEEN 0 AND 100),
  ADD CONSTRAINT "PrintProfile_gap_range" CHECK ("gapXMm" BETWEEN 0 AND 50 AND "gapYMm" BETWEEN 0 AND 50),
  ADD CONSTRAINT "PrintProfile_grid_range" CHECK ("columns" BETWEEN 1 AND 20 AND "rows" BETWEEN 1 AND 50),
  ADD CONSTRAINT "PrintProfile_scale_range" CHECK ("scalePct" BETWEEN 50 AND 200),
  ADD CONSTRAINT "PrintProfile_dpi_range" CHECK ("dpi" BETWEEN 72 AND 1200),
  ADD CONSTRAINT "PrintProfile_offset_range" CHECK ("offsetXMm" BETWEEN -20 AND 20 AND "offsetYMm" BETWEEN -20 AND 20),
  ADD CONSTRAINT "PrintProfile_copies_range" CHECK ("defaultCopies" BETWEEN 1 AND 100),
  ADD CONSTRAINT "PrintProfile_start_slot_range" CHECK ("defaultStartSlot" BETWEEN 1 AND "columns" * "rows"),
  -- The label grid plus all four margins fits the paper as it is oriented (0.01 mm tolerance for
  -- decimal stock sizes): left + columns × label + gaps + right ≤ width, and the same vertically.
  ADD CONSTRAINT "PrintProfile_grid_fits_width" CHECK (
    "marginLeftMm" + "columns" * "labelWidthMm" + ("columns" - 1) * "gapXMm" + "marginRightMm"
      <= (CASE WHEN "orientation" = 'LANDSCAPE' THEN "paperHeightMm" ELSE "paperWidthMm" END) + 0.01),
  ADD CONSTRAINT "PrintProfile_grid_fits_height" CHECK (
    "marginTopMm" + "rows" * "labelHeightMm" + ("rows" - 1) * "gapYMm" + "marginBottomMm"
      <= (CASE WHEN "orientation" = 'LANDSCAPE' THEN "paperWidthMm" ELSE "paperHeightMm" END) + 0.01),
  ADD CONSTRAINT "PrintProfile_preset_key" CHECK (("isPreset" AND "presetKey" IS NOT NULL) OR (NOT "isPreset" AND "presetKey" IS NULL));

ALTER TABLE "PrintTemplatePreset"
  ADD CONSTRAINT "PrintTemplatePreset_name_len" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
  ADD CONSTRAINT "PrintTemplatePreset_template_values" CHECK ("templateKey" IN ('COFFEE_ORIGIN', 'CUPPING_RESULTS')),
  ADD CONSTRAINT "PrintTemplatePreset_language_values" CHECK ("language" IN ('AR', 'EN', 'BI')),
  ADD CONSTRAINT "PrintTemplatePreset_fields_array" CHECK (jsonb_typeof("fields") = 'array'),
  ADD CONSTRAINT "PrintTemplatePreset_notes_lines" CHECK ("notesMaxLines" IS NULL OR "notesMaxLines" BETWEEN 1 AND 6),
  -- Owner decision 2.1: a privacy confirmation is recorded with who confirmed it, and only on a
  -- Cupping Results preset.
  ADD CONSTRAINT "PrintTemplatePreset_named_scorers" CHECK (
    ("namedScorersConfirmedAt" IS NULL AND "namedScorersConfirmedById" IS NULL)
    OR ("namedScorersConfirmedAt" IS NOT NULL AND "namedScorersConfirmedById" IS NOT NULL AND "templateKey" = 'CUPPING_RESULTS'));

ALTER TABLE "PrintAuditLog"
  ADD CONSTRAINT "PrintAuditLog_action_values" CHECK ("action" IN ('PRINT_JOB', 'PREVIEW_NAMED', 'PROFILE_CREATED', 'PROFILE_UPDATED', 'PROFILE_DELETED', 'PRESET_CREATED', 'PRESET_UPDATED', 'PRESET_DELETED', 'SETTINGS_UPDATED')),
  ADD CONSTRAINT "PrintAuditLog_counts_range" CHECK (
    "itemCount" BETWEEN 0 AND 500 AND "copiesTotal" BETWEEN 0 AND 2000
    AND "totalLabels" BETWEEN 0 AND 2000 AND "totalPages" BETWEEN 0 AND 250),
  ADD CONSTRAINT "PrintAuditLog_start_slot_range" CHECK ("startSlot" IS NULL OR "startSlot" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "PrintAuditLog_job_shape" CHECK ("action" NOT IN ('PRINT_JOB', 'PREVIEW_NAMED') OR ("templateKey" IS NOT NULL AND "items" IS NOT NULL AND jsonb_typeof("items") = 'array'));

ALTER TABLE "PrintSettings"
  ADD CONSTRAINT "PrintSettings_singleton" CHECK ("id" = 'singleton'),
  ADD CONSTRAINT "PrintSettings_max_labels_range" CHECK ("maxLabelsPerJob" BETWEEN 1 AND 2000);

INSERT INTO "PrintSettings" ("id", "maxLabelsPerJob", "updatedAt") VALUES ('singleton', 200, now());

-- Append-only audit: no UPDATE, no DELETE, no TRUNCATE (as CuppingAuditLog).
CREATE FUNCTION "PrintAuditLog_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PrintAuditLog is append-only (% refused)', TG_OP USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PrintAuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "PrintAuditLog"
  FOR EACH ROW EXECUTE FUNCTION "PrintAuditLog_append_only_fn"();

CREATE TRIGGER "PrintAuditLog_no_truncate"
  BEFORE TRUNCATE ON "PrintAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "PrintAuditLog_append_only_fn"();

-- ── Presets (A-3: starting points only; the API refuses to change or delete them) ─────────
-- Geometry from the design's stock assumptions (G20-G21-PRINT.md §2, P2-1); DPI is a declared
-- capability, never detected (A-1).
INSERT INTO "PrintProfile" ("id", "name", "kind", "paperWidthMm", "paperHeightMm", "labelWidthMm", "labelHeightMm",
  "marginTopMm", "marginLeftMm", "marginRightMm", "marginBottomMm", "gapXMm", "gapYMm", "columns", "rows", "orientation", "scalePct", "dpi",
  "offsetXMm", "offsetYMm", "defaultStartSlot", "defaultCopies", "isPreset", "presetKey", "createdAt", "updatedAt")
VALUES
  ('print_preset_a4_plain',  'A4 plain',                         'A4_PLAIN',     210, 297, 190,  277,  10,   10,   10,   10,   0,   0, 1, 1, 'PORTRAIT', 100, 300, 0, 0, 1, 1, true, 'A4_PLAIN',       now(), now()),
  ('print_preset_a4_l7165',  'A4 label sheet · 8',                  'A4_SHEET',  210, 297, 99.1, 67.7, 13.1, 4.65, 4.65, 13.1, 2.5, 0, 2, 4, 'PORTRAIT', 100, 300, 0, 0, 1, 1, true, 'A4_L7165',       now(), now()),
  ('print_preset_thermal',   'Thermal roll 100 × 70',            'THERMAL_ROLL', 100, 70,  100,  70,   0,    0,    0,    0,    0,   3, 1, 1, 'PORTRAIT', 100, 203, 0, 0, 1, 1, true, 'THERMAL_100x70', now(), now()),
  ('print_preset_compact',   'Thermal roll 50 × 30',             'THERMAL_ROLL', 50,  30,  50,   30,   0,    0,    0,    0,    0,   3, 1, 1, 'PORTRAIT', 100, 203, 0, 0, 1, 1, true, 'COMPACT_50x30',  now(), now());

COMMIT;
