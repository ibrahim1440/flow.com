// «مساحة عملي» — the read models of the screens: Today, the calendar layers, the team, my requests.
// Each reads only what the person may see; nothing is fetched and then hidden in the browser.
import { prisma } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";

/** Whether the viewer holds an HR leave duty (reads leave types of others). */
const hrSees = (a: WsActor) => hasModuleAccess(a.permissions, "hr") && (hasSubPrivilege(a.permissions, "hr", "leave_approve") || hasSubPrivilege(a.permissions, "hr", "leave_manage"));
import { OPEN_STATUSES } from "../rules";
import { isOverdue, riyadhDay, startOfRiyadhDay } from "../time";
import { teamCtx, type WsActor } from "./context";
import { listTasks } from "./tasks";
import { myApprovalCount, myApprovals } from "./approvals";
import { appointmentsBetween } from "./appointments";
import { listOccasions, canSeeOccasions } from "./occasions";

const DAY = 86_400_000;

/** Open CRM follow-ups owned by the person (read through; they complete in the CRM). */
async function crmFollowUps(actor: WsActor, until: Date) {
  if (!hasModuleAccess(actor.permissions, "sales") && !hasModuleAccess(actor.permissions, "customers")) return [];
  const rows = await prisma.activity.findMany({
    where: { ownerId: actor.id, completedAt: null, dueAt: { not: null, lte: until } },
    select: {
      id: true, type: true, subject: true, dueAt: true, leadId: true, opportunityId: true, customerId: true,
      lead: { select: { companyName: true } }, opportunity: { select: { title: true } }, customer: { select: { name: true } },
    },
    orderBy: { dueAt: "asc" }, take: 100,
  });
  return rows.map((a) => ({
    id: a.id, type: a.type, subject: a.subject, dueAt: a.dueAt!.toISOString(),
    record: a.customer?.name ?? a.opportunity?.title ?? a.lead?.companyName ?? null,
    openUrl: a.leadId ? `/dashboard/sales/leads/${a.leadId}` : a.opportunityId ? `/dashboard/sales/deals/${a.opportunityId}` : a.customerId ? `/dashboard/customers/${a.customerId}` : "/dashboard/sales/activities",
  }));
}

export async function today(actor: WsActor, now = new Date()) {
  const dayStart = startOfRiyadhDay(now);
  const dayEnd = new Date(dayStart.getTime() + DAY);
  const weekEnd = new Date(dayStart.getTime() + 8 * DAY);
  const [tasks, review, approvals, appts, crm] = await Promise.all([
    listTasks(actor, { scope: "mine", status: "open", limit: 200 }, now),
    listTasks(actor, { scope: "review", status: "open", limit: 50 }, now),
    myApprovals(actor),
    appointmentsBetween(actor, [actor.id], now < dayStart ? now : dayStart, weekEnd, now),
    crmFollowUps(actor, weekEnd),
  ]);
  const open = tasks.items;
  const overdue = open.filter((t) => t.overdue).length + crm.filter((a) => new Date(a.dueAt) < now).length;
  const dueToday = open.filter((t) => !t.overdue && t.dueAt < dayEnd).length + crm.filter((a) => new Date(a.dueAt) >= now && new Date(a.dueAt) < dayEnd).length;
  const todays = appts.filter((a) => a.status === "SCHEDULED" && a.startAt < dayEnd && a.endAt > dayStart);
  const next = appts.find((a) => a.status === "SCHEDULED" && a.endAt > now) ?? null;
  return {
    now: now.toISOString(),
    day: riyadhDay(now),
    counts: { overdue, dueToday, approvals: approvals.total, review: review.items.length },
    nextAppointment: next ? { id: next.id, title: next.title, kind: next.kind, startAt: next.startAt, endAt: next.endAt, location: next.location } : null,
    tasks: open,
    review: review.items,
    approvals: approvals.items.slice(0, 20),
    approvalsUnavailable: approvals.unavailable,
    crm,
    schedule: todays,
    upcoming: appts.filter((a) => a.status === "SCHEDULED" && a.startAt >= dayEnd).slice(0, 10),
  };
}

/** The count the sidebar badge shows: overdue + due today + waiting for my decision. */
export async function badge(actor: WsActor, now = new Date()) {
  const dayEnd = new Date(startOfRiyadhDay(now).getTime() + DAY);
  const [tasks, approvals, ctx] = await Promise.all([
    prisma.workTask.count({ where: { assigneeId: actor.id, status: { in: OPEN_STATUSES }, dueAt: { lt: dayEnd } } }),
    myApprovalCount(actor),
    teamCtx(prisma, actor),
  ]);
  return { count: tasks + approvals, tasks, approvals, hasTeam: ctx.teamView || ctx.directReports.size > 0 };
}

