-- Document-expiry notifications and HR e-mails (feat/hr-expiry-email). Owner request: a daily check of
-- the expiry dates HR keeps (employee documents, the identity / iqama on the private data, fixed-term
-- contracts), notifying the employee and the HR holders before expiry; and the HR e-mails for an
-- interview invitation and the end-of-service notice.
--
-- ADDITIVE ONLY — one column on an existing table, with a default:
--   "HrSettings"."expiryAlertDays"   INTEGER[] NOT NULL DEFAULT {60,30,14,7,1}: the days before expiry
--                                    at which the daily check notifies («قبل الانتهاء بـ … يومًا»),
--                                    edited in HR settings. CHECK: 1 to 10 entries, each 1..365.
--                                    ADD COLUMN with a constant default is metadata-only (no table
--                                    rewrite); the singleton row, if present, reads the default and
--                                    passes the CHECK. The Phase 1 switch guard (hr_settings_live_guard)
--                                    reads other columns only and is unchanged.
-- Nothing else: the notifications use the existing "Notification" / "NotificationWatch" tables (the
-- dedupe is the existing unique ("recipientId", "dedupeKey")), and the e-mail log is the existing
-- append-only "HrAuditLog". No row is written, nothing is renamed, dropped or back-filled. The previous
-- application version never reads the new column.
-- Grants: the runtime role's column grants on "HrSettings" are read from the catalog by
-- scripts/hr/grant-hr-runtime.sql — re-run it after this migration so the new column is writable.
-- Atomic: the whole file runs in one transaction. Rollback:
-- docs/hr/migration-review/rollback-20261030090000_hr_expiry_email.sql.
BEGIN;

ALTER TABLE "HrSettings" ADD COLUMN "expiryAlertDays" INTEGER[] NOT NULL DEFAULT ARRAY[60, 30, 14, 7, 1]::INTEGER[];
ALTER TABLE "HrSettings" ADD CONSTRAINT "HrSettings_expiryAlertDays_check"
  CHECK (cardinality("expiryAlertDays") BETWEEN 1 AND 10
         AND array_position("expiryAlertDays", NULL) IS NULL
         AND 1 <= ALL ("expiryAlertDays") AND 365 >= ALL ("expiryAlertDays"));

COMMIT;
