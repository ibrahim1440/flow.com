-- 20261231150000_quote_draft_key — Abu Fahd R3 (14 Nov 2026): one editor session creates ONE draft quotation.
-- The quotation editor creates its draft at the first save (an autosave, «حفظ», or the save sent while leaving the page). Two
-- of those could race (Back right after the first line: the autosave and the leave-save, 1–6 ms apart) and each created a
-- quotation — two «النسخة 1» on one deal. The editor now sends one key per editor session with every create; the server
-- returns the draft already created with that key instead of a second one.
--   "Quote"."draftKey": the editor session's key (client-generated, 16–64 chars [A-Za-z0-9_-]); NULL for every quotation
--   created otherwise (API without a key, revisions, the accounting path before this release). UNIQUE: the database itself
--   refuses a second quotation with the same key, whatever the application does.
-- Additive: one nullable column and its unique index. No existing row is read or written.
BEGIN;

ALTER TABLE "Quote" ADD COLUMN "draftKey" TEXT;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_draftKey_check" CHECK ("draftKey" IS NULL OR "draftKey" ~ '^[A-Za-z0-9_-]{16,64}$');
CREATE UNIQUE INDEX "Quote_draftKey_key" ON "Quote"("draftKey");

-- Where the runtime role holds column-level (not table-level) rights on "Quote", give it the new column too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcom_app')
     AND EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_name = 'Quote' AND grantee = 'flowcom_app' AND privilege_type = 'INSERT')
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_name = 'Quote' AND grantee = 'flowcom_app' AND privilege_type = 'INSERT') THEN
    GRANT SELECT ("draftKey"), INSERT ("draftKey") ON "Quote" TO flowcom_app;
  END IF;
END $$;

COMMIT;
