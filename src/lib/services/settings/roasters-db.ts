// Reads and the shared write steps of Settings › Production & roasting (the routes under
// /api/settings/production). Takes the Prisma client or a transaction.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { ROLE_LABELS, ROLE_LABELS_AR } from "@/lib/auth-shared";
import { canOperate, roasterOut, seesProduction } from "./roasters";

type Db = PrismaClient | Prisma.TransactionClient;

/** Display names of employee ids (missing ids are left out). */
export async function employeeNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (want.length === 0) return new Map();
  const rows = await db.employee.findMany({ where: { id: { in: want } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

const ACTIVE_ROASTER = { status: { not: "RETIRED" } } as const;

/** RM1 / RM4: every roaster still in service, its maintenance, and the next planned window. */
export async function productionOverview(db: Db, now = new Date()) {
  const roasters = await db.roaster.findMany({ where: ACTIVE_ROASTER, orderBy: [{ type: "asc" }, { isDefault: "desc" }, { createdAt: "asc" }] });
  // Planned / in progress (any date) and everything of the last 120 days, newest first.
  const since = new Date(now.getTime() - 120 * 86_400_000);
  const maintenance = await db.roasterMaintenance.findMany({
    where: { roasterId: { in: roasters.map((r) => r.id) }, OR: [{ status: { in: ["PLANNED", "IN_PROGRESS"] } }, { startsAt: { gte: since } }] },
    orderBy: [{ startsAt: "desc" }],
    take: 200,
  });
  const names = await employeeNames(db, [...roasters.map((r) => r.defaultOperatorId), ...maintenance.map((m) => m.requestedById)]);
  const next = maintenance
    .filter((m) => (m.status === "PLANNED" || m.status === "IN_PROGRESS") && m.endsAt.getTime() > now.getTime())
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0] ?? null;
  // The people who can open production, with their authorization (the default-operator picker).
  const people = (await db.employee.findMany({ where: { active: true }, select: { id: true, name: true, role: true, permissions: true, active: true }, orderBy: { name: "asc" } }))
    .filter(seesProduction)
    .map((p) => ({ id: p.id, name: p.name, authorized: canOperate(p) }));
  return {
    people,
    roasters: roasters.map((r) => roasterOut(r, names)),
    maintenance: maintenance.map((m) => maintenanceOut(m, names)),
    nextMaintenance: next ? maintenanceOut(next, names) : null,
  };
}

type MRow = { id: string; roasterId: string; title: string; kind: string; recurrenceWeeks: number | null; startsAt: Date; endsAt: Date; status: string; requestedById: string | null; notes: string | null; updatedAt: Date };

export function maintenanceOut(m: MRow, names: Map<string, string> = new Map()) {
  return {
    id: m.id, roasterId: m.roasterId, title: m.title, kind: m.kind, recurrenceWeeks: m.recurrenceWeeks,
    startsAt: m.startsAt.toISOString(), endsAt: m.endsAt.toISOString(), status: m.status,
    requestedById: m.requestedById, requestedByName: m.requestedById ? names.get(m.requestedById) ?? null : null,
    notes: m.notes, updatedAt: m.updatedAt.toISOString(),
  };
}

/**
 * RM5: the people listed for a roaster — every active login that can open production (authorized
 * or not), and anybody assigned — with the authorization read now from production › start_batch.
 * An assignment of somebody no longer authorized is listed as inactive.
 */
export async function operatorsFor(db: Db, roasterId: string) {
  const roaster = await db.roaster.findUnique({ where: { id: roasterId }, include: { operators: true } });
  if (!roaster) return null;
  const assigned = new Set(roaster.operators.map((o) => o.employeeId));
  const people = await db.employee.findMany({
    where: { OR: [{ active: true }, { id: { in: [...assigned] } }] },
    select: { id: true, name: true, role: true, permissions: true, active: true },
    orderBy: { name: "asc" },
  });
  const rows = people
    .filter((p) => assigned.has(p.id) || seesProduction(p))
    .map((p) => {
      const authorized = canOperate(p);
      const isAssigned = assigned.has(p.id);
      return {
        id: p.id, name: p.name, role: p.role,
        roleAr: ROLE_LABELS_AR[p.role] ?? p.role, roleEn: ROLE_LABELS[p.role] ?? p.role,
        authorized, assigned: isAssigned, active: isAssigned && authorized,
        isDefault: roaster.defaultOperatorId === p.id,
      };
    })
    // Authorized first (the frame: the assignable rows, then «غير مخوّل»), then by name.
    .sort((a, b) => Number(b.authorized) - Number(a.authorized) || Number(b.isDefault) - Number(a.isDefault) || Number(b.assigned) - Number(a.assigned) || a.name.localeCompare(b.name, "ar"));
  return { roaster: { id: roaster.id, name: roaster.name, defaultOperatorId: roaster.defaultOperatorId }, operators: rows };
}

/** Whether this id is an active login that holds production › start_batch. */
export async function isAuthorizedOperator(db: Db, employeeId: string): Promise<boolean> {
  const e = await db.employee.findUnique({ where: { id: employeeId }, select: { role: true, permissions: true, active: true } });
  return !!e && canOperate(e);
}

/** The change history of one roaster (RM3 «سجل التغييرات»), newest first. */
export async function roasterHistory(db: Db, roasterId: string, take = 30) {
  const rows = await db.settingsAuditLog.findMany({
    where: { OR: [{ entityType: "Roaster", entityId: roasterId }, { entityType: "RoasterOperator", entityId: roasterId }, { entityType: "RoasterMaintenance", after: { path: ["roasterId"], equals: roasterId } }] },
    orderBy: { createdAt: "desc" },
    take,
  });
  // Employee ids named in the rows (default operator, requester, assignment) → names, for the timeline.
  const ids: string[] = [];
  for (const r of rows) for (const side of [r.before, r.after] as unknown[]) {
    const o = (side ?? {}) as Record<string, unknown>;
    for (const k of ["defaultOperatorId", "requestedById", "employeeId"]) if (typeof o[k] === "string") ids.push(o[k] as string);
  }
  const names = Object.fromEntries(await employeeNames(db, ids));
  // «موقع الحمّاصة» (20261117090000): the location ids named in the rows → their names.
  const locIds = [...new Set(rows.flatMap((r) => [r.before, r.after].map((s) => ((s ?? {}) as Record<string, unknown>).locationId)).filter((x): x is string => typeof x === "string"))];
  if (locIds.length) for (const l of await db.stockLocation.findMany({ where: { id: { in: locIds } }, select: { id: true, nameAr: true } })) names[l.id] = l.nameAr;
  return rows.map((r) => ({ id: r.id, action: r.action, changed: r.changed, before: r.before, after: r.after, reason: r.reason, actorName: r.actorName, createdAt: r.createdAt.toISOString(), names }));
}

/** The audited view of a maintenance window. */
export function maintenanceAudit(m: { roasterId: string; title: string; kind: string; recurrenceWeeks: number | null; startsAt: Date; endsAt: Date; status: string; requestedById: string | null; notes: string | null }) {
  return { roasterId: m.roasterId, title: m.title, kind: m.kind, recurrenceWeeks: m.recurrenceWeeks, startsAt: m.startsAt.toISOString(), endsAt: m.endsAt.toISOString(), status: m.status, requestedById: m.requestedById, notes: m.notes };
}
