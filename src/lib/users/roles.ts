// Roles (Figma UR-05 · UR-06 · UR-07 · UR-10 role) — server side.
//
// The system templates are read-only and stay in code (O-3); a CUSTOM role is an AccessRole row.
// Saving a custom role rewrites, in the same transaction, the permission document of every account
// that follows it: the new template with that account's exceptions in force (P-2). Each account's
// change is audited with its exact diff; the role change itself is audited with the template diff
// and the reason. Every check of an account change applies to each member: no new conflicting
// payroll pair (Q-3), no self-elevation (P-4), and — SIMPLE MODE off — no sensitive permission
// through a role (P-3: a permanent sensitive grant needs a separate approval; none exists for roles).
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { recordEmployeeAudit, diffPermissions, lockEmployeeForAdmin } from "@/lib/services/employee-audit";
import { assertNoNewPayrollConflicts } from "@/lib/hr/sod";
import { gainedPrivileges } from "@/lib/auth/privileged";
import { isSimpleMode } from "@/lib/simple-mode";
import { SYSTEM_ROLES, NO_ACCESS_ROLE } from "./catalog";
import { applyOverrides, diffCells, effectOf, matrixErrors, normalize, sensitiveCount, sensitiveOn, storedCells, templateCells, toDocument, withoutSensitive, type Cells } from "./model";
import { SELF_ACCESS, UsersError } from "./errors";
import type { AuditContext } from "@/lib/services/employee-audit";

export type RoleSummary = {
  id: string; system: boolean; key: string | null; name: string; nameEn: string; description: string;
  members: number; sensitive: number; updatedAt: string | null; updatedByName: string | null; version: number;
  permissions: Cells;
};

const SYSTEM_KEYS = SYSTEM_ROLES.map((r) => r.key);
export const isSystemRoleId = (id: string) => SYSTEM_KEYS.includes(id) || id === "custom";

async function names(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const rows = await prisma.employee.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** UR-05: the system templates, then the custom roles, with their members and sensitive count. */
export async function listRoles(opts: { includeNoAccess?: boolean } = {}): Promise<RoleSummary[]> {
  const counts = await prisma.employee.groupBy({ by: ["role", "accessRoleId"], _count: { _all: true } });
  const sys = SYSTEM_ROLES.map((r): RoleSummary => {
    const t = templateCells(r.key);
    return {
      id: r.key, system: true, key: r.key, name: r.ar, nameEn: r.en, description: r.descAr,
      members: counts.filter((c) => c.role === r.key && !c.accessRoleId).reduce((a, c) => a + c._count._all, 0),
      sensitive: sensitiveCount(t), updatedAt: null, updatedByName: null, version: 0, permissions: t,
    };
  });
  const noAccess: RoleSummary[] = opts.includeNoAccess ? [{
    id: "custom", system: true, key: "custom", name: NO_ACCESS_ROLE.ar, nameEn: NO_ACCESS_ROLE.en, description: NO_ACCESS_ROLE.descAr,
    members: counts.filter((c) => c.role === "custom" && !c.accessRoleId).reduce((a, c) => a + c._count._all, 0),
    sensitive: 0, updatedAt: null, updatedByName: null, version: 0, permissions: templateCells("custom"),
  }] : [];
  const custom = await prisma.accessRole.findMany({ orderBy: { createdAt: "asc" } });
  const who = await names(custom.map((r) => r.updatedById ?? r.createdById));
  return [...sys, ...custom.map((r): RoleSummary => {
    const t = templateCells("custom", r.permissions);
    return {
      id: r.id, system: false, key: null, name: r.name, nameEn: r.name, description: r.description ?? "",
      members: counts.filter((c) => c.accessRoleId === r.id).reduce((a, c) => a + c._count._all, 0),
      sensitive: sensitiveCount(t), updatedAt: r.updatedAt.toISOString(), updatedByName: who.get(r.updatedById ?? r.createdById ?? "") ?? null,
      version: r.version, permissions: t,
    };
  }), ...noAccess];
}

export async function getRole(id: string) {
  const all = await listRoles({ includeNoAccess: true });
  const role = all.find((r) => r.id === id);
  if (!role) return null;
  const members = await prisma.employee.findMany({
    where: role.system ? { role: id, accessRoleId: null } : { accessRoleId: id },
    select: { id: true, name: true, active: true }, orderBy: { name: "asc" },
  });
  return { ...role, membersList: members };
}

/** A submitted matrix: known cells only, every value valid, and no action under a closed module (UR-S12). */
export function parseMatrix(raw: unknown): Cells {
  if (!raw || typeof raw !== "object") throw new UsersError(400, "INVALID_MATRIX", "مصفوفة الصلاحيات غير صالحة.", "The permission matrix is not valid.");
  const c = normalize(raw as never);
  const errs = matrixErrors(c);
  if (errs.length) {
    throw new UsersError(400, "SUB_WITHOUT_MODULE", "الإجراء مفعّل والوحدة «لا وصول». اختر «عرض» أو أزل الإجراء.", "An action is on while its module has no access. Choose View or remove the action.", { cells: errs });
  }
  return c;
}

function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s || s.length > 80) throw new UsersError(400, "ROLE_NAME", "اسم الدور مطلوب (حتى 80 حرفًا).", "A role name is required (up to 80 characters).");
  if (SYSTEM_ROLES.some((r) => r.ar === s || r.en.toLowerCase() === s.toLowerCase()) || s === NO_ACCESS_ROLE.ar) {
    throw new UsersError(409, "ROLE_NAME_TAKEN", "هذا الاسم لقالب نظام. اختر اسمًا آخر.", "That is a system template's name. Choose another.");
  }
  return s;
}
const cleanDesc = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
export function cleanReason(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < 3 || s.length > 300) throw new UsersError(400, "REASON_REQUIRED", "السبب مطلوب (3 أحرف على الأقل).", "A reason is required (at least 3 characters).");
  return s;
}

