// «مساحة عملي» — appointments: time actually reserved (meeting, visit, call). Ending is not the activity
// done: the result is recorded explicitly (a CRM activity when linked to a customer / lead / deal).
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { notify } from "@/lib/notifications/notify";
import { seesAllSales } from "@/lib/services/sales/scope";
import { mayLogActivity, parseActivity, logCustomerActivity, logLeadOrDealActivity } from "@/lib/services/sales/activity-log";
import { ACTIVITY_OUTCOMES } from "@/lib/services/sales/qualification";
import { nextOccurrence, riyadhDay } from "../time";
import { dueTexts, forbidden, notFound, requireVersion, seesCustomers, stale, teamCtx, visibleTasksWhere, wsError, type WsActor } from "./context";
import { planAppointmentReminders } from "./reminders";

type Tx = PrismaNS.TransactionClient;
type Body = Record<string, unknown>;

const KINDS = ["MEETING", "VISIT", "CALL", "OTHER"];
const MAX_PARTICIPANTS = 30;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const idOrNull = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
const date = (v: unknown) => {
  const d = typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

const SELECT = {
  id: true, kind: true, title: true, notes: true, startAt: true, endAt: true, location: true, meetingUrl: true, externalAttendees: true,
  organizerId: true, status: true, customerId: true, leadId: true, opportunityId: true, taskId: true, remindBeforeMinutes: true,
  recurRule: true, recurInterval: true, recurUntil: true, seriesId: true, occurrence: true, outcomeActivityId: true,
  cancelledAt: true, cancelReason: true, version: true, createdAt: true, updatedAt: true,
  organizer: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true } },
  lead: { select: { id: true, companyName: true } },
  opportunity: { select: { id: true, title: true } },
  participants: { select: { employeeId: true, employee: { select: { name: true } } } },
} satisfies PrismaNS.WorkAppointmentSelect;
type Row = PrismaNS.WorkAppointmentGetPayload<{ select: typeof SELECT }>;

const involved = (a: { organizerId: string; participants: { employeeId: string }[] }, id: string) => a.organizerId === id || a.participants.some((p) => p.employeeId === id);

/**
 * A manager (or team_view) who is neither the organiser nor a participant sees that the person is busy —
 * the time and the kind — never who else attends, the notes, the link, the outside attendees, the place or the customer.
 */
function busyOnly(a: Row): Row {
  return { ...a, title: "مشغول", participants: [], notes: null, location: null, meetingUrl: null, externalAttendees: null, customerId: null, leadId: null, opportunityId: null, taskId: null, customer: null, lead: null, opportunity: null, outcomeActivityId: null, cancelReason: null };
}

function present(raw: Row, actor: WsActor, now: Date) {
  const a = involved(raw, actor.id) ? raw : busyOnly(raw);
  const mine = a.organizerId === actor.id;
  const open = a.status === "SCHEDULED";
  return {
    ...a,
    past: a.endAt.getTime() < now.getTime(),
    actions: [
      ...(mine && open ? ["edit", "cancel"] : []),
      ...(involved(a, actor.id) && open && (a.customerId || a.leadId || a.opportunityId) ? ["record_result"] : []),
      ...(involved(a, actor.id) && open && !(a.customerId || a.leadId || a.opportunityId) ? ["mark_done"] : []),
    ],
  };
}

async function visible(actor: WsActor, id: string): Promise<Row> {
  const a = await prisma.workAppointment.findUnique({ where: { id }, select: SELECT });
  if (!a) throw notFound();
  if (involved(a, actor.id)) return a;
  const ctx = await teamCtx(prisma, actor);
  if (ctx.teamView || [a.organizerId, ...a.participants.map((p) => p.employeeId)].some((p) => ctx.directReports.has(p))) return a;
  throw notFound();
}

