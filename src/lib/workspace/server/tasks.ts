// «مساحة عملي» — tasks. Every write is one transaction: the row (version-checked), its history event,
// the re-planned reminders and the notification commit together or not at all.
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { notify } from "@/lib/notifications/notify";
import { effectivePermissions } from "@/lib/notifications/recipients";
import { seesAllSales } from "@/lib/services/sales/scope";
import { mayLogActivity, parseActivity, logCustomerActivity, logLeadOrDealActivity } from "@/lib/services/sales/activity-log";
import { ACTIVITY_OUTCOMES } from "@/lib/services/sales/qualification";
import { canDo, LIMITS, mayAssign, nextStatus, OPEN_STATUSES, PRIORITIES, type TaskAction } from "../rules";
import { addWorkingMinutes, completedLate, dueBucket, isOverdue, nextOccurrence, quickDue, type QuickDue } from "../time";
import {
  dueTexts, forbidden, notFound, requireVersion, rolesOf, seesCustomers, simple, stale, teamCtx, visibleTasksWhere, wsError, type Db, type TeamCtx, type WsActor,
} from "./context";
import { planTaskReminders, snoozeTask } from "./reminders";
import { getSettings } from "./settings";
import { syncLeadNextFollowUp } from "@/lib/services/sales/follow-through";

type Tx = PrismaNS.TransactionClient;
type Body = Record<string, unknown>;

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const idOrNull = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);

const DETAIL = {
  id: true, kind: true, title: true, description: true, status: true, holdReason: true, priority: true,
  assigneeId: true, createdById: true, reviewerId: true, requiresReview: true, dueAt: true, dueBasis: true,
  plannedStartAt: true, plannedMinutes: true, remindBeforeMinutes: true, channel: true,
  customerId: true, leadId: true, opportunityId: true, refType: true, refId: true, refLabel: true, occasionId: true,
  resultActivityId: true, recurRule: true, recurInterval: true, recurUntil: true, seriesId: true, occurrence: true,
  startedAt: true, submittedAt: true, completedAt: true, completedById: true, cancelledAt: true, cancelReason: true,
  version: true, createdAt: true, updatedAt: true,
  assignee: { select: { id: true, name: true, active: true } },
  createdBy: { select: { id: true, name: true } },
  reviewer: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true } },
  lead: { select: { id: true, companyName: true, contactName: true } },
  opportunity: { select: { id: true, title: true } },
  occasion: { select: { id: true, name: true } },
  watchers: { select: { employeeId: true, employee: { select: { name: true } } } },
} satisfies PrismaNS.WorkTaskSelect;

type Row = PrismaNS.WorkTaskGetPayload<{ select: typeof DETAIL }>;

const ACTIONS: TaskAction[] = ["start", "hold", "resume", "complete", "approve_review", "return", "cancel", "edit", "reassign", "comment", "checklist", "snooze"];

/** What the client may show: the row, derived facts, and the actions this actor may take now. */
function present(t: Row, actor: WsActor, ctx: TeamCtx, now: Date) {
  const roles = rolesOf(actor.id, t, ctx);
  const allowed = ACTIONS.filter((a) => {
    if (!canDo(a, roles, { simpleMode: simple(), hasReviewer: !!t.reviewerId })) return false;
    if (["start", "hold", "resume", "complete", "approve_review", "return", "cancel"].includes(a)) return nextStatus(a, t) !== null;
    if (["edit", "reassign", "checklist", "snooze"].includes(a)) return OPEN_STATUSES.includes(t.status as never);
    return true;
  });
  // A follow-up records its result instead of a bare «إكمال».
  const actions = t.kind === "FOLLOW_UP" && allowed.includes("complete") ? [...allowed.filter((a) => a !== "complete"), "record_result"] : allowed;
  return {
    ...t,
    overdue: isOverdue(t, now),
    completedLate: completedLate(t),
    bucket: OPEN_STATUSES.includes(t.status as never) ? dueBucket(t.dueAt, now) : null,
    roles: [...roles],
    actions,
  };
}

async function load(db: Db, id: string): Promise<Row | null> {
  return db.workTask.findUnique({ where: { id }, select: DETAIL });
}

/** Load a task the actor may see, or 404 (another person's task is not acknowledged). */
async function loadVisible(db: Db, actor: WsActor, id: string, ctx: TeamCtx): Promise<Row> {
  const t = await load(db, id);
  if (!t || !canDo("view", rolesOf(actor.id, t, ctx))) throw notFound();
  return t;
}