/**
 * P-3 on a role: a sensitive permission is never a template default. With SIMPLE MODE on (one
 * owner, no second person exists) the owner may still include one, with a reason and the password;
 * with SIMPLE MODE off the role cannot carry it — a permanent sensitive grant needs a separate
 * approval and review (O-2 / UR-10 «لا يسري قبل الاعتماد»), which no role path provides.
 */
function assertSensitiveAllowed(after: Cells, before: Cells | null) {
  if (isSimpleMode()) return;
  const had = new Set((before ? sensitiveOn(before) : []).map((r) => `${r.module}.${r.sub ?? ""}`));
  const added = sensitiveOn(after).filter((r) => !had.has(`${r.module}.${r.sub ?? ""}`));
  if (added.length) {
    throw new UsersError(409, "SENSITIVE_VIA_ROLE_NEEDS_APPROVAL", "منح دائم عبر الدور: يتطلب اعتمادًا منفصلًا ومراجعة دورية وفق السياسة المعتمدة، ولا يسري قبل الاعتماد. امنح الصلاحية الحساسة استثناءً مؤقتًا لكل مستخدم.", "A sensitive permission through a role needs a separate approval and review. Grant it as a temporary exception per user instead.", { cells: added });
  }
}

/** UR-05 «دور جديد» / UR-06 «نسخ الدور»: a custom role from a template, sensitive cells left out. */
export async function createRole(ctx: AuditContext, b: { name: unknown; description?: unknown; basedOn?: unknown; permissions?: unknown; reason?: unknown }) {
  const name = cleanName(b.name);
  let cells: Cells;
  let basedOn: string | null = null;
  if (b.permissions !== undefined) cells = parseMatrix(b.permissions);
  else if (typeof b.basedOn === "string" && b.basedOn) {
    const src = await getRole(b.basedOn);
    if (!src) throw new UsersError(404, "ROLE_NOT_FOUND", "الدور غير موجود.", "Role not found.");
    cells = withoutSensitive(src.permissions);
    basedOn = b.basedOn;
  } else cells = templateCells("custom");
  assertSensitiveAllowed(cells, null);
  const reason = b.reason !== undefined ? cleanReason(b.reason) : null;
  try {
    return await prisma.$transaction(async (tx) => {
      const r = await tx.accessRole.create({ data: { name, description: cleanDesc(b.description), permissions: JSON.stringify(toDocument(cells)), basedOn, createdById: ctx.actorId, updatedById: ctx.actorId } });
      await audit(tx, ctx, "ROLE_CREATED", { roleId: r.id, roleName: r.name, basedOn, sensitive: sensitiveOn(cells).map((x) => `${x.module}.${x.sub ?? "access"}`), ...(reason ? { reason } : {}) });
      return r;
    }, TX_OPTS);
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") throw new UsersError(409, "ROLE_NAME_TAKEN", "يوجد دور بهذا الاسم.", "A role with this name exists.");
    throw e;
  }
}

/** A name that is free: «نسخة من X», then «نسخة من X 2», … */
export async function freeCopyName(base: string): Promise<string> {
  const stem = `نسخة من ${base}`.slice(0, 74);
  for (let i = 1; i < 100; i++) {
    const n = i === 1 ? stem : `${stem} ${i}`;
    if (!(await prisma.accessRole.findUnique({ where: { name: n }, select: { id: true } }))) return n;
  }
  return `${stem} ${Date.now() % 10000}`;
}

/**
 * UR-06 save, after UR-10 confirm: name, description and template of a custom role, judged against
 * the version the editor read (UR-S10). Every member's document is rewritten in this transaction.
 */