async function parse(actor: WsActor, b: Body, cur?: Row) {
  const kind = typeof b.kind === "string" && KINDS.includes(b.kind) ? b.kind : cur?.kind ?? "MEETING";
  const title = b.title !== undefined ? str(b.title, 300) : cur?.title ?? null;
  if (!title) throw wsError(400, "اكتب عنوان الموعد.", "A title is required.", "TITLE_REQUIRED");
  const startAt = b.startAt !== undefined ? date(b.startAt) : cur?.startAt ?? null;
  const endAt = b.endAt !== undefined ? date(b.endAt) : cur?.endAt ?? null;
  if (!startAt || !endAt) throw wsError(400, "حدّد وقت البداية والنهاية.", "Start and end are required.", "TIME_REQUIRED");
  if (endAt <= startAt) throw wsError(400, "النهاية يجب أن تكون بعد البداية.", "End must be after start.", "TIME_ORDER");
  if (endAt.getTime() - startAt.getTime() > 7 * 86_400_000) throw wsError(400, "الموعد أطول من أسبوع.", "Longer than a week.", "TOO_LONG");
  const meetingUrl = b.meetingUrl !== undefined ? str(b.meetingUrl, 500) : cur?.meetingUrl ?? null;
  if (meetingUrl && !/^https:\/\//i.test(meetingUrl)) throw wsError(400, "رابط الاجتماع يجب أن يبدأ بـ https://", "The meeting link must start with https://", "URL_INVALID");
  const participants = Array.isArray(b.participantIds)
    ? [...new Set(b.participantIds.map(idOrNull).filter((x): x is string => !!x && x !== actor.id))].slice(0, MAX_PARTICIPANTS)
    : cur ? cur.participants.map((p) => p.employeeId) : [];
  if (participants.length) {
    const n = await prisma.employee.count({ where: { id: { in: participants }, active: true } });
    if (n !== participants.length) throw wsError(400, "أحد المشاركين غير موجود أو حسابه معطّل.", "A participant does not exist or is disabled.", "PARTICIPANT_INVALID");
  }
  // Links: must exist and be visible to the organiser (as for tasks).
  const scopeAll = seesAllSales(actor.permissions);
  const customerId = b.customerId !== undefined ? idOrNull(b.customerId) : cur?.customerId ?? null;
  const leadId = b.leadId !== undefined ? idOrNull(b.leadId) : cur?.leadId ?? null;
  const opportunityId = b.opportunityId !== undefined ? idOrNull(b.opportunityId) : cur?.opportunityId ?? null;
  if (customerId && b.customerId !== undefined && !seesCustomers(actor)) throw notFound();
  if (customerId && b.customerId !== undefined && !(await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } }))) throw notFound();
  if (leadId && b.leadId !== undefined && !(await prisma.lead.findFirst({ where: { id: leadId, ...(scopeAll ? {} : { ownerId: actor.id }) }, select: { id: true } }))) throw notFound();
  if (opportunityId && b.opportunityId !== undefined && !(await prisma.opportunity.findFirst({ where: { id: opportunityId, ...(scopeAll ? {} : { ownerId: actor.id }) }, select: { id: true } }))) throw notFound();
  // A linked task must be one the organiser can see — not a way to probe others' work.
  const taskId = b.taskId !== undefined ? idOrNull(b.taskId) : cur?.taskId ?? null;
  if (taskId && b.taskId !== undefined) {
    const ctx = await teamCtx(prisma, actor);
    if (!(await prisma.workTask.findFirst({ where: { AND: [{ id: taskId }, visibleTasksWhere(actor.id, ctx)] }, select: { id: true } }))) throw notFound();
  }
  const remind = b.remindBeforeMinutes === null ? null : b.remindBeforeMinutes !== undefined ? Math.min(Math.max(Math.floor(Number(b.remindBeforeMinutes) || 0), 0), 10080) : cur ? cur.remindBeforeMinutes : 30;
  return {
    kind, title, startAt, endAt, meetingUrl, participants, customerId, leadId, opportunityId, remindBeforeMinutes: remind,
    notes: b.notes !== undefined ? str(b.notes, 4000) : cur?.notes ?? null,
    location: b.location !== undefined ? str(b.location, 300) : cur?.location ?? null,
    externalAttendees: b.externalAttendees !== undefined ? str(b.externalAttendees, 500) : cur?.externalAttendees ?? null,
    taskId,
  };
}

/**
 * Clashes for the people of an appointment in [start, end): their other appointments and their leave
 * (approved / pending). Details only for what the viewer may see (themself, their team or team_view);
 * anyone else is reported as «مشغول» without the title.
 */
