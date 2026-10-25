// «مساحة عملي» — the reminder outbox: planning (inside the write that changes a task / appointment) and
// the runner (cron, an external scheduler, or the bell poll — any of them, any number at once).
//
// Planning: every write re-plans. PENDING rows of the record are CANCELLED and the rows of the new state
// inserted (keyed by the record's version, so a re-plan never collides with an older plan). A closed record
// plans nothing.
//
// Running: due rows are claimed with SKIP LOCKED (two runners never take the same row), re-checked against
// the record in the transaction that notifies (still open, `anchorAt` still its due / start instant, the
// recipient still the right person, the account active) and sent through lib/notifications, whose unique
// (recipient, dedupeKey) — the key carries the due instant — makes a replay, a retry or a duplicate plan
// produce no second notification. A row that fails is retried with back-off, five times, then FAILED; a
// row left SENDING by a dead process is retried after five minutes. Nothing here ever throws to a caller.
import { prisma, TX_OPTS } from "@/lib/db";
import { notify } from "@/lib/notifications/notify";
import { managerAccountOf, dueTexts, type Db } from "./context";
import { getSettings } from "./settings";
import { taskPlan, OPEN } from "../plan";

const MIN = 60_000;
export const MAX_ATTEMPTS = 5;
const STUCK_MS = 5 * MIN;

/** Re-plan a task's reminders inside the transaction that changed it. */
export async function planTaskReminders(tx: Db, taskId: string, now = new Date()): Promise<number> {
  await tx.workReminder.updateMany({ where: { taskId, status: "PENDING", kind: { not: "SNOOZE" } }, data: { status: "CANCELLED" } });
  const t = await tx.workTask.findUnique({ where: { id: taskId }, select: { id: true, version: true, status: true, dueAt: true, assigneeId: true, createdById: true, remindBeforeMinutes: true } });
  if (!t) return 0;
  if (!OPEN.includes(t.status)) {
    await tx.workReminder.updateMany({ where: { taskId, status: "PENDING" }, data: { status: "CANCELLED" } });
    return 0;
  }
  const rows = taskPlan(t, await getSettings(tx), await managerAccountOf(tx, t.assigneeId), now);
  if (!rows.length) return 0;
  const r = await tx.workReminder.createMany({
    data: rows.map((p) => ({ taskId, kind: p.kind, recipientId: p.recipientId, fireAt: p.fireAt, anchorAt: p.anchorAt, dedupeKey: `t:${taskId}:v${t.version}:${p.kind}:${p.recipientId}` })),
    skipDuplicates: true,
  });
  return r.count;
}

/** Re-plan an appointment's reminders (one per participant and the organiser). */
export async function planAppointmentReminders(tx: Db, appointmentId: string, now = new Date()): Promise<number> {
  await tx.workReminder.updateMany({ where: { appointmentId, status: "PENDING" }, data: { status: "CANCELLED" } });
  const a = await tx.workAppointment.findUnique({ where: { id: appointmentId }, select: { version: true, status: true, startAt: true, organizerId: true, remindBeforeMinutes: true, participants: { select: { employeeId: true } } } });
  if (!a || a.status !== "SCHEDULED" || a.remindBeforeMinutes === null) return 0;
  const fireAt = new Date(a.startAt.getTime() - a.remindBeforeMinutes * MIN);
  if (fireAt.getTime() <= now.getTime()) return 0;
  const people = [...new Set([a.organizerId, ...a.participants.map((p) => p.employeeId)])];
  const r = await tx.workReminder.createMany({
    data: people.map((id) => ({ appointmentId, kind: "APPOINTMENT", recipientId: id, fireAt, anchorAt: a.startAt, dedupeKey: `a:${appointmentId}:v${a.version}:${id}` })),
    skipDuplicates: true,
  });
  return r.count;
}

