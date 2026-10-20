// The trail of the settings sections (migration 20261022110000_settings_sections): one row per
// change made from Settings › Production & roasting, Inventory or Invoicing & tax, with the names
// of the fields that changed and their values before and after. Append-only by the application:
// nothing in the code updates or deletes a row.
import type { Prisma } from "@/generated/prisma/client";

export type SettingsSection = "production" | "inventory" | "invoicing";
export type SettingsAction =
  | "SETTINGS_UPDATED" | "ROASTER_CREATED" | "ROASTER_UPDATED" | "ROASTER_STATUS_CHANGED"
  | "MAINTENANCE_CREATED" | "MAINTENANCE_UPDATED" | "OPERATOR_ASSIGNED" | "OPERATOR_UNASSIGNED"
  // Small-fixes batch (migration 20261024090000_small_fixes): the one-time order status recompute.
  | "ORDER_STATUS_RECOMPUTED";

type Tx = { settingsAuditLog: { create(args: { data: Prisma.SettingsAuditLogUncheckedCreateInput }): Promise<unknown> } };
type Plain = Record<string, unknown>;

/** The keys whose values differ (compared as JSON, so Decimals and dates compare by value). */
export function changedKeys(before: Plain, after: Plain): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).sort();
}

/** Only the given keys of an object. */
export function pick(o: Plain, keys: string[]): Plain {
  return Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
}

export async function writeSettingsAudit(tx: Tx, e: {
  section: SettingsSection;
  action: SettingsAction;
  entityType: string;
  entityId: string;
  changed: string[];
  before?: Plain | null;
  after?: Plain | null;
  reason?: string | null;
  actor: { id: string; name?: string | null };
}): Promise<void> {
  await tx.settingsAuditLog.create({
    data: {
      section: e.section,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      changed: e.changed,
      before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined,
      reason: e.reason ?? null,
      actorId: e.actor.id,
      actorName: e.actor.name ?? null,
    },
  });
}