export async function conflicts(actor: WsActor, people: string[], startAt: Date, endAt: Date, exceptId?: string | null) {
  const ctx = await teamCtx(prisma, actor);
  const seeAll = ctx.teamView;
  const may = (id: string) => seeAll || id === actor.id || ctx.directReports.has(id);
  const ids = [...new Set(people)];
  const appts = await prisma.workAppointment.findMany({
    where: {
      status: "SCHEDULED", startAt: { lt: endAt }, endAt: { gt: startAt }, ...(exceptId ? { id: { not: exceptId } } : {}),
      OR: [{ organizerId: { in: ids } }, { participants: { some: { employeeId: { in: ids } } } }],
    },
    select: { id: true, title: true, startAt: true, endAt: true, organizerId: true, participants: { select: { employeeId: true } } }, take: 50,
  });
  const persons = await prisma.hrEmployee.findMany({ where: { accountId: { in: ids } }, select: { id: true, accountId: true } });
  // Leave days are calendar days (@db.Date, UTC midnight); an appointment's days are its Riyadh days.
  const dayOf = (d: Date) => new Date(`${riyadhDay(d)}T00:00:00Z`);
  const leave = persons.length ? await prisma.hrLeaveRequest.findMany({
    where: { employeeId: { in: persons.map((p) => p.id) }, status: { in: ["APPROVED", "PENDING"] }, startDate: { lte: dayOf(new Date(endAt.getTime() - 1)) }, endDate: { gte: dayOf(startAt) } },
    select: { employeeId: true, status: true, startDate: true, endDate: true },
  }) : [];
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  type Clash = { employeeId: string; name: string | null; kind: "APPOINTMENT" | "LEAVE" | "BUSY"; title: string | null; startAt: string | null; endAt: string | null };
  const out: Clash[] = [];
  for (const a of appts) {
    for (const id of ids.filter((x) => a.organizerId === x || a.participants.some((p) => p.employeeId === x))) {
      out.push({ employeeId: id, name: names.get(id) ?? null, kind: "APPOINTMENT", title: a.title, startAt: a.startAt.toISOString(), endAt: a.endAt.toISOString() });
    }
  }
  for (const l of leave) {
    const acc = persons.find((p) => p.id === l.employeeId)?.accountId;
    if (!acc) continue;
    out.push({ employeeId: acc, name: names.get(acc) ?? null, kind: "LEAVE", title: l.status === "APPROVED" ? "إجازة معتمدة" : "طلب إجازة قيد الاعتماد", startAt: l.startDate.toISOString(), endAt: l.endDate.toISOString() });
  }
  // Someone outside the viewer's team: only that they are busy then — no reason, no title, no dates.
  const seen = new Set<string>();
  return out.flatMap((c) => {
    if (may(c.employeeId)) return [c];
    if (seen.has(c.employeeId)) return [];
    seen.add(c.employeeId);
    return [{ employeeId: c.employeeId, name: c.name, kind: "BUSY" as const, title: null, startAt: null, endAt: null }];
  });
}

async function tellParticipants(tx: Tx, actor: WsActor, a: { id: string; title: string; startAt: Date; location: string | null }, people: string[], change: "INVITED" | "CHANGED" | "CANCELLED", stamp: string) {
  const to = people.filter((p) => p !== actor.id);
  if (!to.length) return;
  const w = dueTexts(a.startAt);
  await notify(tx, { event: "me.appointment", dedupeKey: `${a.id}:${change}:${stamp}`, actorId: actor.id, people: { recipient: to }, entity: { type: "WorkAppointment", id: a.id }, facts: { change, title: a.title, when: w.due, whenEn: w.dueEn, where: a.location, appointmentId: a.id } });
}