/** «ذكّرني لاحقًا»: a one-off reminder for the asker; the deadline never moves. */
export async function snoozeTask(tx: Db, taskId: string, recipientId: string, minutes: number, now = new Date()) {
  const t = await tx.workTask.findUnique({ where: { id: taskId }, select: { dueAt: true, status: true } });
  if (!t || !OPEN.includes(t.status)) return null;
  const fireAt = new Date(now.getTime() + minutes * MIN);
  await tx.workReminder.create({ data: { taskId, kind: "SNOOZE", recipientId, fireAt, anchorAt: t.dueAt, dedupeKey: `t:${taskId}:snooze:${recipientId}:${fireAt.toISOString()}` } });
  return fireAt;
}

type Claimed = { id: string; taskId: string | null; appointmentId: string | null; kind: string; recipientId: string; fireAt: Date; anchorAt: Date; attempts: number };

export type RunSummary = { claimed: number; sent: number; skipped: number; retried: number; failed: number };

/**
 * Send what is due. Never throws. `budgetMs` bounds the wall time: what is still claimed when it runs out
 * goes back to PENDING untouched (its attempt not counted) for the next run.
 */
export async function runReminders(now = new Date(), limit = 200, budgetMs = 50_000): Promise<RunSummary> {
  const started = Date.now();
  const out: RunSummary = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0 };
  try {
    await prisma.workReminder.updateMany({ where: { status: "SENDING", claimedAt: { lt: new Date(now.getTime() - STUCK_MS) }, attempts: { lt: MAX_ATTEMPTS } }, data: { status: "PENDING" } });
    await prisma.workReminder.updateMany({ where: { status: "SENDING", claimedAt: { lt: new Date(now.getTime() - STUCK_MS) }, attempts: { gte: MAX_ATTEMPTS } }, data: { status: "FAILED", lastError: "stuck" } });
    const claimed = await prisma.$queryRaw<Claimed[]>`
      UPDATE "WorkReminder" SET "status" = 'SENDING', "claimedAt" = ${now}, "attempts" = "attempts" + 1
      WHERE "id" IN (SELECT "id" FROM "WorkReminder" WHERE "status" = 'PENDING' AND "fireAt" <= ${now}
                     ORDER BY "fireAt" LIMIT ${Math.min(Math.max(limit, 1), 500)} FOR UPDATE SKIP LOCKED)
      RETURNING "id", "taskId", "appointmentId", "kind", "recipientId", "fireAt", "anchorAt", "attempts"`;
    out.claimed = claimed.length;
    for (const [i, c] of claimed.entries()) {
      if (Date.now() - started > budgetMs) {
        const rest = claimed.slice(i).map((r) => r.id);
        await prisma.workReminder.updateMany({ where: { id: { in: rest }, status: "SENDING" }, data: { status: "PENDING", attempts: { decrement: 1 } } }).catch(() => undefined);
        out.claimed = i;
        break;
      }
      try {
        const verdict = await prisma.$transaction(async (tx) => {
          // One slow statement must not hold the request (or the cron) hostage.
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
          return deliverOne(tx, c, now);
        }, TX_OPTS);
        await prisma.workReminder.update({ where: { id: c.id }, data: verdict === "SENT" ? { status: "SENT", sentAt: now } : { status: "SKIPPED" } });
        if (verdict === "SENT") out.sent++; else out.skipped++;
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : "error";
        const fail = c.attempts >= MAX_ATTEMPTS;
        await prisma.workReminder.update({
          where: { id: c.id },
          data: fail ? { status: "FAILED", lastError: msg } : { status: "PENDING", lastError: msg, fireAt: new Date(now.getTime() + c.attempts * 2 * MIN) },
        }).catch(() => undefined);
        if (fail) out.failed++; else out.retried++;
      }
    }
  } catch (e) {
    console.error("[workspace] reminder run failed:", (e as Error)?.name ?? "error");
  }
  return out;
}

