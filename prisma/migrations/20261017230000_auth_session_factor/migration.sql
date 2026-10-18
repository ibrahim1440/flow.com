-- Owner decision 4 (17 Oct), inventory permissions: a privileged stock change needs the session to
-- have signed in with username + PIN AND its last step-up to have been made with the PIN. The
-- session records which secret its last strong authentication used (sign-in or step-up).
-- ADDITIVE ONLY: one nullable column and one CHECK that every existing row satisfies (NULL).
-- NULL = not recorded (a session from before this migration): treated as "not the PIN", so a
-- privileged stock change asks for a PIN step-up first. Nothing else reads it.
-- Atomic: the whole file runs in one transaction. ADD COLUMN without a default is metadata-only;
-- the CHECK validates against NULLs only (ACCESS EXCLUSIVE on "AuthSession" for that instant).
BEGIN;

ALTER TABLE "AuthSession" ADD COLUMN "authFactor" TEXT;
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_authFactor_check" CHECK ("authFactor" IS NULL OR "authFactor" IN ('PIN', 'PASSWORD'));

COMMIT;