export async function createAppointment(actor: WsActor, b: Body, now = new Date()) {
  const p = await parse(actor, b);
  const rule = typeof b.recurRule === "string" && ["DAILY", "WEEKLY", "MONTHLY"].includes(b.recurRule) ? (b.recurRule as "DAILY" | "WEEKLY" | "MONTHLY") : null;
  const interval = rule ? Math.min(Math.max(Math.floor(Number(b.recurInterval) || 1), 1), 365) : null;
  const until = rule ? (typeof b.recurUntil === "string" ? new Date(b.recurUntil) : null) : null;
  // A recurring appointment is materialised up to its end (at most 52 occurrences): each one can be moved
  // or cancelled on its own, and the reminders are the ordinary per-appointment ones.
  const starts: Date[] = [p.startAt];
  if (rule && interval) {
    const limit = until && !Number.isNaN(until.getTime()) ? until : new Date(p.startAt.getTime() + 90 * 86_400_000);
    for (let s = nextOccurrence(p.startAt, rule, interval); s <= limit && starts.length < 52; s = nextOccurrence(s, rule, interval)) starts.push(s);
  }
  const span = p.endAt.getTime() - p.startAt.getTime();
  return prisma.$transaction(async (tx) => {
    let seriesId: string | null = null;
    const ids: string[] = [];
    for (const [i, s] of starts.entries()) {
      const a: { id: string; title: string; startAt: Date; location: string | null } = await tx.workAppointment.create({
        data: {
          kind: p.kind, title: p.title, notes: p.notes, startAt: s, endAt: new Date(s.getTime() + span), location: p.location, meetingUrl: p.meetingUrl,
          externalAttendees: p.externalAttendees, organizerId: actor.id, customerId: p.customerId, leadId: p.leadId, opportunityId: p.opportunityId,
          taskId: p.taskId, remindBeforeMinutes: p.remindBeforeMinutes, recurRule: rule, recurInterval: interval, recurUntil: until && !Number.isNaN(until.getTime()) ? until : null,
          seriesId, occurrence: i + 1,
          participants: { create: p.participants.map((employeeId) => ({ employeeId })) },
        },
        select: { id: true, title: true, startAt: true, location: true },
      });
      if (rule && i === 0) { seriesId = a.id; await tx.workAppointment.update({ where: { id: a.id }, data: { seriesId } }); }
      ids.push(a.id);
      await planAppointmentReminders(tx, a.id, now);
      if (i === 0) await tellParticipants(tx, actor, a, p.participants, "INVITED", "0");
    }
    const first = await tx.workAppointment.findUniqueOrThrow({ where: { id: ids[0] }, select: SELECT });
    return { appointment: present(first, actor, now), occurrences: ids.length };
  }, TX_OPTS);
}