export type CalendarLayer = "mine" | "tasks" | "team" | "occasions" | "leave";

/**
 * Calendar events in [from, to). Appointments are blocks; task deadlines are markers at their due
 * instant (a deadline never blocks the day); leave and occasions are all-day bars.
 */
export async function calendar(actor: WsActor, from: Date, to: Date, layers: CalendarLayer[], now = new Date()) {
  if (to.getTime() - from.getTime() > 62 * DAY) to = new Date(from.getTime() + 62 * DAY);
  const ctx = await teamCtx(prisma, actor);
  const teamIds = ctx.teamView
    ? (await prisma.employee.findMany({ where: { active: true, id: { not: actor.id } }, select: { id: true }, take: 500 })).map((e) => e.id)
    : [...ctx.directReports];
  const events: Record<string, unknown>[] = [];
  const want = new Set(layers);
  if (want.has("mine") || want.has("team")) {
    const people = [...(want.has("mine") ? [actor.id] : []), ...(want.has("team") ? teamIds : [])];
    if (people.length) {
      for (const a of await appointmentsBetween(actor, people, from, to, now)) {
        const mine = a.organizerId === actor.id || a.participants.some((p) => p.employeeId === actor.id);
        events.push({ id: `a:${a.id}`, kind: "APPOINTMENT", layer: mine ? "mine" : "team", title: a.title, start: a.startAt, end: a.endAt, appointment: a });
      }
    }
  }
  if (want.has("tasks") || want.has("team")) {
    const assignees = [...(want.has("tasks") ? [actor.id] : []), ...(want.has("team") ? teamIds : [])];
    const rows = assignees.length ? await prisma.workTask.findMany({
      where: { assigneeId: { in: assignees }, status: { in: OPEN_STATUSES }, dueAt: { gte: from, lt: to } },
      select: { id: true, title: true, dueAt: true, status: true, priority: true, assigneeId: true, assignee: { select: { name: true } } }, orderBy: { dueAt: "asc" }, take: 1000,
    }) : [];
    for (const t of rows) events.push({ id: `t:${t.id}`, kind: "TASK_DUE", layer: t.assigneeId === actor.id ? "tasks" : "team", title: t.title, start: t.dueAt, end: t.dueAt, overdue: isOverdue(t, now), priority: t.priority, assignee: t.assignee.name, taskId: t.id });
    if (want.has("tasks")) {
      for (const a of await crmFollowUps(actor, to)) if (new Date(a.dueAt) >= from) events.push({ id: `c:${a.id}`, kind: "CRM_DUE", layer: "tasks", title: a.subject, start: a.dueAt, end: a.dueAt, record: a.record, openUrl: a.openUrl });
    }
  }
  if (want.has("leave")) {
    const accounts = [actor.id, ...teamIds];
    const persons = await prisma.hrEmployee.findMany({ where: { accountId: { in: accounts } }, select: { id: true, accountId: true, fullNameAr: true } });
    const byPerson = new Map(persons.map((p) => [p.id, p]));
    const dayFrom = new Date(`${riyadhDay(from)}T00:00:00Z`), dayTo = new Date(`${riyadhDay(new Date(to.getTime() - 1))}T00:00:00Z`);
    const rows = persons.length ? await prisma.hrLeaveRequest.findMany({
      where: { employeeId: { in: persons.map((p) => p.id) }, status: { in: ["APPROVED", "PENDING"] }, startDate: { lte: dayTo }, endDate: { gte: dayFrom } },
      select: { id: true, employeeId: true, status: true, startDate: true, endDate: true, leaveType: { select: { nameAr: true } } }, take: 500,
    }) : [];
    // The type of someone else's leave (sick leave, say) is HR information: only a holder of an HR leave
    // duty reads it; everyone else sees «إجازة».
    const seesLeaveType = hrSees(actor);
    for (const l of rows) {
      const p = byPerson.get(l.employeeId)!;
      // A colleague's PENDING request is theirs and their approver's business, not the team calendar's.
      if (l.status === "PENDING" && p.accountId !== actor.id) continue;
      const kind = p.accountId === actor.id || seesLeaveType ? l.leaveType.nameAr : "إجازة";
      events.push({ id: `l:${l.id}`, kind: "LEAVE", layer: "leave", allDay: true, title: `${p.fullNameAr} · ${kind}`, start: l.startDate.toISOString().slice(0, 10), end: l.endDate.toISOString().slice(0, 10), status: l.status, mine: p.accountId === actor.id });
    }
  }
  if (want.has("occasions") && canSeeOccasions(actor)) {
    for (const o of await listOccasions(actor, from, to)) events.push({ id: `o:${o.id}`, kind: "OCCASION", layer: "occasions", allDay: true, title: o.name, start: o.startDate.toISOString().slice(0, 10), end: o.endDate.toISOString().slice(0, 10), occasion: o });
    const campaigns = await prisma.mktCampaign.findMany({ where: { status: { in: ["PLANNED", "ACTIVE"] }, startAt: { lt: to }, OR: [{ endAt: null }, { endAt: { gte: from } }] }, select: { id: true, name: true, startAt: true, endAt: true, status: true }, take: 200 });
    for (const c of campaigns) events.push({ id: `m:${c.id}`, kind: "CAMPAIGN", layer: "occasions", allDay: true, title: c.name, start: riyadhDay(c.startAt!), end: riyadhDay(c.endAt ?? c.startAt!), status: c.status, openUrl: `/dashboard/marketing/campaigns?campaign=${c.id}` });
  }
  return { from: from.toISOString(), to: to.toISOString(), events, team: { available: teamIds.length > 0 }, occasions: { available: canSeeOccasions(actor) } };
}

