// «مساحة عملي» — marketing occasions, exhibitions and campaign moments on the calendar.
//
// Who: the marketing module to see them, marketing › campaigns_manage to add, edit, confirm and plan —
// the existing marketing duty, no new grant. An imported date keeps its source and when it was last
// verified; it is a DRAFT until someone reviews and confirms it. Nothing assumes an occasion recurs on the
// same date: next year is a new row with its own source. Prep tasks are generated only for a confirmed
// occasion, each due a number of days before its first day.
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { notify } from "@/lib/notifications/notify";
import { mayAssign } from "../rules";
import { fromRiyadh } from "../time";
import { dueTexts, forbidden, notFound, requireVersion, stale, teamCtx, wsError, type WsActor } from "./context";
import { planTaskReminders } from "./reminders";

type Body = Record<string, unknown>;
const KINDS = ["OCCASION", "EXHIBITION", "CAMPAIGN", "HOLIDAY"];
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) ? new Date(`${v}T00:00:00Z`) : null);

export const canSeeOccasions = (a: WsActor) => hasModuleAccess(a.permissions, "marketing");
export const canManageOccasions = (a: WsActor) => hasSubPrivilege(a.permissions, "marketing", "campaigns_manage");

/** The default preparation plan (days before the first day). The planner may change each step. */
export const PREP_STEPS = [
  { key: "idea", ar: "الفكرة", en: "Idea", daysBefore: 21 },
  { key: "content", ar: "كتابة المحتوى", en: "Content", daysBefore: 14 },
  { key: "design", ar: "التصميم", en: "Design", daysBefore: 10 },
  { key: "approval", ar: "الاعتماد", en: "Approval", daysBefore: 5 },
  { key: "publish", ar: "النشر", en: "Publishing", daysBefore: 1 },
];

const SELECT = {
  id: true, name: true, kind: true, startDate: true, endDate: true, location: true, notes: true, sourceUrl: true, sourceNote: true,
  lastVerifiedAt: true, status: true, campaignId: true, createdById: true, confirmedById: true, confirmedAt: true, version: true, createdAt: true, updatedAt: true,
  campaign: { select: { id: true, name: true } },
  _count: { select: { tasks: true } },
} satisfies PrismaNS.WorkOccasionSelect;

function fields(b: Body, cur?: { name: string; kind: string; startDate: Date; endDate: Date }) {
  const name = b.name !== undefined ? str(b.name, 300) : cur?.name ?? null;
  if (!name) throw wsError(400, "اكتب اسم المناسبة.", "A name is required.", "NAME_REQUIRED");
  const kind = typeof b.kind === "string" && KINDS.includes(b.kind) ? b.kind : cur?.kind ?? "OCCASION";
  const startDate = b.startDate !== undefined ? day(b.startDate) : cur?.startDate ?? null;
  const endDate = b.endDate !== undefined ? day(b.endDate) : cur?.endDate ?? startDate;
  if (!startDate || !endDate) throw wsError(400, "حدّد تاريخ البداية والنهاية.", "Start and end dates are required.", "DATES_REQUIRED");
  if (endDate < startDate) throw wsError(400, "تاريخ النهاية قبل البداية.", "End is before start.", "DATES_ORDER");
  const sourceUrl = b.sourceUrl !== undefined ? str(b.sourceUrl, 500) : undefined;
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) throw wsError(400, "رابط المصدر غير صالح.", "The source link is not valid.", "URL_INVALID");
  const verified = b.lastVerifiedAt !== undefined ? (typeof b.lastVerifiedAt === "string" ? new Date(b.lastVerifiedAt) : null) : undefined;
  return {
    name, kind, startDate, endDate,
    ...(b.location !== undefined ? { location: str(b.location, 300) } : {}),
    ...(b.notes !== undefined ? { notes: str(b.notes, 4000) } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    ...(b.sourceNote !== undefined ? { sourceNote: str(b.sourceNote, 500) } : {}),
    ...(verified !== undefined ? { lastVerifiedAt: verified && !Number.isNaN(verified.getTime()) ? verified : null } : {}),
    ...(b.campaignId !== undefined ? { campaignId: typeof b.campaignId === "string" && b.campaignId ? b.campaignId : null } : {}),
  };
}

