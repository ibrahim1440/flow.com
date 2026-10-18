-- Independent re-test of 2307375b, AUTH-F: one locale-independent normal form for usernames,
-- identical to the application's normalizeUsername (src/lib/auth/privileged.ts):
--   1. NFKC (full-width letters and Unicode spaces such as U+00A0 / U+3000 become ASCII);
--   2. leading / trailing ASCII whitespace removed (space, tab, line feed, carriage return,
--      vertical tab, form feed) — an explicit list, not btrim's or \s's locale meaning;
--   3. only ASCII A-Z folded to a-z (not lower(), whose result depends on the database's ctype);
--   4. blank becomes NULL.
-- ADDITIVE: the frozen 20261016140000, 20261016160000 and 20261016180000 are untouched. The
-- function is redefined and its unique index rebuilt; no row is changed. If two existing
-- usernames would collide under the new form, the migration stops with a message (atomic).
BEGIN;

DROP INDEX IF EXISTS "Employee_username_norm_key";

CREATE OR REPLACE FUNCTION auth_norm_username(v TEXT) RETURNS TEXT AS $$
DECLARE t TEXT;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  t := normalize(v, NFKC);
  t := regexp_replace(t, '^[ \u0009\u000A\u000B\u000C\u000D]+|[ \u0009\u000A\u000B\u000C\u000D]+$', '', 'g');
  t := translate(t, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
  IF t = '' THEN RETURN NULL; END IF;
  RETURN t;
END $$ LANGUAGE plpgsql IMMUTABLE;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM (SELECT auth_norm_username("username") FROM "Employee" WHERE auth_norm_username("username") IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'AUTH: % username(s) would collide under the locale-independent normal form; rename them before this migration', n;
  END IF;
END $$;

CREATE UNIQUE INDEX "Employee_username_norm_key" ON "Employee" (auth_norm_username("username")) WHERE auth_norm_username("username") IS NOT NULL;

COMMIT;
