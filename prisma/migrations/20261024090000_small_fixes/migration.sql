-- Small-fixes batch: the one-time order status recompute (Settings › Production & roasting
-- «إعادة حساب حالات الطلبات») is audited in SettingsAuditLog as ORDER_STATUS_RECOMPUTED.
--
-- Additive: the action CHECK of 20261022110000_settings_sections is widened by one value. Every
-- value it accepted before is still accepted, no column, table, row or index changes, and the
-- previous application version (which never writes the new value) runs unchanged on the result.
-- The table is small and append-only; re-adding the CHECK validates its rows in one short scan.

ALTER TABLE "SettingsAuditLog" DROP CONSTRAINT "SettingsAuditLog_action_check";

ALTER TABLE "SettingsAuditLog" ADD CONSTRAINT "SettingsAuditLog_action_check" CHECK ("action" IN ('SETTINGS_UPDATED', 'ROASTER_CREATED', 'ROASTER_UPDATED',
  'ROASTER_STATUS_CHANGED', 'MAINTENANCE_CREATED', 'MAINTENANCE_UPDATED', 'OPERATOR_ASSIGNED', 'OPERATOR_UNASSIGNED',
  'ORDER_STATUS_RECOMPUTED'));