/** The team: each colleague's open / overdue / due-today work, leave today, disabled accounts. */
export async function team(actor: WsActor, now = new Date()) {
  const ctx = await teamCtx(prisma, actor);
  if (!ctx.teamView && ctx.directReports.size === 0) return { members: [], needsReassign: [], allowed: false };
  const members = await prisma.employee.findMany({
    where: ctx.teamView ? { OR: [{ active: true }, { workTasksAssigned: { some: { status: { in: OPEN_STATUSES } } } }] } : { id: { in: [...ctx.directReports] } },
    select: { id: true, name: true, active: true, role: true, hrPerson: { select: { id: true, jobTitle: true } } }, orderBy: { name: "asc" }, take: 300,
  });
  const ids = members.map((m) => m.id);
  const dayStart = startOfRiyadhDay(now), dayEnd = new Date(dayStart.getTime() + DAY);
  const today = new Date(`${riyadhDay(now)}T00:00:00Z`);
  const [open, overdue, dueToday, leave] = await Promise.all([
    prisma.workTask.groupBy({ by: ["assigneeId"], where: { assigneeId: { in: ids }, status: { in: OPEN_STATUSES } }, _count: { _all: true } }),
    prisma.workTask.groupBy({ by: ["assigneeId"], where: { assigneeId: { in: ids }, status: { in: OPEN_STATUSES }, dueAt: { lt: now } }, _count: { _all: true } }),
    prisma.workTask.groupBy({ by: ["assigneeId"], where: { assigneeId: { in: ids }, status: { in: OPEN_STATUSES }, dueAt: { gte: now, lt: dayEnd } }, _count: { _all: true } }),
    prisma.hrLeaveRequest.findMany({ where: { status: "APPROVED", startDate: { lte: today }, endDate: { gte: today }, employee: { accountId: { in: ids } } }, select: { endDate: true, employee: { select: { accountId: true } } } }),
  ]);
  const n = (rows: { assigneeId: string; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.assigneeId, r._count._all]));
  const o = n(open), od = n(overdue), dt = n(dueToday);
  const onLeave = new Map(leave.map((l) => [l.employee.accountId!, l.endDate.toISOString().slice(0, 10)]));
  const away = members.filter((m) => !m.active || onLeave.has(m.id)).map((m) => m.id);
  const needsReassign = away.length ? await prisma.workTask.findMany({
    where: { assigneeId: { in: away }, status: { in: OPEN_STATUSES } },
    select: { id: true, title: true, dueAt: true, priority: true, status: true, version: true, assigneeId: true, assignee: { select: { name: true, active: true } } }, orderBy: { dueAt: "asc" }, take: 200,
  }) : [];
  return {
    allowed: true,
    members: members.map((m) => ({ id: m.id, name: m.name, active: m.active, jobTitle: m.hrPerson?.jobTitle ?? null, open: o.get(m.id) ?? 0, overdue: od.get(m.id) ?? 0, dueToday: dt.get(m.id) ?? 0, onLeaveUntil: onLeave.get(m.id) ?? null })),
    needsReassign: needsReassign.map((t) => ({ ...t, reason: !t.assignee.active ? "DISABLED" : "ON_LEAVE", overdue: isOverdue(t, now) })),
  };
}