/** Lock the row (FOR UPDATE). The version is checked by the caller only AFTER visibility: a stranger gets 404, never 409. */
async function lockTask(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "WorkTask" WHERE "id" = ${id} FOR UPDATE`;
  if (!rows[0]) throw notFound();
}

async function event(tx: Tx, taskId: string, actorId: string | null, action: string, data: Record<string, unknown> = {}) {
  await tx.workTaskEvent.create({ data: { taskId, actorId, action, data: JSON.parse(JSON.stringify(data)) } });
}

// ── Deadline ────────────────────────────────────────────────────────────────────────────

const QUICK = ["h4", "h5", "h8", "eod", "tomorrow"];

/** The deadline from the body: `due: { quick, basis }` or `dueAt` (ISO). Refuses a past deadline. */
export async function resolveDue(db: Db, b: Body, now: Date): Promise<{ dueAt: Date; dueBasis: string }> {
  const settings = await getSettings(db);
  const q = b.due && typeof b.due === "object" ? (b.due as Body) : null;
  if (q && typeof q.quick === "string" && QUICK.includes(q.quick)) {
    const basis = q.basis === "BUSINESS" ? "BUSINESS" : "CLOCK";
    return { dueAt: quickDue(q.quick as QuickDue, now, basis, settings), dueBasis: basis };
  }
  if (q && typeof q.minutes === "number" && q.minutes > 0 && q.minutes <= 60 * 24 * 60) {
    const basis = q.basis === "BUSINESS" ? "BUSINESS" : "CLOCK";
    return { dueAt: basis === "BUSINESS" ? addWorkingMinutes(now, q.minutes, settings) : new Date(now.getTime() + q.minutes * 60_000), dueBasis: basis };
  }
  const at = typeof b.dueAt === "string" ? new Date(b.dueAt) : null;
  if (!at || Number.isNaN(at.getTime())) throw wsError(400, "حدّد الموعد النهائي بالتاريخ والوقت.", "A deadline (date and time) is required.", "DUE_REQUIRED");
  if (at.getTime() < now.getTime() - 60_000) throw wsError(400, "الموعد النهائي في الماضي.", "The deadline is in the past.", "DUE_PAST");
  return { dueAt: at, dueBasis: "EXACT" };
}

/** Preview of a quick deadline (the line «يُستحق: …» before saving). */
export async function previewDue(b: Body, now = new Date()) {
  const r = await resolveDue(prisma, b, now);
  return { dueAt: r.dueAt.toISOString(), dueBasis: r.dueBasis, ...dueTexts(r.dueAt) };
}

// ── Links ───────────────────────────────────────────────────────────────────────────────

type Links = { customerId: string | null; leadId: string | null; opportunityId: string | null; refType: string | null; refId: string | null; refLabel: string | null; occasionId: string | null };

async function resolveLinks(db: Db, actor: WsActor, b: Body): Promise<Links> {
  const l: Links = {
    customerId: idOrNull(b.customerId), leadId: idOrNull(b.leadId), opportunityId: idOrNull(b.opportunityId),
    refType: str(b.refType, 40), refId: idOrNull(b.refId), refLabel: str(b.refLabel, 200), occasionId: idOrNull(b.occasionId),
  };
  if ((l.refType === null) !== (l.refId === null)) { l.refType = null; l.refId = null; l.refLabel = null; }
  // A link must exist and be one the asker may see — a task is not a way to probe another rep's records.
  const scopeAll = seesAllSales(actor.permissions);
  if (l.customerId && !seesCustomers(actor)) throw notFound();
  if (l.customerId && !(await db.customer.findUnique({ where: { id: l.customerId }, select: { id: true } }))) throw notFound();
  if (l.leadId && !(await db.lead.findFirst({ where: { id: l.leadId, ...(scopeAll ? {} : { ownerId: actor.id }) }, select: { id: true } }))) throw notFound();
  if (l.opportunityId) {
    const d = await db.opportunity.findFirst({ where: { id: l.opportunityId, ...(scopeAll ? {} : { ownerId: actor.id }) }, select: { id: true, customerId: true } });
    if (!d) throw notFound();
    l.customerId = l.customerId ?? d.customerId;
  }
  if (l.occasionId && !(await db.workOccasion.findUnique({ where: { id: l.occasionId }, select: { id: true } }))) throw notFound();
  return l;
}

/**
 * A follow-up's result is a CRM activity written by its assignee, so the assignee must be able to write
 * one there: sales › lead_write (and customers, for a customer-only follow-up), and see the lead / deal.
 */
async function assertFollowUpAssignee(db: Db, assigneeId: string, l: Links) {
  if (!l.customerId && !l.leadId && !l.opportunityId) throw wsError(400, "متابعة العميل تحتاج عميلًا أو عميلًا محتملًا أو صفقة.", "A follow-up needs a customer, a lead or a deal.", "FOLLOW_UP_LINK");
  const row = await db.employee.findUnique({ where: { id: assigneeId }, select: { role: true, permissions: true } });
  const perms = row ? effectivePermissions(row) : {};
  const onCustomer = !l.leadId && !l.opportunityId;
  const sees = seesAllSales(perms);
  let ok = mayLogActivity(perms, onCustomer);
  if (ok && !sees && l.leadId) ok = !!(await db.lead.findFirst({ where: { id: l.leadId, ownerId: assigneeId }, select: { id: true } }));
  if (ok && !sees && l.opportunityId) ok = !!(await db.opportunity.findFirst({ where: { id: l.opportunityId, ownerId: assigneeId }, select: { id: true } }));
  if (!ok) throw wsError(409, "الموظف المسؤول لا يملك صلاحية تسجيل نشاط على هذا العميل في المبيعات. اختر موظفًا آخر أو اطلب منحه الصلاحية.", "The assignee cannot log activities on this record in Sales.", "ASSIGNEE_CANNOT_LOG");
}

async function assertAssignable(db: Db, actor: WsActor, ctx: TeamCtx, assigneeId: string) {
  const p = await db.employee.findUnique({ where: { id: assigneeId }, select: { id: true, active: true } });
  if (!p || !p.active) throw wsError(400, "الموظف المسؤول غير موجود أو حسابه معطّل.", "The assignee does not exist or is disabled.", "ASSIGNEE_INVALID");
  if (!mayAssign(actor.id, assigneeId, ctx)) throw forbidden("يمكنك إسناد المهام لنفسك ولفريقك المباشر فقط. الإسناد لغيرهم يحتاج صلاحية «إسناد المهام لأي موظف».");
}

function parseRecurrence(b: Body) {
  const rule = typeof b.recurRule === "string" && ["DAILY", "WEEKLY", "MONTHLY"].includes(b.recurRule) ? b.recurRule : null;
  if (!rule) return { recurRule: null, recurInterval: null, recurUntil: null };
  const interval = Math.min(Math.max(Math.floor(Number(b.recurInterval) || 1), 1), 365);
  const until = typeof b.recurUntil === "string" && b.recurUntil ? new Date(b.recurUntil) : null;
  return { recurRule: rule, recurInterval: interval, recurUntil: until && !Number.isNaN(until.getTime()) ? until : null };
}

// ── Create ──────────────────────────────────────────────────────────────────────────────

export async function createTask(actor: WsActor, b: Body, now = new Date()) {
  const title = str(b.title, LIMITS.title);
  if (!title) throw wsError(400, "اكتب عنوان المهمة.", "A title is required.", "TITLE_REQUIRED");
  const kind = b.kind === "FOLLOW_UP" ? "FOLLOW_UP" : "TASK";
  const priority = typeof b.priority === "string" && (PRIORITIES as readonly string[]).includes(b.priority) ? b.priority : "NORMAL";
  const assigneeId = idOrNull(b.assigneeId) ?? actor.id;
  const channel = kind === "FOLLOW_UP" ? (typeof b.channel === "string" && ["CALL", "VISIT", "MEETING"].includes(b.channel) ? b.channel : "CALL") : null;
  const requiresReview = b.requiresReview === true;
  const reviewerId = requiresReview ? idOrNull(b.reviewerId) : null;
  if (reviewerId && reviewerId === assigneeId) throw wsError(400, "المراجع يجب أن يكون شخصًا غير المسؤول عن التنفيذ.", "The reviewer must be someone other than the assignee.", "REVIEWER_IS_ASSIGNEE");
  const remind = b.remindBeforeMinutes === null ? null : b.remindBeforeMinutes !== undefined ? Math.min(Math.max(Math.floor(Number(b.remindBeforeMinutes) || 0), 0), 10080) : undefined;
  const watcherIds = Array.isArray(b.watcherIds) ? [...new Set(b.watcherIds.map(idOrNull).filter((x): x is string => !!x && x !== assigneeId))].slice(0, LIMITS.watchers) : [];
  const checklist = Array.isArray(b.checklist) ? b.checklist.map((x) => str(x, LIMITS.checklistLabel)).filter((x): x is string => !!x).slice(0, LIMITS.checklist) : [];
  const plannedStartAt = typeof b.plannedStartAt === "string" && b.plannedStartAt ? new Date(b.plannedStartAt) : null;
  const pm = b.plannedMinutes === undefined || b.plannedMinutes === null || b.plannedMinutes === "" ? null : Number(b.plannedMinutes);
  if (pm !== null && (!Number.isInteger(pm) || pm < 1 || pm > 14400)) throw wsError(400, "المدة المخططة يجب أن تكون بين دقيقة و14400 دقيقة.", "Planned minutes must be a whole number from 1 to 14400.", "PLANNED_MINUTES_INVALID");
  const plannedMinutes = pm;
  const rec = parseRecurrence(b);

  const ctx = await teamCtx(prisma, actor);
  await assertAssignable(prisma, actor, ctx, assigneeId);
  if (reviewerId) {
    const r = await prisma.employee.findUnique({ where: { id: reviewerId }, select: { active: true } });
    if (!r?.active) throw wsError(400, "المراجع غير موجود أو حسابه معطّل.", "The reviewer does not exist or is disabled.", "REVIEWER_INVALID");
  }
  const links = await resolveLinks(prisma, actor, b);
  if (kind === "FOLLOW_UP") await assertFollowUpAssignee(prisma, assigneeId, links);
  const { dueAt, dueBasis } = await resolveDue(prisma, b, now);
  const settings = await getSettings(prisma);

  return prisma.$transaction(async (tx) => {
    const t = await tx.workTask.create({
      data: {
        kind, title, description: str(b.description, LIMITS.description), priority, assigneeId, createdById: actor.id,
        dueAt, dueBasis, plannedStartAt: plannedStartAt && !Number.isNaN(plannedStartAt.getTime()) ? plannedStartAt : null, plannedMinutes,
        requiresReview, reviewerId, channel,
        remindBeforeMinutes: remind === undefined ? settings.defaultRemindBeforeMinutes : remind,
        ...links, ...rec,
        checklist: { create: checklist.map((label, position) => ({ label, position })) },
        watchers: { create: watcherIds.map((employeeId) => ({ employeeId })) },
      },
      select: { id: true },
    });
    if (rec.recurRule) await tx.workTask.update({ where: { id: t.id }, data: { seriesId: t.id } });
    await event(tx, t.id, actor.id, "CREATED", { assigneeId, dueAt: dueAt.toISOString(), dueBasis, priority, kind });
    await planTaskReminders(tx, t.id, now);
    if (assigneeId !== actor.id) {
      await notify(tx, {
        event: "me.task_assigned", dedupeKey: `${t.id}:assigned:${assigneeId}`, actorId: actor.id, people: { assignee: assigneeId },
        entity: { type: "WorkTask", id: t.id }, facts: { title, by: actor.name ?? null, priority, taskId: t.id, ...dueTexts(dueAt) },
      });
    }
    return present((await load(tx, t.id))!, actor, ctx, now);
  }, TX_OPTS);
}

// ── Read ────────────────────────────────────────────────────────────────────────────────

export async function getTask(actor: WsActor, id: string, now = new Date()) {
  const ctx = await teamCtx(prisma, actor);
  const t = await loadVisible(prisma, actor, id, ctx);
  const [checklist, comments, events] = await Promise.all([
    prisma.workTaskChecklistItem.findMany({ where: { taskId: id }, orderBy: { position: "asc" } }),
    prisma.workTaskComment.findMany({ where: { taskId: id }, orderBy: { createdAt: "asc" }, take: 200, select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true } } } }),
    prisma.workTaskEvent.findMany({ where: { taskId: id }, orderBy: { at: "desc" }, take: 100 }),
  ]);
  const actorIds = [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x))];
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  return { task: present(t, actor, ctx, now), checklist, comments, history: events.map((e) => ({ ...e, actorName: e.actorId ? names.get(e.actorId) ?? null : null })) };
}

export type ListQuery = { scope?: string | null; status?: string | null; priority?: string | null; due?: string | null; q?: string | null; member?: string | null; cursor?: string | null; limit?: number };

/**
 * The task lists. scope: mine (assigned to me, default) · assigned (I asked others) · watching · review
 * (waiting for my review) · team (my team's, team rights) · member (one colleague, team rights).
 * status: open (default) · done · cancelled · all · a status. due: overdue · today · week · later.
 * Ordered by deadline; keyset-paginated on (dueAt, id).
 */
export async function listTasks(actor: WsActor, q: ListQuery, now = new Date()) {
  const ctx = await teamCtx(prisma, actor);
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const scope = q.scope ?? "mine";
  const where: PrismaNS.WorkTaskWhereInput[] = [visibleTasksWhere(actor.id, ctx)];
  if (scope === "mine") where.push({ assigneeId: actor.id });
  else if (scope === "assigned") where.push({ createdById: actor.id, assigneeId: { not: actor.id } });
  else if (scope === "watching") where.push({ watchers: { some: { employeeId: actor.id } } });
  else if (scope === "review") where.push({ status: "IN_REVIEW", OR: [{ reviewerId: actor.id }, { reviewerId: null, createdById: actor.id }] });
  else if (scope === "team" || scope === "member") {
    if (!ctx.teamView && !ctx.assignAny && ctx.directReports.size === 0) throw forbidden();
    const member = idOrNull(q.member);
    if (scope === "member") {
      if (!member) throw wsError(400, "حدّد الموظف.", "member is required.", "MEMBER_REQUIRED");
      if (!ctx.teamView && !ctx.assignAny && !ctx.directReports.has(member)) throw forbidden();
      where.push({ assigneeId: member });
    } else if (!ctx.teamView && !ctx.assignAny) where.push({ assigneeId: { in: [...ctx.directReports] } });
  }
  const st = q.status ?? "open";
  if (st === "open") where.push({ status: { in: OPEN_STATUSES } });
  else if (st === "done") where.push({ status: "DONE" });
  else if (st === "cancelled") where.push({ status: "CANCELLED" });
  else if (st !== "all" && (OPEN_STATUSES as string[]).includes(st)) where.push({ status: st });
  if (q.priority && (PRIORITIES as readonly string[]).includes(q.priority)) where.push({ priority: q.priority });
  if (q.due === "overdue") where.push({ dueAt: { lt: now }, status: { in: OPEN_STATUSES } });
  else if (q.due === "today") {
    const { startOfRiyadhDay } = await import("../time");
    const start = startOfRiyadhDay(now);
    where.push({ dueAt: { gte: start, lt: new Date(start.getTime() + 86_400_000) } });
  } else if (q.due === "week") where.push({ dueAt: { gte: now, lt: new Date(now.getTime() + 7 * 86_400_000) } });
  const text = str(q.q, 100);
  if (text) where.push({ OR: [{ title: { contains: text, mode: "insensitive" } }, { description: { contains: text, mode: "insensitive" } }, { customer: { name: { contains: text, mode: "insensitive" } } }] });
  if (q.cursor) {
    const [iso, id] = q.cursor.split("|");
    const at = new Date(iso);
    if (!Number.isNaN(at.getTime()) && id) where.push({ OR: [{ dueAt: { gt: at } }, { dueAt: at, id: { gt: id } }] });
  }
  const rows = await prisma.workTask.findMany({ where: { AND: where }, select: DETAIL, orderBy: [{ dueAt: "asc" }, { id: "asc" }], take: limit + 1 });
  const more = rows.length > limit;
  const items = (more ? rows.slice(0, limit) : rows).map((t) => present(t, actor, ctx, now));
  const last = items[items.length - 1];
  return { items, next: more && last ? `${last.dueAt.toISOString()}|${last.id}` : null };
}

// ── Change ──────────────────────────────────────────────────────────────────────────────

/** `version`: required for a write that replaces what the person saw; NO_VERSION for an append (comment, checklist tick, snooze). */
const NO_VERSION = Symbol("no-version");
async function mutate<T>(actor: WsActor, id: string, version: unknown, action: TaskAction, fn: (tx: Tx, t: Row, ctx: TeamCtx) => Promise<T>) {
  const ctx = await teamCtx(prisma, actor);
  return prisma.$transaction(async (tx) => {
    await lockTask(tx, id);
    const t = await loadVisible(tx, actor, id, ctx);
    if (!canDo(action, rolesOf(actor.id, t, ctx), { simpleMode: simple(), hasReviewer: !!t.reviewerId })) throw forbidden();
    if (version !== NO_VERSION && requireVersion(version) !== t.version) throw stale();
    return fn(tx, t, ctx);
  }, TX_OPTS);
}

/** Edit what was asked (title, description, priority, deadline, reminder, review, links). */
export async function updateTask(actor: WsActor, id: string, b: Body, now = new Date()) {
  return mutate(actor, id, b.version, "edit", async (tx, t, ctx) => {
    if (!OPEN_STATUSES.includes(t.status as never)) throw wsError(409, "لا تُعدّل مهمة مكتملة أو ملغاة.", "A closed task cannot be edited.", "CLOSED");
    const data: PrismaNS.WorkTaskUpdateInput = { version: { increment: 1 } };
    const changed: Record<string, unknown> = {};
    if (b.title !== undefined) { const v = str(b.title, LIMITS.title); if (!v) throw wsError(400, "اكتب عنوان المهمة.", "A title is required.", "TITLE_REQUIRED"); data.title = v; changed.title = v; }
    if (b.description !== undefined) { data.description = str(b.description, LIMITS.description); changed.description = true; }
    if (b.priority !== undefined) {
      if (typeof b.priority !== "string" || !(PRIORITIES as readonly string[]).includes(b.priority)) throw wsError(400, "أولوية غير معروفة.", "Unknown priority.", "PRIORITY_INVALID");
      data.priority = b.priority; changed.priority = b.priority;
    }
    let dueChanged = false;
    if (b.dueAt !== undefined || b.due !== undefined) {
      const d = await resolveDue(tx, b, now);
      if (d.dueAt.getTime() !== t.dueAt.getTime()) {
        data.dueAt = d.dueAt; data.dueBasis = d.dueBasis; dueChanged = true;
        changed.dueAt = { from: t.dueAt.toISOString(), to: d.dueAt.toISOString() };
      }
    }
    if (b.remindBeforeMinutes !== undefined) {
      data.remindBeforeMinutes = b.remindBeforeMinutes === null ? null : Math.min(Math.max(Math.floor(Number(b.remindBeforeMinutes) || 0), 0), 10080);
      changed.remindBeforeMinutes = data.remindBeforeMinutes;
    }
    if (b.requiresReview !== undefined) {
      if (t.status === "IN_REVIEW") throw wsError(409, "المهمة بانتظار المراجعة الآن.", "The task is in review.", "IN_REVIEW");
      data.requiresReview = b.requiresReview === true;
      const rid = data.requiresReview ? idOrNull(b.reviewerId) : null;
      if (rid && rid === t.assigneeId) throw wsError(400, "المراجع يجب أن يكون شخصًا غير المسؤول عن التنفيذ.", "The reviewer must be someone other than the assignee.", "REVIEWER_IS_ASSIGNEE");
      data.reviewer = rid ? { connect: { id: rid } } : { disconnect: true };
      changed.review = { requiresReview: data.requiresReview, reviewerId: rid };
    }
    if (["customerId", "leadId", "opportunityId", "refType", "refId", "refLabel", "occasionId"].some((k) => b[k] !== undefined)) {
      const l = await resolveLinks(tx, actor, { customerId: t.customerId, leadId: t.leadId, opportunityId: t.opportunityId, refType: t.refType, refId: t.refId, refLabel: t.refLabel, occasionId: t.occasionId, ...b });
      if (t.kind === "FOLLOW_UP") await assertFollowUpAssignee(tx, t.assigneeId, l);
      Object.assign(data, {
        customer: l.customerId ? { connect: { id: l.customerId } } : { disconnect: true },
        lead: l.leadId ? { connect: { id: l.leadId } } : { disconnect: true },
        opportunity: l.opportunityId ? { connect: { id: l.opportunityId } } : { disconnect: true },
        occasion: l.occasionId ? { connect: { id: l.occasionId } } : { disconnect: true },
        refType: l.refType, refId: l.refId, refLabel: l.refLabel,
      });
      changed.links = l;
    }
    await tx.workTask.update({ where: { id }, data });
    await event(tx, id, actor.id, dueChanged ? "DUE_CHANGED" : "UPDATED", changed);
    await planTaskReminders(tx, id, now);
    if (dueChanged && t.assigneeId !== actor.id) {
      const nd = (data.dueAt as Date);
      await notify(tx, {
        event: "me.task_updated", dedupeKey: `${id}:due:${nd.toISOString()}`, actorId: actor.id, people: { recipient: t.assigneeId },
        entity: { type: "WorkTask", id }, facts: { change: "DUE_CHANGED", title: t.title, by: actor.name ?? null, taskId: id, ...dueTexts(nd) },
      });
    }
    return present((await load(tx, id))!, actor, ctx, now);
  });
}

/** A status change. Body: { action, version, reason? / note? }. */
export async function transitionTask(actor: WsActor, id: string, b: Body, now = new Date()) {
  const action = String(b.action ?? "") as TaskAction;
  if (!["start", "hold", "resume", "complete", "approve_review", "return", "cancel"].includes(action)) throw wsError(400, "إجراء غير معروف.", "Unknown action.", "ACTION_INVALID");
  return mutate(actor, id, b.version, action, async (tx, t, ctx) => {
    const to = nextStatus(action, t);
    if (!to) throw wsError(409, "لا يمكن تنفيذ هذا الإجراء على المهمة في حالتها الحالية.", "This action does not apply to the task's current status.", "TRANSITION_INVALID");
    if (t.kind === "FOLLOW_UP" && action === "complete") throw wsError(409, "متابعة العميل تكتمل بتسجيل النتيجة.", "A follow-up is completed by recording its result.", "RESULT_REQUIRED");
    const reason = str(b.reason ?? b.note, LIMITS.holdReason);
    if ((action === "hold" || action === "cancel" || action === "return") && !reason) {
      throw wsError(400, action === "hold" ? "اذكر سبب التوقف." : action === "cancel" ? "اذكر سبب الإلغاء." : "اذكر ما يلزم إكماله.", "A reason is required.", "REASON_REQUIRED");
    }
    const data: PrismaNS.WorkTaskUpdateInput = { status: to, version: { increment: 1 } };
    if (action === "start") data.startedAt = t.startedAt ?? now;
    if (action === "hold") data.holdReason = reason;
    if (action === "resume") data.holdReason = null;
    if (to === "IN_REVIEW") data.submittedAt = now;
    if (to === "DONE") { data.completedAt = now; data.completedById = action === "approve_review" ? t.assigneeId : actor.id; }
    if (action === "cancel") { data.cancelledAt = now; data.cancelledById = actor.id; data.cancelReason = reason; }
    if (to === "IN_PROGRESS" && !t.startedAt) data.startedAt = now;
    await tx.workTask.update({ where: { id }, data });
    await event(tx, id, actor.id, action === "approve_review" ? "REVIEW_APPROVED" : action === "return" ? "REVIEW_RETURNED" : action === "cancel" ? "CANCELLED" : "STATUS", { from: t.status, to, reason, late: to === "DONE" ? now > t.dueAt : undefined });
    await planTaskReminders(tx, id, now);
    await afterTransition(tx, actor, t, to, action, reason, now);
    if (to === "DONE") await spawnNextOccurrence(tx, t, now);
    return present((await load(tx, id))!, actor, ctx, now);
  });
}

async function afterTransition(tx: Tx, actor: WsActor, t: Row, to: string, action: string, reason: string | null, now: Date) {
  const base = { actorId: actor.id, entity: { type: "WorkTask", id: t.id } };
  const facts = { title: t.title, by: actor.name ?? null, taskId: t.id, note: reason };
  if (to === "IN_REVIEW") {
    const reviewer = t.reviewerId ?? t.createdById;
    if (reviewer !== actor.id) await notify(tx, { ...base, event: "me.task_review", dedupeKey: `${t.id}:review:${now.toISOString()}`, people: { reviewer }, facts });
  } else if (to === "DONE" && t.createdById !== t.assigneeId) {
    await notify(tx, { ...base, event: "me.task_updated", dedupeKey: `${t.id}:DONE`, people: { recipient: [t.createdById, action === "approve_review" ? t.assigneeId : null] }, facts: { ...facts, change: "DONE" } });
  } else if (action === "return") {
    await notify(tx, { ...base, event: "me.task_updated", dedupeKey: `${t.id}:RETURNED:${now.toISOString()}`, people: { recipient: t.assigneeId }, facts: { ...facts, change: "RETURNED" } });
  } else if (action === "cancel") {
    await notify(tx, { ...base, event: "me.task_updated", dedupeKey: `${t.id}:CANCELLED`, people: { recipient: [t.assigneeId, t.createdById] }, facts: { ...facts, change: "CANCELLED" } });
  } else if (action === "hold" && t.createdById !== t.assigneeId) {
    await notify(tx, { ...base, event: "me.task_updated", dedupeKey: `${t.id}:ON_HOLD:${now.toISOString()}`, people: { recipient: t.createdById }, facts: { ...facts, change: "ON_HOLD" } });
  }
}

/** A recurring task, once done, creates its next occurrence (unique per series: never twice). */
async function spawnNextOccurrence(tx: Tx, t: Row, now: Date) {
  if (!t.recurRule || !t.recurInterval) return;
  const due = nextOccurrence(t.dueAt, t.recurRule as "DAILY" | "WEEKLY" | "MONTHLY", t.recurInterval);
  if (t.recurUntil && due > t.recurUntil) return;
  const seriesId = t.seriesId ?? t.id;
  const exists = await tx.workTask.findUnique({ where: { seriesId_occurrence: { seriesId, occurrence: t.occurrence + 1 } }, select: { id: true } });
  if (exists) return;
  const checklist = await tx.workTaskChecklistItem.findMany({ where: { taskId: t.id }, orderBy: { position: "asc" }, select: { label: true, position: true } });
  const n = await tx.workTask.create({
    data: {
      kind: t.kind, title: t.title, description: t.description, priority: t.priority, assigneeId: t.assigneeId, createdById: t.createdById,
      dueAt: due, dueBasis: "EXACT", requiresReview: t.requiresReview, reviewerId: t.reviewerId, remindBeforeMinutes: t.remindBeforeMinutes, channel: t.channel,
      customerId: t.customerId, leadId: t.leadId, opportunityId: t.opportunityId, refType: t.refType, refId: t.refId, refLabel: t.refLabel, occasionId: t.occasionId,
      recurRule: t.recurRule, recurInterval: t.recurInterval, recurUntil: t.recurUntil, seriesId, occurrence: t.occurrence + 1,
      checklist: { create: checklist },
      watchers: { create: t.watchers.map((w) => ({ employeeId: w.employeeId })) },
    },
    select: { id: true },
  });
  if (!t.seriesId) await tx.workTask.update({ where: { id: t.id }, data: { seriesId } });
  await event(tx, n.id, null, "CREATED", { recurrenceOf: t.id, occurrence: t.occurrence + 1, dueAt: due.toISOString() });
  await planTaskReminders(tx, n.id, now);
}

/** Give the work to someone else (the asker, the manager, an assign_any holder). */
export async function reassignTask(actor: WsActor, id: string, b: Body, now = new Date()) {
  const to = idOrNull(b.assigneeId);
  if (!to) throw wsError(400, "اختر الموظف.", "assigneeId is required.", "ASSIGNEE_REQUIRED");
  return mutate(actor, id, b.version, "reassign", async (tx, t, ctx) => {
    if (!OPEN_STATUSES.includes(t.status as never)) throw wsError(409, "لا تُعاد مهمة مكتملة أو ملغاة.", "A closed task cannot be reassigned.", "CLOSED");
    if (to === t.assigneeId) return present(t, actor, ctx, now);
    await assertAssignable(tx, actor, ctx, to);
    if (t.reviewerId === to) throw wsError(400, "المراجع لا يكون المسؤول عن التنفيذ.", "The reviewer cannot be the assignee.", "REVIEWER_IS_ASSIGNEE");
    if (t.kind === "FOLLOW_UP") await assertFollowUpAssignee(tx, to, { customerId: t.customerId, leadId: t.leadId, opportunityId: t.opportunityId, refType: null, refId: null, refLabel: null, occasionId: null });
    const note = str(b.note, 500);
    await tx.workTask.update({ where: { id }, data: { assigneeId: to, version: { increment: 1 } } });
    await event(tx, id, actor.id, "REASSIGNED", { from: t.assigneeId, to, note });
    await planTaskReminders(tx, id, now);
    await notify(tx, {
      event: "me.task_assigned", dedupeKey: `${id}:assigned:${to}:${now.toISOString()}`, actorId: actor.id, people: { assignee: to },
      entity: { type: "WorkTask", id }, facts: { title: t.title, by: actor.name ?? null, priority: t.priority, taskId: id, ...dueTexts(t.dueAt) },
    });
    return present((await load(tx, id))!, actor, ctx, now);
  });
}

/** Reassign several tasks at once (team view: an absent or disabled colleague's open work). */
export async function bulkReassign(actor: WsActor, b: Body, now = new Date()) {
  // Body: { tasks: [{ id, version }], assigneeId, note? } — each task carries the version the manager saw.
  const items = Array.isArray(b.tasks)
    ? (b.tasks as unknown[]).flatMap((x) => { const r = x as Body | null; const id = idOrNull(r?.id); return id ? [{ id, version: r!.version }] : []; }).slice(0, 100)
    : [];
  if (!items.length) throw wsError(400, "اختر المهام.", "tasks is required.", "TASKS_REQUIRED");
  const done: string[] = [], refused: { id: string; code: string }[] = [];
  for (const { id, version } of items) {
    try {
      await reassignTask(actor, id, { assigneeId: b.assigneeId, note: b.note, version }, now);
      done.push(id);
    } catch (e) {
      refused.push({ id, code: (e as { code?: string })?.code ?? "ERROR" });
    }
  }
  return { reassigned: done, refused };
}

export async function addComment(actor: WsActor, id: string, b: Body) {
  const body = str(b.body, LIMITS.comment);
  if (!body) throw wsError(400, "اكتب التعليق.", "A comment is required.", "COMMENT_REQUIRED");
  return mutate(actor, id, NO_VERSION, "comment", async (tx, t) => {
    const c = await tx.workTaskComment.create({ data: { taskId: id, authorId: actor.id, body }, select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true } } } });
    await event(tx, id, actor.id, "COMMENTED", { commentId: c.id });
    const others = [t.assigneeId, t.createdById, t.reviewerId].filter((x): x is string => !!x && x !== actor.id);
    if (others.length) {
      await notify(tx, { event: "me.task_updated", dedupeKey: `${id}:comment:${c.id}`, actorId: actor.id, people: { recipient: others }, entity: { type: "WorkTask", id }, facts: { change: "COMMENT", title: t.title, by: actor.name ?? null, note: body.slice(0, 140), taskId: id } });
    }
    return c;
  });
}

/** Checklist: { add: label } · { toggle: itemId, done } · { remove: itemId }. */
export async function changeChecklist(actor: WsActor, id: string, b: Body, now = new Date()) {
  return mutate(actor, id, NO_VERSION, "checklist", async (tx, t) => {
    if (!OPEN_STATUSES.includes(t.status as never)) throw wsError(409, "المهمة مغلقة.", "The task is closed.", "CLOSED");
    if (b.add !== undefined) {
      const label = str(b.add, LIMITS.checklistLabel);
      if (!label) throw wsError(400, "اكتب البند.", "A label is required.", "LABEL_REQUIRED");
      const n = await tx.workTaskChecklistItem.count({ where: { taskId: id } });
      if (n >= LIMITS.checklist) throw wsError(400, "بلغت القائمة حدها.", "Checklist is full.", "CHECKLIST_FULL");
      await tx.workTaskChecklistItem.create({ data: { taskId: id, label, position: n } });
    } else if (typeof b.toggle === "string") {
      const r = await tx.workTaskChecklistItem.updateMany({ where: { id: b.toggle, taskId: id }, data: b.done === true ? { doneAt: now, doneById: actor.id } : { doneAt: null, doneById: null } });
      if (!r.count) throw notFound();
    } else if (typeof b.remove === "string") {
      const r = await tx.workTaskChecklistItem.deleteMany({ where: { id: b.remove, taskId: id } });
      if (!r.count) throw notFound();
    } else throw wsError(400, "طلب غير مفهوم.", "Nothing to do.", "CHECKLIST_INVALID");
    await event(tx, id, actor.id, "CHECKLIST", { add: b.add ?? undefined, toggle: b.toggle ?? undefined, done: b.done ?? undefined, remove: b.remove ?? undefined });
    return tx.workTaskChecklistItem.findMany({ where: { taskId: id }, orderBy: { position: "asc" } });
  });
}

/** «ذكّرني بعد …» — a reminder later; the deadline is not touched. */
export async function snooze(actor: WsActor, id: string, b: Body, now = new Date()) {
  const minutes = Math.floor(Number(b.minutes));
  if (![15, 30, 60, 120, 240, 1440].includes(minutes)) throw wsError(400, "مدة غير مدعومة.", "Unsupported duration.", "SNOOZE_INVALID");
  return mutate(actor, id, NO_VERSION, "snooze", async (tx, t) => {
    const at = await snoozeTask(tx, id, actor.id, minutes, now);
    if (!at) throw wsError(409, "المهمة مغلقة.", "The task is closed.", "CLOSED");
    await event(tx, id, actor.id, "REMINDER_SNOOZED", { until: at.toISOString(), dueAt: t.dueAt.toISOString() });
    return { remindAt: at.toISOString(), dueAt: t.dueAt.toISOString() };
  });
}

// ── A follow-up's result ────────────────────────────────────────────────────────────────

const CHANNEL_TYPE: Record<string, string> = { CALL: "CALL", VISIT: "VISIT", MEETING: "MEETING" };

/**
 * «تسجيل النتيجة»: the outcome goes to the customer / lead / deal timeline as a CRM activity written by
 * the assignee under the CRM's own rules (lib/services/sales/activity-log.ts — scope, qualification), the
 * task is completed, and — when asked — the next step becomes the next follow-up. One transaction.
 * Body: { version, outcome, note?, next?: { dueAt | due, channel?, title? } }.
 */
export async function recordResult(actor: WsActor, id: string, b: Body, now = new Date()) {
  const outcome = typeof b.outcome === "string" && (ACTIVITY_OUTCOMES as string[]).includes(b.outcome) ? b.outcome : null;
  if (!outcome) throw wsError(400, "اختر نتيجة المتابعة.", "An outcome is required.", "OUTCOME_REQUIRED");
  const note = str(b.note, 2000);
  const next = b.next && typeof b.next === "object" ? (b.next as Body) : null;
  const nextDue = next ? await resolveDue(prisma, next, now) : null;
  return mutate(actor, id, b.version, "complete", async (tx, t, ctx) => {
    if (t.kind !== "FOLLOW_UP") throw wsError(409, "هذه ليست متابعة عميل.", "Not a follow-up.", "NOT_FOLLOW_UP");
    if (!["NOT_STARTED", "IN_PROGRESS"].includes(t.status)) throw wsError(409, "لا يمكن تسجيل النتيجة في حالة المهمة الحالية.", "The result cannot be recorded in this status.", "TRANSITION_INVALID");
    const parsed = parseActivity({
      type: CHANNEL_TYPE[t.channel ?? "CALL"] ?? "CALL", subject: t.title, body: note, outcome, completed: true,
      leadId: t.leadId, opportunityId: t.opportunityId,
    });
    const writer = { id: actor.id, permissions: actor.permissions };
    if (!mayLogActivity(actor.permissions, !t.leadId && !t.opportunityId)) throw forbidden("تسجيل النتيجة يحتاج صلاحية تسجيل الأنشطة في المبيعات.");
    const logged = t.leadId || t.opportunityId ? await logLeadOrDealActivity(tx, writer, parsed) : await logCustomerActivity(tx, writer, t.customerId!, parsed);
    const to = t.requiresReview ? "IN_REVIEW" : "DONE";
    await tx.workTask.update({
      where: { id },
      data: { status: to, resultActivityId: logged.activity.id, version: { increment: 1 }, startedAt: t.startedAt ?? now, ...(to === "DONE" ? { completedAt: now, completedById: actor.id } : { submittedAt: now }) },
    });
    await event(tx, id, actor.id, "RESULT_RECORDED", { outcome, activityId: logged.activity.id, to, late: now > t.dueAt });
    await planTaskReminders(tx, id, now);
    await afterTransition(tx, actor, t, to, "complete", null, now);
    let nextTaskId: string | null = null;
    if (next && nextDue) {
      const channel = typeof next.channel === "string" && CHANNEL_TYPE[next.channel] ? next.channel : t.channel;
      const n = await tx.workTask.create({
        data: {
          kind: "FOLLOW_UP", title: str(next.title, LIMITS.title) ?? t.title, priority: t.priority, assigneeId: actor.id, createdById: actor.id,
          dueAt: nextDue.dueAt, dueBasis: nextDue.dueBasis, channel, remindBeforeMinutes: t.remindBeforeMinutes,
          customerId: t.customerId, leadId: t.leadId, opportunityId: t.opportunityId,
        },
        select: { id: true },
      });
      nextTaskId = n.id;
      await event(tx, n.id, actor.id, "CREATED", { previousFollowUp: id, dueAt: nextDue.dueAt.toISOString() });
      await planTaskReminders(tx, n.id, now);
    }
    // The task just closed and the next one (if any) opened: the lead's next follow-up follows them.
    if (t.leadId) await syncLeadNextFollowUp(tx, t.leadId);
    return { task: present((await load(tx, id))!, actor, ctx, now), activityId: logged.activity.id, nextTaskId, qualification: "qualification" in logged ? logged.qualification : null };
  });
}
