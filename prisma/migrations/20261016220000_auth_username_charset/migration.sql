-- Re-test follow-up 2 (independent re-test of e297e1cf): no look-alike usernames. After the
-- locale-independent normal form (auth_norm_username, 20261016200000) a username is 3–64
-- characters of [a-z0-9._-] only, so two logins can never differ by a Cyrillic, Greek or other
-- look-alike letter, a combining mark, or an invisible character. The application refuses the
-- same (usernameValid, 400 USERNAME_INVALID).
-- ADDITIVE: one CHECK constraint; no row is changed. Existing usernames are checked first; if any
-- would be refused the migration stops with a message (atomic). Frozen migrations untouched.
BEGIN;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM "Employee" WHERE "username" IS NOT NULL AND coalesce(auth_norm_username("username"), '') !~ '^[a-z0-9._-]{3,64}$';
  IF n > 0 THEN
    RAISE EXCEPTION 'AUTH: % username(s) are not 3-64 characters of a-z, 0-9, dot, underscore or hyphen after normalization; rename them before this migration', n;
  END IF;
END $$;

ALTER TABLE "Employee" ADD CONSTRAINT "Employee_username_charset" CHECK ("username" IS NULL OR auth_norm_username("username") ~ '^[a-z0-9._-]{3,64}$');

COMMIT;