/**
 * My HR requests with who holds the next step. Self-service: the subject is always the caller. Read by the
 * «طلباتي المعلقة» card on «اليوم» (the requests themselves are submitted and followed in «خدماتي»).
 * `pending` counts what still waits for someone else's decision: leave PENDING, an advance REQUESTED,
 * an attendance correction PENDING.
 */
export async function myRequests(actor: WsActor) {
  const p = await prisma.hrEmployee.findUnique({ where: { accountId: actor.id }, select: { id: true, manager: { select: { fullNameAr: true } } } });
  if (!p) return { linked: false as const, items: [], pending: 0 };
  const [leave, advances, corrections] = await Promise.all([
    prisma.hrLeaveRequest.findMany({ where: { employeeId: p.id }, include: { leaveType: { select: { nameAr: true, code: true } } }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.hrAdvance.findMany({ where: { employeeId: p.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.hrAttendanceCorrection.findMany({ where: { employeeId: p.id }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const deciders = new Map((await prisma.employee.findMany({ where: { id: { in: [...leave.map((l) => l.decidedBy), ...advances.map((a) => a.decidedBy), ...corrections.map((c) => c.decidedBy)].filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  const mgr = p.manager?.fullNameAr ?? null;
  const items = [
    ...leave.map((l) => ({
      type: "LEAVE" as const, id: l.id, title: l.leaveType.nameAr, leaveTypeCode: l.leaveType.code, status: l.status, createdAt: l.createdAt,
      startDate: l.startDate.toISOString().slice(0, 10), endDate: l.endDate.toISOString().slice(0, 10), days: l.days.toString(),
      reason: l.reason, decisionNote: l.decisionNote, cancelReason: l.cancelReason, decidedBy: l.decidedBy ? deciders.get(l.decidedBy) ?? null : null,
      step: l.status === "PENDING" ? { ar: mgr ? `بانتظار اعتماد ${mgr} أو الموارد البشرية` : "بانتظار اعتماد الموارد البشرية", en: mgr ? `Awaiting ${mgr} or HR` : "Awaiting HR" } : null,
      canWithdraw: l.status === "PENDING", canCancel: l.status === "APPROVED",
      pending: l.status === "PENDING",
    })),
    ...advances.map((a) => ({
      type: "ADVANCE" as const, id: a.id, title: `سلفة ${a.advanceNo}`, status: a.status, createdAt: a.createdAt, amount: a.amount.toString(),
      installmentCount: a.installmentCount, firstInstallmentMonth: a.firstInstallmentMonth, decisionNote: a.decisionNote, cancelReason: a.cancelReason,
      decidedBy: a.decidedBy ? deciders.get(a.decidedBy) ?? null : null,
      step: a.status === "REQUESTED" ? { ar: "بانتظار اعتماد الموارد البشرية", en: "Awaiting HR approval" }
        : a.status === "APPROVED" ? { ar: "معتمدة — بانتظار الصرف من الموارد البشرية", en: "Approved — awaiting disbursement by HR" }
        : a.status === "DISBURSED" ? { ar: "صُرفت — تُستقطع من الراتب", en: "Paid out — being deducted from payroll" } : null,
      canWithdraw: false, canCancel: a.status === "REQUESTED",
      pending: a.status === "REQUESTED",
    })),
    ...corrections.map((c) => ({
      type: "CORRECTION" as const, id: c.id, title: "تصحيح حضور", status: c.status, createdAt: c.createdAt, workDate: c.workDate.toISOString().slice(0, 10),
      reason: c.reason, decisionNote: c.decisionNote, cancelReason: null, decidedBy: c.decidedBy ? deciders.get(c.decidedBy) ?? null : null,
      step: c.status === "PENDING" ? { ar: mgr ? `بانتظار اعتماد ${mgr}` : "بانتظار اعتماد المدير", en: mgr ? `Awaiting ${mgr}` : "Awaiting your manager" } : null,
      canWithdraw: false, canCancel: false,
      pending: c.status === "PENDING",
    })),
  ].sort((x, y) => +new Date(y.createdAt) - +new Date(x.createdAt));
  return { linked: true as const, items, pending: items.filter((i) => i.pending).length };
}
