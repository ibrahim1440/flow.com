-- «ملفي الشخصي» (own profile, Figma TD-11 «أجهزتي» / UR-02d «الأجهزة والجلسات»): each session
-- records the browser it was opened from, so the signed-in user's own page can list their devices
-- (sessions grouped by browser) and mark «هذا الجهاز». The value is an opaque random identifier
-- kept in an httpOnly first-party cookie (hq_device); it is not a credential and proves nothing.
-- ADDITIVE ONLY: one nullable column and one CHECK that every existing row satisfies (NULL).
-- NULL = not recorded (a session from before this migration): grouped by its user agent instead.
-- Atomic: the whole file runs in one transaction. ADD COLUMN without a default is metadata-only;
-- the CHECK validates against NULLs only (ACCESS EXCLUSIVE on "AuthSession" for that instant).
BEGIN;

ALTER TABLE "AuthSession" ADD COLUMN "deviceId" TEXT;
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_deviceId_check" CHECK ("deviceId" IS NULL OR "deviceId" ~ '^[A-Za-z0-9_-]{16,64}$');

COMMIT;