export async function listOccasions(actor: WsActor, from: Date, to: Date) {
  if (!canSeeOccasions(actor)) return [];
  return prisma.workOccasion.findMany({ where: { status: { not: "CANCELLED" }, startDate: { lte: to }, endDate: { gte: from } }, select: SELECT, orderBy: { startDate: "asc" }, take: 500 });
}

export async function createOccasion(actor: WsActor, b: Body) {
  if (!canManageOccasions(actor)) throw forbidden("إضافة المناسبات تحتاج صلاحية إدارة الحملات في التسويق.");
  const f = fields(b);
  if (f.campaignId && !(await prisma.mktCampaign.findUnique({ where: { id: f.campaignId }, select: { id: true } }))) throw notFound();
  return prisma.workOccasion.create({ data: { ...f, createdById: actor.id, status: "DRAFT" }, select: SELECT });
}

export async function updateOccasion(actor: WsActor, id: string, b: Body) {
  if (!canManageOccasions(actor)) throw forbidden();
  const cur = await prisma.workOccasion.findUnique({ where: { id } });
  if (!cur) throw notFound();
  if (cur.status === "CANCELLED") throw wsError(409, "المناسبة ملغاة.", "Cancelled.", "CLOSED");
  const f = fields(b, cur);
  // A confirmed occasion whose dates change goes back to review: the new dates were not verified.
  const datesMoved = f.startDate.getTime() !== cur.startDate.getTime() || f.endDate.getTime() !== cur.endDate.getTime();
  const r = await prisma.workOccasion.updateMany({
    where: { id, version: requireVersion(b.version) },
    data: { ...f, version: { increment: 1 }, ...(datesMoved && cur.status === "CONFIRMED" ? { status: "DRAFT", confirmedAt: null, confirmedById: null } : {}) },
  });
  if (r.count !== 1) throw stale();
  return prisma.workOccasion.findUniqueOrThrow({ where: { id }, select: SELECT });
}

/** Review done: the dates and source were checked. */
export async function confirmOccasion(actor: WsActor, id: string, b: Body, now = new Date()) {
  if (!canManageOccasions(actor)) throw forbidden();
  const cur = await prisma.workOccasion.findUnique({ where: { id } });
  if (!cur) throw notFound();
  if (!cur.sourceUrl && !cur.sourceNote) throw wsError(409, "أضف مصدر التاريخ قبل الاعتماد.", "Add the date's source before confirming.", "SOURCE_REQUIRED");
  const r = await prisma.workOccasion.updateMany({ where: { id, status: "DRAFT", version: requireVersion(b.version) }, data: { status: "CONFIRMED", confirmedAt: now, confirmedById: actor.id, lastVerifiedAt: now, version: { increment: 1 } } });
  if (r.count !== 1) throw stale();
  return prisma.workOccasion.findUniqueOrThrow({ where: { id }, select: SELECT });
}

export async function cancelOccasion(actor: WsActor, id: string) {
  if (!canManageOccasions(actor)) throw forbidden();
  const r = await prisma.workOccasion.updateMany({ where: { id, status: { not: "CANCELLED" } }, data: { status: "CANCELLED", version: { increment: 1 } } });
  if (r.count !== 1) throw notFound();
  return { ok: true };
}

/**
 * Create the preparation tasks of a confirmed occasion. Body: { steps: [{ title, daysBefore, assigneeId }] }
 * (defaults: PREP_STEPS, assigned to the planner). Each is due at 12:00 Riyadh, `daysBefore` days before
 * the first day. Refused when the occasion already has prep tasks (never twice).
 */