export async function updateRole(ctx: AuditContext, id: string, b: { name?: unknown; description?: unknown; permissions: unknown; reason: unknown; version: unknown }) {
  if (isSystemRoleId(id)) throw new UsersError(409, "SYSTEM_TEMPLATE_READ_ONLY", "قالب النظام للقراءة فقط. انسخه لإنشاء دور مخصص قابل للتعديل.", "A system template is read-only. Copy it to make an editable custom role.");
  const cells = parseMatrix(b.permissions);
  const reason = cleanReason(b.reason);
  const name = b.name !== undefined ? cleanName(b.name) : undefined;
  try {
    return await prisma.$transaction(async (tx) => {
      // The role row first, then each member's row, always in that order (no lock cycle).
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "AccessRole" WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new UsersError(404, "ROLE_NOT_FOUND", "الدور غير موجود.", "Role not found.");
      const role = await tx.accessRole.findUniqueOrThrow({ where: { id } });
      if (typeof b.version !== "number" || b.version !== role.version) {
        const who = role.updatedById ? (await tx.employee.findUnique({ where: { id: role.updatedById }, select: { name: true } }))?.name : null;
        throw new UsersError(409, "ROLE_CONFLICT", `عدّل ${who ?? "مسؤول آخر"} هذا الدور بعد أن فتحته. راجع تغييره ثم احفظ تغييراتك فوقه.`, "Someone changed this role after you opened it. Review their change, then save yours on top.", { version: role.version, updatedAt: role.updatedAt.toISOString(), updatedByName: who ?? null });
      }
      const before = templateCells("custom", role.permissions);
      assertSensitiveAllowed(cells, before);
      const doc = JSON.stringify(toDocument(cells));
      const updated = await tx.accessRole.update({ where: { id }, data: { permissions: doc, ...(name !== undefined ? { name } : {}), ...(b.description !== undefined ? { description: cleanDesc(b.description) } : {}), version: { increment: 1 }, updatedById: ctx.actorId } });
      const members = await tx.employee.findMany({ where: { accessRoleId: id }, select: { id: true }, orderBy: { id: "asc" } });
      const changedMembers: { id: string; name: string; changes: number }[] = [];
      for (const { id: mid } of members) {
        await lockEmployeeForAdmin(tx, mid);
        const m = await tx.employee.findUniqueOrThrow({ where: { id: mid }, select: { id: true, name: true, role: true, permissions: true, active: true } });
        const overrides = await tx.permissionOverride.findMany({ where: { employeeId: mid, endedAt: null } });
        const next = applyOverrides(cells, overrides);
        const nextDoc = JSON.stringify(toDocument(next));
        const prev = storedCells(m.permissions as string, m.role);
        if (!diffCells(prev, next).length) continue;
        const grant = { permissions: nextDoc, role: m.role };
        const prior = { permissions: m.permissions as string, role: m.role };
        // P-4: an administrator who follows this role does not raise their own access through it.
        if (mid === ctx.actorId && (gainedPrivileges(grant, prior).length > 0 || diffCells(prev, next).some((c) => effectOf({ module: c.module, sub: c.sub }, c.to, c.from) === "GRANT"))) throw SELF_ACCESS();
        assertNoNewPayrollConflicts(grant, prior);
        await tx.employee.update({ where: { id: mid }, data: { permissions: nextDoc } });
        const d = diffPermissions(m.permissions, nextDoc);
        await recordEmployeeAudit(tx, ctx, [{ action: "EMPLOYEE_PERMISSIONS_CHANGED", targetEmployeeId: mid, targetName: m.name, metadata: { changes: d.changes, truncated: d.truncated, via: "ROLE", roleId: id, roleName: updated.name, reason } }]);
        changedMembers.push({ id: mid, name: m.name, changes: d.changes.length });
      }
      const templateDiff = diffPermissions(JSON.stringify(toDocument(before)), doc);
      await audit(tx, ctx, "ROLE_UPDATED", { roleId: id, roleName: updated.name, changes: templateDiff.changes, truncated: templateDiff.truncated, reason, members: changedMembers, ...(name !== undefined && name !== role.name ? { renamedFrom: role.name } : {}) });
      return { role: updated, members: changedMembers };
    }, TX_OPTS);
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") throw new UsersError(409, "ROLE_NAME_TAKEN", "يوجد دور بهذا الاسم.", "A role with this name exists.");
    throw e;
  }
}

async function audit(tx: Prisma.TransactionClient, ctx: AuditContext, action: string, metadata: Record<string, unknown>) {
  await tx.authAuditLog.create({ data: { userId: ctx.actorId, action, result: "SUCCESS", sourceInterface: "WEB", ipHash: ctx.ipHash, userAgent: ctx.userAgent, metadata: metadata as Prisma.InputJsonValue } });
}
