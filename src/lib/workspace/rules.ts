// «مساحة عملي» — who may do what to a task, and which status changes exist. Pure (unit-tested).
//
// A task has ONE accountable owner, the assignee. Around it:
//   CREATOR   — who assigned it (for a personal task, the same person as the assignee);
//   REVIEWER  — the named reviewer, when completion needs a review;
//   WATCHER   — follows it, reads and comments, changes nothing;
//   MANAGER   — the assignee's HR manager (HrEmployee.managerId → its login);
//   ASSIGN_ANY / TEAM_VIEW — the workspace sub-privileges (all colleagues).
// The rules never trust the client: the server derives these roles from the database per request.

export const TASK_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "IN_REVIEW", "DONE", "CANCELLED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const OPEN_STATUSES: TaskStatus[] = ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "IN_REVIEW"];
export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type Role = "ASSIGNEE" | "CREATOR" | "REVIEWER" | "WATCHER" | "MANAGER" | "ASSIGN_ANY" | "TEAM_VIEW";

export type TaskAction =
  | "start" | "hold" | "resume" | "complete" | "approve_review" | "return" | "cancel"
  | "edit" | "reassign" | "comment" | "checklist" | "view" | "snooze";

/** What a status change does: from which statuses, to which. `complete` is resolved per task (review). */
const MOVES: Record<"start" | "hold" | "resume" | "approve_review" | "return" | "cancel", { from: TaskStatus[]; to: TaskStatus }> = {
  start: { from: ["NOT_STARTED"], to: "IN_PROGRESS" },
  hold: { from: ["NOT_STARTED", "IN_PROGRESS"], to: "ON_HOLD" },
  resume: { from: ["ON_HOLD"], to: "IN_PROGRESS" },
  approve_review: { from: ["IN_REVIEW"], to: "DONE" },
  return: { from: ["IN_REVIEW"], to: "IN_PROGRESS" },
  cancel: { from: ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "IN_REVIEW"], to: "CANCELLED" },
};

/** The status a transition leads to, or null when it does not apply from `status`. */
export function nextStatus(action: TaskAction, task: { status: string; requiresReview: boolean }): TaskStatus | null {
  if (action === "complete") {
    if (!["NOT_STARTED", "IN_PROGRESS"].includes(task.status)) return null;
    return task.requiresReview ? "IN_REVIEW" : "DONE";
  }
  const m = (MOVES as Record<string, { from: TaskStatus[]; to: TaskStatus }>)[action];
  if (!m) return null;
  return m.from.includes(task.status as TaskStatus) ? m.to : null;
}

const WHO: Record<TaskAction, Role[]> = {
  view: ["ASSIGNEE", "CREATOR", "REVIEWER", "WATCHER", "MANAGER", "ASSIGN_ANY", "TEAM_VIEW"],
  comment: ["ASSIGNEE", "CREATOR", "REVIEWER", "WATCHER", "MANAGER", "ASSIGN_ANY", "TEAM_VIEW"],
  snooze: ["ASSIGNEE", "CREATOR", "REVIEWER", "WATCHER", "MANAGER", "ASSIGN_ANY", "TEAM_VIEW"],
  // The work itself is the assignee's.
  start: ["ASSIGNEE"],
  hold: ["ASSIGNEE"],
  resume: ["ASSIGNEE"],
  complete: ["ASSIGNEE"],
  checklist: ["ASSIGNEE", "CREATOR", "MANAGER"],
  // Reviewing is someone else's (see `canDo`: never the assignee).
  approve_review: ["REVIEWER", "CREATOR", "MANAGER"],
  return: ["REVIEWER", "CREATOR", "MANAGER"],
  // Changing what was asked — what, when, who — is the asker's, the manager's or an assign_any holder's.
  edit: ["CREATOR", "MANAGER", "ASSIGN_ANY"],
  reassign: ["CREATOR", "MANAGER", "ASSIGN_ANY"],
  cancel: ["CREATOR", "MANAGER", "ASSIGN_ANY"],
};

export function canDo(action: TaskAction, roles: Set<Role>, opts: { simpleMode?: boolean; personal?: boolean; hasReviewer?: boolean } = {}): boolean {
  if (!WHO[action].some((r) => roles.has(r))) return false;
  if (action === "approve_review" || action === "return") {
    // Four eyes: the person who did the work does not sign it off (SIMPLE MODE: the single owner may).
    if (roles.has("ASSIGNEE") && !opts.simpleMode) return false;
    // A named reviewer decides; the creator / manager decide only when none was named.
    if (opts.hasReviewer && !roles.has("REVIEWER") && !roles.has("MANAGER")) return false;
  }
  return true;
}

/** Whether `actor` may give work to `assignee`: themself, a direct report, or anyone with assign_any. */
export function mayAssign(actorId: string, assigneeId: string, ctx: { directReports: Set<string>; assignAny: boolean }): boolean {
  return actorId === assigneeId || ctx.assignAny || ctx.directReports.has(assigneeId);
}

export const LIMITS = { title: 300, description: 4000, comment: 4000, checklist: 50, checklistLabel: 300, watchers: 20, holdReason: 500 } as const;

/** Arabic / English wording of each status, with the tone the screens draw (never colour alone). */
export const STATUS_LABEL: Record<TaskStatus, { ar: string; en: string; tone: "neutral" | "info" | "warning" | "success" | "cancelled" }> = {
  NOT_STARTED: { ar: "لم تبدأ", en: "Not started", tone: "neutral" },
  IN_PROGRESS: { ar: "قيد التنفيذ", en: "In progress", tone: "info" },
  ON_HOLD: { ar: "متوقفة", en: "On hold", tone: "warning" },
  IN_REVIEW: { ar: "بانتظار المراجعة", en: "Awaiting review", tone: "info" },
  DONE: { ar: "مكتملة", en: "Done", tone: "success" },
  CANCELLED: { ar: "ملغاة", en: "Cancelled", tone: "cancelled" },
};

export const PRIORITY_LABEL: Record<Priority, { ar: string; en: string }> = {
  LOW: { ar: "منخفضة", en: "Low" },
  NORMAL: { ar: "عادية", en: "Normal" },
  HIGH: { ar: "مرتفعة", en: "High" },
  URGENT: { ar: "عاجلة", en: "Urgent" },
};
