// Explicit per-user exceptions to a role (Figma UR-09, P-2) — server side.
//
// The account's stored permission document is what the session applies (auth-server.ts); a
// PermissionOverride row explains a cell of it (grant or deny, reason, expiry, who) and, on expiry,
// returns the cell to the role's value. Rows are written in the same transaction as the document
// they explain (updateAccount's afterUpdate hook), so the two never disagree.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { lockEmployeeForAdmin, diffPermissions } from "@/lib/services/employee-audit";
import { assertNoNewPayrollConflicts } from "@/lib/hr/sod";
import { gainedPrivileges } from "@/lib/auth/privileged";
import { isSimpleMode } from "@/lib/simple-mode";
import { isSensitive } from "./catalog";
import { effectOf, getCell, setCell, storedCells, templateCells, toDocument, type CellRef, type CellValue, type Cells } from "./model";

type Tx = Prisma.TransactionClient;

/** The role template an account follows (its custom role's document, or the system template). */
export async function accountTemplate(tx: Tx | typeof prisma, e: { role: string; accessRoleId: string | null }): Promise<Cells> {
  if (e.accessRoleId) {
    const r = await tx.accessRole.findUnique({ where: { id: e.accessRoleId }, select: { permissions: true } });
    if (r) return templateCells(e.role, r.permissions);
  }
  return templateCells(e.role);
}

/**
 * Record the exceptions behind a change that has just been stored (same transaction):
 *   · a row in force whose cell no longer carries its value is ended — REMOVED when the cell is
 *     back at the role's value, REPLACED otherwise;
 *   · each cell the editor set that now differs from the role gets a new row (reason, expiry).
 * Cells that differ from the role without having been set now (a permission set before exceptions
 * existed) get no invented reason: they show as «بلا سبب مسجّل».
 */
export async function recordOverrides(tx: Tx, a: {
  employeeId: string; template: Cells; after: Cells; requested: CellRef[]; reason: string;
  expiresAt: Date | null; reviewAt: Date | null; actorId: string; now?: Date;
}): Promise<{ added: { module: string; sub: string | null; effect: string; value: string; sensitive: boolean; expiresAt: string | null }[]; ended: { id: string; module: string; sub: string | null; endReason: string }[] }> {
  const now = a.now ?? new Date();
  const rows = await tx.permissionOverride.findMany({ where: { employeeId: a.employeeId, endedAt: null } });
  const ended: { id: string; module: string; sub: string | null; endReason: string }[] = [];
  for (const r of rows) {
    const ref = { module: r.module, sub: r.sub };
    if (!a.after[r.module]) continue;
    const cur = getCell(a.after, ref);
    const roleValue = getCell(a.template, ref);
    if (cur === r.value && cur !== roleValue) continue;
    const endReason = cur === roleValue ? "REMOVED" : "REPLACED";
    await tx.permissionOverride.update({ where: { id: r.id }, data: { endedAt: now, endedById: a.actorId, endReason } });
    ended.push({ id: r.id, module: r.module, sub: r.sub, endReason });
  }
  const kept = new Set(rows.filter((r) => !ended.some((e) => e.id === r.id)).map((r) => `${r.module}|${r.sub ?? ""}`));
  const added: { module: string; sub: string | null; effect: string; value: string; sensitive: boolean; expiresAt: string | null }[] = [];
  for (const ref of a.requested) {
    if (kept.has(`${ref.module}|${ref.sub ?? ""}`)) continue;
    const value = getCell(a.after, ref);
    const roleValue = getCell(a.template, ref);
    const effect = effectOf(ref, value, roleValue);
    if (!effect) continue;
    const sensitive = isSensitive(ref.module, ref.sub);
    await tx.permissionOverride.create({
      data: {
        employeeId: a.employeeId, module: ref.module, sub: ref.sub, effect, value, roleValue, sensitive, reason: a.reason,
        expiresAt: a.expiresAt, reviewAt: a.reviewAt, createdById: a.actorId,
      },
    });
    added.push({ module: ref.module, sub: ref.sub, effect, value, sensitive, expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null });
  }
  return { added, ended };
}

/**
 * Expiry (O-2, §9.2): an exception past its date stops applying at once. Its cell returns to the
 * role's value — only if it still carries the exception's value (a later change wins) — the row is
 * ended EXPIRED by the system, and the change is audited with its exact diff. A returning DENY that
 * would GRANT something privileged without a second person (SIMPLE MODE off) or add a conflicting
 * payroll pair is not applied: the cell keeps its value and the audit says why.
 *
 * Called on the hot path for the signed-in account (auth-server.ts) and before the screens read.
 */
export async function settleExpiredOverrides(employeeId?: string, now = new Date()): Promise<number> {
  const due = await prisma.permissionOverride.findMany({
    where: { endedAt: null, expiresAt: { lte: now }, ...(employeeId ? { employeeId } : {}) },
    select: { employeeId: true },
    distinct: ["employeeId"],
  });
  let settled = 0;
  for (const { employeeId: id } of due) {
    settled += await prisma.$transaction(async (tx) => {
      if (!(await lockEmployeeForAdmin(tx, id))) return 0;
      const rows = await tx.permissionOverride.findMany({ where: { employeeId: id, endedAt: null, expiresAt: { lte: now } }, orderBy: { expiresAt: "asc" } });
      if (!rows.length) return 0;
      const e = await tx.employee.findUniqueOrThrow({ where: { id }, select: { name: true, role: true, permissions: true, accessRoleId: true } });
      const template = await accountTemplate(tx, e);
      const before = storedCells(e.permissions as string, e.role);
      const after = structuredClone(before);
      const results: { module: string; sub: string | null; restored: boolean; why?: string }[] = [];
      for (const r of rows) {
        const ref = { module: r.module, sub: r.sub };
        if (!after[r.module]) { results.push({ module: r.module, sub: r.sub, restored: false, why: "UNKNOWN_CELL" }); continue; }
        if (getCell(after, ref) !== r.value) { results.push({ module: r.module, sub: r.sub, restored: false, why: "CHANGED_SINCE" }); continue; }
        setCell(after, ref, getCell(template, ref) as CellValue);
        results.push({ module: r.module, sub: r.sub, restored: true });
      }
      let doc = JSON.stringify(toDocument(after));
      const grant = { permissions: doc, role: e.role };
      const prior = { permissions: e.permissions as string, role: e.role };
      let blocked: string | null = null;
      if (!isSimpleMode() && gainedPrivileges(grant, prior).length) blocked = "PRIVILEGED_NEEDS_APPROVAL";
      try { assertNoNewPayrollConflicts(grant, prior); } catch { blocked = "SOD_DUTY_CONFLICT"; }
      if (blocked) {
        doc = e.permissions as string;
        for (const x of results) if (x.restored) { x.restored = false; x.why = blocked; }
      }
      const changes = diffPermissions(e.permissions, doc);
      if (changes.changes.length) await tx.employee.update({ where: { id }, data: { permissions: doc } });
      await tx.permissionOverride.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { endedAt: now, endReason: "EXPIRED" } });
      await tx.authAuditLog.create({
        data: {
          userId: null, action: "PERMISSION_OVERRIDE_EXPIRED", result: "SUCCESS", sourceInterface: "SYSTEM", ipHash: "system", userAgent: null,
          metadata: { targetEmployeeId: id, targetName: e.name, overrides: results, changes: changes.changes, truncated: changes.truncated } as Prisma.InputJsonValue,
        },
      });
      return rows.length;
    }, TX_OPTS);
  }
  return settled;
}
