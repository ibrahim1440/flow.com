// «مساحة عملي» — which reminders a task should have. Pure (unit-tested); the outbox lives in
// server/reminders.ts.
export const OPEN = ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "IN_REVIEW"];
const MIN = 60_000;

export type PlanTask = { id: string; version: number; status: string; dueAt: Date; assigneeId: string; createdById: string; remindBeforeMinutes: number | null };
export type PlanRow = { kind: string; recipientId: string; fireAt: Date; anchorAt: Date };

/** The reminders a task in this state should have (pure; unit-tested). */
export function taskPlan(t: PlanTask, s: { escalateAfterHours: number | null }, managerId: string | null, now: Date): PlanRow[] {
  if (!OPEN.includes(t.status)) return [];
  const out: PlanRow[] = [];
  const due = t.dueAt.getTime();
  if (t.remindBeforeMinutes !== null && t.remindBeforeMinutes > 0 && due - t.remindBeforeMinutes * MIN > now.getTime()) {
    out.push({ kind: "DUE_SOON", recipientId: t.assigneeId, fireAt: new Date(due - t.remindBeforeMinutes * MIN), anchorAt: t.dueAt });
  }
  // At the deadline (also when planned after it: the runner sends it at once, once).
  out.push({ kind: "OVERDUE", recipientId: t.assigneeId, fireAt: t.dueAt, anchorAt: t.dueAt });
  if (s.escalateAfterHours) {
    const at = new Date(due + s.escalateAfterHours * 3_600_000);
    const to = new Set([t.createdById, managerId].filter((x): x is string => !!x && x !== t.assigneeId));
    for (const r of to) out.push({ kind: "ESCALATION", recipientId: r, fireAt: at, anchorAt: t.dueAt });
  }
  return out;
}

