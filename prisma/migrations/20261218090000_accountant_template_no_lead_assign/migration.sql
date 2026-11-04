-- 20261218090000_accountant_template_no_lead_assign — owner decision: a NEW accountant does not get the sales supervisor's
-- powers. The «محاسب» role template (AccessRole matched by name) has sales › lead_assign set to false, so an account created
-- on it — or made to follow it later — no longer receives it.
--
-- Data only, no schema change, nothing sent. Only the template's document: NO Employee document is touched (the account(s)
-- following «محاسب» on live already hold lead_assign = false; this migration does not rewrite them either way, so an
-- individual grant made on purpose stays). The role's version is bumped (the role editor's optimistic concurrency, UR-S10),
-- and the change is audited like a role-editor save: one "AuthAuditLog" row, action ROLE_UPDATED, the template diff in the
-- editor's own shape ({ path: 'sales.lead_assign', from, to }), the migration as the actor (userId NULL, sourceInterface
-- MIGRATION), deterministic id 'acctpl_nla_' || the role's id || '_v' || its new version ("AuthAuditLog" is append-only,
-- so a re-apply after the rollback writes its own row at the next version instead of reusing one).
-- Idempotent: the UPDATE matches only while the template holds lead_assign = true; the audit row is ON CONFLICT DO NOTHING.
-- Rollback: docs/hr/migration-review/rollback-20261218090000_accountant_template_no_lead_assign.sql. Verifier check 84.
BEGIN;
SET LOCAL lock_timeout = '5s';

WITH r AS (
  UPDATE "AccessRole" a
     SET "permissions" = jsonb_set(a."permissions"::jsonb, '{sales,sub,lead_assign}', 'false'::jsonb, false)::text,
         "version" = a."version" + 1, "updatedAt" = now()
   WHERE a."name" = 'محاسب'
     AND CASE WHEN a."permissions" IS JSON OBJECT THEN (a."permissions"::jsonb #>> '{sales,sub,lead_assign}') = 'true' ELSE false END
  RETURNING a."id", a."name", a."version"
)
INSERT INTO "AuthAuditLog" ("id", "userId", "action", "result", "sourceInterface", "ipHash", "metadata", "occurredAt")
SELECT 'acctpl_nla_' || r."id" || '_v' || r."version", NULL, 'ROLE_UPDATED', 'SUCCESS', 'MIGRATION', 'migration',
       jsonb_build_object('roleId', r."id", 'roleName', r."name", 'version', r."version",
                          'changes', jsonb_build_array(jsonb_build_object('path', 'sales.lead_assign', 'from', true, 'to', false)),
                          'truncated', false, 'members', '[]'::jsonb,
                          'reason', 'accountant template (20261218090000_accountant_template_no_lead_assign): a new «محاسب» account does not get sales › lead_assign (owner decision); member documents unchanged'),
       now()
  FROM r
ON CONFLICT ("id") DO NOTHING;

COMMIT;