/** Re-check one claimed reminder against its record and notify. "SENT" or "SKIPPED". */
async function deliverOne(tx: Db, c: Claimed, now: Date): Promise<"SENT" | "SKIPPED"> {
  const person = await tx.employee.findUnique({ where: { id: c.recipientId }, select: { active: true } });
  if (!person?.active) return "SKIPPED";
  if (c.appointmentId) {
    const a = await tx.workAppointment.findUnique({ where: { id: c.appointmentId }, select: { id: true, title: true, status: true, startAt: true, location: true, organizerId: true, participants: { select: { employeeId: true } } } });
    if (!a || a.status !== "SCHEDULED" || a.startAt.getTime() !== c.anchorAt.getTime() || a.startAt.getTime() <= now.getTime()) return "SKIPPED";
    if (a.organizerId !== c.recipientId && !a.participants.some((p) => p.employeeId === c.recipientId)) return "SKIPPED";
    const w = dueTexts(a.startAt);
    await notify(tx, {
      event: "me.appointment", dedupeKey: `${a.id}:SOON:${a.startAt.toISOString()}`, people: { recipient: c.recipientId },
      entity: { type: "WorkAppointment", id: a.id },
      facts: { change: "SOON", title: a.title, when: w.due, whenEn: w.dueEn, where: a.location, appointmentId: a.id },
    });
    return "SENT";
  }
  const t = await tx.workTask.findUnique({ where: { id: c.taskId! }, select: { id: true, title: true, status: true, dueAt: true, assigneeId: true, createdById: true, assignee: { select: { name: true } } } });
  if (!t || !OPEN.includes(t.status) || t.dueAt.getTime() !== c.anchorAt.getTime()) return "SKIPPED";
  const d = dueTexts(t.dueAt);
  const base = { entity: { type: "WorkTask", id: t.id }, people: { recipient: c.recipientId } };
  if (c.kind === "DUE_SOON" || c.kind === "OVERDUE") {
    if (c.recipientId !== t.assigneeId) return "SKIPPED";
    if (c.kind === "DUE_SOON" && t.dueAt.getTime() <= now.getTime()) return "SKIPPED"; // the overdue one says it
    if (c.kind === "OVERDUE" && t.dueAt.getTime() > now.getTime()) return "SKIPPED";
    await notify(tx, { ...base, event: c.kind === "DUE_SOON" ? "me.task_due_soon" : "me.task_overdue", dedupeKey: `${t.id}:${c.kind}:${t.dueAt.toISOString()}`, facts: { title: t.title, ...d, taskId: t.id } });
    return "SENT";
  }
  if (c.kind === "ESCALATION") {
    if (t.dueAt.getTime() > now.getTime()) return "SKIPPED";
    const manager = await managerAccountOf(tx, t.assigneeId);
    if (c.recipientId !== t.createdById && c.recipientId !== manager) return "SKIPPED";
    await notify(tx, { ...base, event: "me.task_escalated", dedupeKey: `${t.id}:ESCALATION:${t.dueAt.toISOString()}`, facts: { title: t.title, assignee: t.assignee.name, ...d, taskId: t.id } });
    return "SENT";
  }
  // SNOOZE: the person asked to be reminded again at this time.
  await notify(tx, { ...base, event: "me.task_due_soon", dedupeKey: `${t.id}:SNOOZE:${c.fireAt.toISOString()}`, facts: { title: t.title, ...d, taskId: t.id } });
  return "SENT";
}

let lastOpportunistic = 0;
/** The bell poll's share: at most once a minute per server instance. Never throws. */
export async function maybeRunReminders(now = Date.now()): Promise<void> {
  if (now - lastOpportunistic < 60_000) return;
  lastOpportunistic = now;
  await runWorkspaceJobs("request");
}

/**
 * Every workspace job, recorded (WorkJobRun). It acts as the system, never as the person whose request
 * carried it. On the request path (after a bell poll) it takes a small batch with a short budget so it
 * never competes with the response or the e-mail delivery; the scheduler takes the rest.
 */
export async function runWorkspaceJobs(trigger: "cron" | "request" | "manual", now = new Date()) {
  const startedAt = new Date();
  const reminders = trigger === "request" ? await runReminders(now, 25, 4_000) : await runReminders(now);
  const summary = { reminders };
  // A scheduled or manual run is always recorded (the settings screen shows the last one); a bell-poll run
  // only when it did something, so the table does not grow by a row a minute.
  if (trigger !== "request" || reminders.claimed > 0) {
    await prisma.workJobRun.create({ data: { trigger, startedAt, finishedAt: new Date(), status: "SUCCEEDED", summary } }).catch(() => undefined);
  }
  return summary;
}
