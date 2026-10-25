// «مساحة عملي» — the server context: who is acting, who their team is, what they are to a task.
//
// Team = the logins of the actor's HR direct reports (HrEmployee.managerId → accountId), plus every
// active colleague for a holder of `workspace › team_view`. Nothing here is taken from the client.
import type { Prisma as PrismaNS, PrismaClient } from "@/generated/prisma/client";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { isSimpleMode } from "@/lib/simple-mode";
import type { Role } from "../rules";

export type Db = PrismaClient | PrismaNS.TransactionClient;
export type WsActor = { id: string; name?: string | null; role: string; permissions: Permissions; authTime?: Date | string };

/** A refusal in the shape every route maps (`handleDomainError`): Arabic first, the English kept. */
export function wsError(status: number, ar: string, en: string, code: string) {
  return { _appCode: status, message: ar, errorEn: en, code };
}
export const notFound = () => wsError(404, "السجل غير موجود أو لا تملك الوصول إليه.", "Not found.", "NOT_FOUND");
export const forbidden = (ar = "لا تملك صلاحية هذا الإجراء.") => wsError(403, ar, "Insufficient permissions.", "FORBIDDEN");
/** A write that replaces what the person saw carries the version they saw: no blind overwrite. */
export function requireVersion(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0) throw wsError(400, "نسخة السجل مطلوبة — حدّث الصفحة ثم أعد المحاولة.", "The record version is required — reload and try again.", "VERSION_REQUIRED");
  return n;
}
export const stale = () => wsError(409, "تغيّر السجل بعد فتحه. حدّث الصفحة وراجع التغييرات.", "The record changed after you opened it. Reload and review.", "STALE");

export const assignAny = (a: WsActor) => hasSubPrivilege(a.permissions, "workspace", "assign_any");
export const teamView = (a: WsActor) => hasSubPrivilege(a.permissions, "workspace", "team_view");
export const simple = () => isSimpleMode();
/** Linking a customer needs a duty that already reads customers: customers, orders or sales. */
export const seesCustomers = (a: WsActor) => ["customers", "orders", "sales"].some((m) => hasModuleAccess(a.permissions, m as never));

/** The login ids of the actor's HR direct reports (active accounts only). */
export async function directReports(db: Db, actorId: string): Promise<Set<string>> {
  const me = await db.hrEmployee.findUnique({ where: { accountId: actorId }, select: { id: true } });
  if (!me) return new Set();
  const rows = await db.hrEmployee.findMany({ where: { managerId: me.id, accountId: { not: null } }, select: { accountId: true } });
  return new Set(rows.map((r) => r.accountId!).filter(Boolean));
}

/** The login of a person's HR manager, if both are linked. */
export async function managerAccountOf(db: Db, accountId: string): Promise<string | null> {
  const p = await db.hrEmployee.findUnique({ where: { accountId }, select: { manager: { select: { accountId: true } } } });
  return p?.manager?.accountId ?? null;
}

export type TeamCtx = { directReports: Set<string>; assignAny: boolean; teamView: boolean };

export async function teamCtx(db: Db, actor: WsActor): Promise<TeamCtx> {
  return { directReports: await directReports(db, actor.id), assignAny: assignAny(actor), teamView: teamView(actor) };
}

/** Whose work the actor may see beyond their own: null = everyone (team_view), else these ids. */
export function teamScope(ctx: TeamCtx): Set<string> | null {
  return ctx.teamView ? null : ctx.directReports;
}

type TaskPeople = { assigneeId: string; createdById: string; reviewerId: string | null; watchers?: { employeeId: string }[] };

/** What the actor is to a task. */
export function rolesOf(actorId: string, t: TaskPeople, ctx: TeamCtx): Set<Role> {
  const r = new Set<Role>();
  if (t.assigneeId === actorId) r.add("ASSIGNEE");
  if (t.createdById === actorId) r.add("CREATOR");
  if (t.reviewerId === actorId) r.add("REVIEWER");
  if (t.watchers?.some((w) => w.employeeId === actorId)) r.add("WATCHER");
  if (ctx.directReports.has(t.assigneeId)) r.add("MANAGER");
  if (ctx.assignAny) r.add("ASSIGN_ANY");
  if (ctx.teamView) r.add("TEAM_VIEW");
  return r;
}

/** The Prisma filter of the tasks an actor may see (mirrors `rolesOf` + the view rule). */
export function visibleTasksWhere(actorId: string, ctx: TeamCtx): PrismaNS.WorkTaskWhereInput {
  if (ctx.teamView || ctx.assignAny) return {};
  return {
    OR: [
      { assigneeId: actorId }, { createdById: actorId }, { reviewerId: actorId },
      { watchers: { some: { employeeId: actorId } } },
      ...(ctx.directReports.size ? [{ assigneeId: { in: [...ctx.directReports] } }] : []),
    ],
  };
}

/** Riyadh formatting for notification texts (the person reads them later, anywhere). */
export function dueTexts(at: Date): { due: string; dueEn: string } {
  const ar = new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(at);
  const en = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);
  return { due: ar, dueEn: en };
}
