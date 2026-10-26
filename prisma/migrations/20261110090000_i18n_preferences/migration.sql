-- Language preferences (owner language decisions 1 and 3, 26 Oct 2026). ADDITIVE ONLY: five nullable
-- columns with no default (metadata-only ADD COLUMN, no existing row rewritten, nothing reads
-- differently until somebody writes one), CHECKs that judge the new columns only (they validate
-- against NULLs), and the SettingsAuditLog section CHECK WIDENED by two values (every row it accepted
-- before it still accepts). Nothing is dropped from the data, renamed, retyped, made NOT NULL or
-- back-filled.
--   SystemConfig.loginTaglineAr / loginTaglineEn (TEXT, CHECK 1–120 characters): Settings › Organisation,
--     the line under the brand on the sign-in screen, per language. NULL = the built-in line
--     («كل عملية بوضوح. كل تفصيل بإتقان.» / "Every process, clear. Every detail, precise.");
--   AutomationSettings.employeeMessageLang (TEXT, CHECK 'ar' | 'en'): the language automation WhatsApp
--     messages to EMPLOYEES are written in when the employee has not chosen one. NULL = Arabic, as today;
--   Employee.whatsappLanguage (TEXT, CHECK 'ar' | 'en'): the employee's own choice («خدماتي»).
--     NULL = «حسب إعداد النظام»;
--   WhatsAppStatusRule.templateEn (TEXT): the English text of a status notification, sent to employees
--     who receive English. NULL / empty = the Arabic text, as today. Customers always get `template`;
--   SettingsAuditLog_section_check: + 'organisation' (the sign-in line) and 'automation' (the employee
--     message language), so those changes are audited with the other settings sections.
-- Customer-facing and marketing messages are not touched. Atomic: the whole file runs in one transaction.
-- Rollback: docs/hr/migration-review/rollback-20261110090000_i18n_preferences.sql.
BEGIN;

ALTER TABLE "SystemConfig" ADD COLUMN "loginTaglineAr" TEXT,
ADD COLUMN "loginTaglineEn" TEXT;
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_loginTaglineAr_check"
  CHECK ("loginTaglineAr" IS NULL OR (char_length(btrim("loginTaglineAr")) BETWEEN 1 AND 120));
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_loginTaglineEn_check"
  CHECK ("loginTaglineEn" IS NULL OR (char_length(btrim("loginTaglineEn")) BETWEEN 1 AND 120));

ALTER TABLE "AutomationSettings" ADD COLUMN "employeeMessageLang" TEXT;
ALTER TABLE "AutomationSettings" ADD CONSTRAINT "AutomationSettings_employeeMessageLang_check"
  CHECK ("employeeMessageLang" IS NULL OR "employeeMessageLang" IN ('ar', 'en'));

ALTER TABLE "Employee" ADD COLUMN "whatsappLanguage" TEXT;
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_whatsappLanguage_check"
  CHECK ("whatsappLanguage" IS NULL OR "whatsappLanguage" IN ('ar', 'en'));

ALTER TABLE "WhatsAppStatusRule" ADD COLUMN "templateEn" TEXT;

ALTER TABLE "SettingsAuditLog" DROP CONSTRAINT "SettingsAuditLog_section_check";
ALTER TABLE "SettingsAuditLog" ADD CONSTRAINT "SettingsAuditLog_section_check"
  CHECK ("section" IN ('production', 'inventory', 'invoicing', 'organisation', 'automation'));

COMMIT;