export async function updateAppointment(actor: WsActor, id: string, b: Body, now = new Date()) {
  const cur = await visible(actor, id);
  const version = requireVersion(b.version);
  if (cur.organizerId !== actor.id) throw forbidden("يعدّل الموعد منظّمه فقط.");
  if (cur.status !== "SCHEDULED") throw wsError(409, "الموعد مغلق.", "The appointment is closed.", "CLOSED");
  const p = await parse(actor, b, cur);
  return prisma.$transaction(async (tx) => {
    const r = await tx.workAppointment.updateMany({
      where: { id, version, status: "SCHEDULED" },
      data: {
        kind: p.kind, title: p.title, notes: p.notes, startAt: p.startAt, endAt: p.endAt, location: p.location, meetingUrl: p.meetingUrl,
        externalAttendees: p.externalAttendees, customerId: p.customerId, leadId: p.leadId, opportunityId: p.opportunityId, taskId: p.taskId,
        remindBeforeMinutes: p.remindBeforeMinutes, version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw stale();
    const before = new Set(cur.participants.map((x) => x.employeeId));
    const after = new Set(p.participants);
    await tx.workAppointmentParticipant.deleteMany({ where: { appointmentId: id, employeeId: { notIn: [...after] } } });
    for (const e of after) if (!before.has(e)) await tx.workAppointmentParticipant.create({ data: { appointmentId: id, employeeId: e } });
    await planAppointmentReminders(tx, id, now);
    const moved = p.startAt.getTime() !== cur.startAt.getTime() || p.endAt.getTime() !== cur.endAt.getTime() || p.location !== cur.location;
    const a = { id, title: p.title, startAt: p.startAt, location: p.location };
    const added = [...after].filter((x) => !before.has(x));
    if (added.length) await tellParticipants(tx, actor, a, added, "INVITED", now.toISOString());
    if (moved) await tellParticipants(tx, actor, a, [...after].filter((x) => before.has(x)), "CHANGED", p.startAt.toISOString());
    const removed = [...before].filter((x) => !after.has(x));
    if (removed.length) await tellParticipants(tx, actor, a, removed, "CANCELLED", now.toISOString());
    return present(await tx.workAppointment.findUniqueOrThrow({ where: { id }, select: SELECT }), actor, now);
  }, TX_OPTS);
}

export async function cancelAppointment(actor: WsActor, id: string, b: Body, now = new Date()) {
  const cur = await visible(actor, id);
  if (cur.organizerId !== actor.id) throw forbidden("يلغي الموعد منظّمه فقط.");
  const reason = str(b.reason, 500);
  return prisma.$transaction(async (tx) => {
    const r = await tx.workAppointment.updateMany({ where: { id, status: "SCHEDULED" }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.id, cancelReason: reason, version: { increment: 1 } } });
    if (r.count !== 1) throw wsError(409, "الموعد مغلق مسبقًا.", "Already closed.", "CLOSED");
    await planAppointmentReminders(tx, id, now);
    await tellParticipants(tx, actor, cur, cur.participants.map((p) => p.employeeId), "CANCELLED", "x");
    return present(await tx.workAppointment.findUniqueOrThrow({ where: { id }, select: SELECT }), actor, now);
  }, TX_OPTS);
}

/**
 * The appointment happened. Linked to a customer / lead / deal: the outcome is recorded on its timeline
 * through the CRM's rules (as a follow-up's result); unlinked: it is only marked done.
 */
export async function completeAppointment(actor: WsActor, id: string, b: Body, now = new Date()) {
  const cur = await visible(actor, id);
  if (!involved(cur, actor.id)) throw forbidden();
  const linked = !!(cur.customerId || cur.leadId || cur.opportunityId);
  const outcome = typeof b.outcome === "string" && (ACTIVITY_OUTCOMES as string[]).includes(b.outcome) ? b.outcome : null;
  if (linked && !outcome) throw wsError(400, "اختر نتيجة الموعد.", "An outcome is required.", "OUTCOME_REQUIRED");
  return prisma.$transaction(async (tx) => {
    const r = await tx.workAppointment.updateMany({ where: { id, status: "SCHEDULED" }, data: { status: "DONE", version: { increment: 1 } } });
    if (r.count !== 1) throw wsError(409, "الموعد مغلق مسبقًا.", "Already closed.", "CLOSED");
    let activityId: string | null = null;
    if (linked) {
      if (!mayLogActivity(actor.permissions, !cur.leadId && !cur.opportunityId)) throw forbidden("تسجيل النتيجة يحتاج صلاحية تسجيل الأنشطة في المبيعات.");
      const type = cur.kind === "VISIT" ? "VISIT" : cur.kind === "CALL" ? "CALL" : "MEETING";
      const parsed = parseActivity({ type, subject: cur.title, body: str(b.note, 2000), outcome, completed: true, leadId: cur.leadId, opportunityId: cur.opportunityId });
      const w = { id: actor.id, permissions: actor.permissions };
      const logged = cur.leadId || cur.opportunityId ? await logLeadOrDealActivity(tx, w, parsed) : await logCustomerActivity(tx, w, cur.customerId!, parsed);
      activityId = logged.activity.id;
      await tx.workAppointment.update({ where: { id }, data: { outcomeActivityId: activityId } });
    }
    await planAppointmentReminders(tx, id, now);
    return { appointment: present(await tx.workAppointment.findUniqueOrThrow({ where: { id }, select: SELECT }), actor, now), activityId };
  }, TX_OPTS);
}

export async function getAppointment(actor: WsActor, id: string, now = new Date()) {
  return present(await visible(actor, id), actor, now);
}

/** Appointments in a window for the given people (the calendar's appointment layers). */
export async function appointmentsBetween(actor: WsActor, people: string[], from: Date, to: Date, now = new Date()) {
  const rows = await prisma.workAppointment.findMany({
    where: { status: { in: ["SCHEDULED", "DONE"] }, startAt: { lt: to }, endAt: { gt: from }, OR: [{ organizerId: { in: people } }, { participants: { some: { employeeId: { in: people } } } }] },
    select: SELECT, orderBy: { startAt: "asc" }, take: 1000,
  });
  return rows.map((a) => present(a, actor, now));
}