export async function planPrepTasks(actor: WsActor, id: string, b: Body, now = new Date()) {
  if (!canManageOccasions(actor)) throw forbidden();
  const occ = await prisma.workOccasion.findUnique({ where: { id }, select: { id: true, name: true, status: true, startDate: true, _count: { select: { tasks: true } } } });
  if (!occ) throw notFound();
  if (occ.status !== "CONFIRMED") throw wsError(409, "اعتمد تاريخ المناسبة ومصدره قبل إنشاء مهام التحضير.", "Confirm the occasion before planning its preparation.", "NOT_CONFIRMED");
  if (occ._count.tasks > 0) throw wsError(409, "أُنشئت مهام التحضير لهذه المناسبة مسبقًا.", "Preparation tasks already exist.", "ALREADY_PLANNED");
  const raw: Body[] = Array.isArray(b.steps) && b.steps.length ? (b.steps as Body[]) : PREP_STEPS.map((s) => ({ title: s.ar, daysBefore: s.daysBefore }));
  const ctx = await teamCtx(prisma, actor);
  const steps = raw.slice(0, 12).map((s) => {
    const title = str(s.title, 200);
    const daysBefore = Math.floor(Number(s.daysBefore));
    const assigneeId = typeof s.assigneeId === "string" && s.assigneeId ? s.assigneeId : actor.id;
    if (!title || !Number.isInteger(daysBefore) || daysBefore < 0 || daysBefore > 365) throw wsError(400, "خطوة تحضير غير صالحة.", "Invalid preparation step.", "STEP_INVALID");
    if (!mayAssign(actor.id, assigneeId, ctx)) throw forbidden("يمكنك إسناد المهام لنفسك ولفريقك المباشر فقط.");
    const d = occ.startDate;
    const due = fromRiyadh(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate() - daysBefore, 12, 0);
    return { title: `${title} — ${occ.name}`, assigneeId, due };
  });
  const people = await prisma.employee.count({ where: { id: { in: [...new Set(steps.map((s) => s.assigneeId))] }, active: true } });
  if (people !== new Set(steps.map((s) => s.assigneeId)).size) throw wsError(400, "أحد المسؤولين غير موجود أو حسابه معطّل.", "An assignee does not exist or is disabled.", "ASSIGNEE_INVALID");
  return prisma.$transaction(async (tx) => {
    // Two submissions at once: the second waits here, then finds the tasks and stops.
    await tx.$queryRaw`SELECT "id" FROM "WorkOccasion" WHERE "id" = ${id} FOR UPDATE`;
    if ((await tx.workTask.count({ where: { occasionId: id } })) > 0) throw wsError(409, "أُنشئت مهام التحضير لهذه المناسبة مسبقًا.", "Preparation tasks already exist.", "ALREADY_PLANNED");
    const ids: string[] = [];
    for (const s of steps) {
      const t = await tx.workTask.create({ data: { title: s.title, assigneeId: s.assigneeId, createdById: actor.id, dueAt: s.due < now ? new Date(now.getTime() + 3_600_000) : s.due, dueBasis: "EXACT", occasionId: id, priority: "NORMAL" }, select: { id: true, dueAt: true } });
      ids.push(t.id);
      await tx.workTaskEvent.create({ data: { taskId: t.id, actorId: actor.id, action: "CREATED", data: { occasionId: id, dueAt: t.dueAt.toISOString() } } });
      await planTaskReminders(tx, t.id, now);
      if (s.assigneeId !== actor.id) {
        await notify(tx, { event: "me.task_assigned", dedupeKey: `${t.id}:assigned:${s.assigneeId}`, actorId: actor.id, people: { assignee: s.assigneeId }, entity: { type: "WorkTask", id: t.id }, facts: { title: s.title, by: actor.name ?? null, taskId: t.id, ...dueTexts(t.dueAt) } });
      }
    }
    return { created: ids.length, taskIds: ids };
  }, TX_OPTS);
}
