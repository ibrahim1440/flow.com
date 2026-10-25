// «مساحة عملي» — the one settings row. Absent = the documented defaults (a proposal: hoursConfirmed false).
import { DEFAULT_HOURS, validHours, type WorkHours } from "../time";
import { wsError, type Db } from "./context";

export type WorkspaceSettings = WorkHours & { hoursConfirmed: boolean; defaultRemindBeforeMinutes: number; escalateAfterHours: number | null };

export const DEFAULT_SETTINGS: WorkspaceSettings = { ...DEFAULT_HOURS, hoursConfirmed: false, defaultRemindBeforeMinutes: 60, escalateAfterHours: 4 };

export async function getSettings(db: Db): Promise<WorkspaceSettings> {
  const r = await db.workSettings.findUnique({ where: { id: "default" } });
  if (!r) return DEFAULT_SETTINGS;
  return { workDays: r.workDays, dayStart: r.dayStart, dayEnd: r.dayEnd, hoursConfirmed: r.hoursConfirmed, defaultRemindBeforeMinutes: r.defaultRemindBeforeMinutes, escalateAfterHours: r.escalateAfterHours };
}

/** Saved by a `settings` editor (the route checks); every value validated here and by CHECKs. */
export async function saveSettings(db: Db, actorId: string, b: Record<string, unknown>): Promise<WorkspaceSettings> {
  const cur = await getSettings(db);
  const next: WorkspaceSettings = {
    workDays: Array.isArray(b.workDays) ? [...new Set(b.workDays.map(Number))].sort() : cur.workDays,
    dayStart: typeof b.dayStart === "string" ? b.dayStart : cur.dayStart,
    dayEnd: typeof b.dayEnd === "string" ? b.dayEnd : cur.dayEnd,
    hoursConfirmed: typeof b.hoursConfirmed === "boolean" ? b.hoursConfirmed : cur.hoursConfirmed,
    defaultRemindBeforeMinutes: b.defaultRemindBeforeMinutes !== undefined ? Number(b.defaultRemindBeforeMinutes) : cur.defaultRemindBeforeMinutes,
    escalateAfterHours: b.escalateAfterHours === null ? null : b.escalateAfterHours !== undefined ? Number(b.escalateAfterHours) : cur.escalateAfterHours,
  };
  if (!validHours(next)) throw wsError(400, "أيام وساعات الدوام غير صالحة.", "Working days / hours are not valid.", "HOURS_INVALID");
  if (!Number.isInteger(next.defaultRemindBeforeMinutes) || next.defaultRemindBeforeMinutes < 0 || next.defaultRemindBeforeMinutes > 10080) throw wsError(400, "مدة التذكير غير صالحة.", "Reminder lead time is not valid.", "REMIND_INVALID");
  if (next.escalateAfterHours !== null && (!Number.isInteger(next.escalateAfterHours) || next.escalateAfterHours < 1 || next.escalateAfterHours > 720)) throw wsError(400, "مدة التصعيد غير صالحة.", "Escalation delay is not valid.", "ESCALATE_INVALID");
  await db.workSettings.upsert({ where: { id: "default" }, create: { id: "default", ...next, updatedById: actorId }, update: { ...next, updatedById: actorId } });
  return next;
}
