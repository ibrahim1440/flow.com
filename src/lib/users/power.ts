// The "power user" (owner decision, 19 Oct 2026): besides the administrator, an account the
// administrator chose — it holds employees › manage_access, «مستخدم متقدّم · إدارة صلاحيات
// المستخدمين» — changes OTHER users' roles, permissions and exceptions. Pure: the server decides with
// it (src/lib/users/account-update.ts, the routes) and the pages preview with it (the matrix).
//
// Guardrails on a power user, checked against the account's cells before and after the change:
//   · never their own access (SELF_ACCESS_CHANGE, already enforced for everyone);
//   · never an administrator's account, and never the administrator role (TARGET_IS_ADMIN,
//     ADMIN_ROLE_ADMIN_ONLY);
//   · never manage_access itself — only the administrator grants or removes it
//     (MANAGE_ACCESS_ADMIN_ONLY);
//   · never a permission above their own: a module level above theirs, or an action they do not hold
//     (BEYOND_OWN_ACCESS). Removing access is not limited.
// The last-administrator rule, the payroll-duty conflicts and the second-person grant flow apply to
// everyone on the shared path.
import type { Permissions } from "@/lib/auth-shared";
import { allCells, cellKey, getCell, normalize, type CellRef, type Cells } from "./model";

export const MANAGE_ACCESS: CellRef = { module: "employees", sub: "manage_access" };
export const MANAGE_ACCESS_KEY = "employees.manage_access";

const RANK: Record<string, number> = { none: 0, view: 1, edit: 2 };

/** Does an account with these cells hold manage_access (the module open and the action on)? */
export function holdsManageAccess(c: Cells): boolean {
  return c.employees?.access !== undefined && c.employees.access !== "none" && c.employees.sub.manage_access === true;
}

export type AccessActor = "admin" | "power" | null;

/** Who an actor is for changing other users' access. */
export function accessActorOf(role: string, cells: Cells): AccessActor {
  if (role === "admin") return "admin";
  return holdsManageAccess(cells) ? "power" : null;
}

/** The same, for a signed-in account (its session permissions). */
export function accessActor(user: { role: string; permissions: Permissions }): AccessActor {
  return accessActorOf(user.role, normalize(user.permissions));
}

/** Is this account (its role and effective cells) a power user — not the administrator? */
export function isPowerUserAccount(role: string, cells: Cells): boolean {
  return accessActorOf(role, cells) === "power";
}

/** May the actor's own cells cover this value of this cell? */
export function withinOwn(actor: Cells, ref: CellRef, value: string): boolean {
  if (ref.sub === null) return (RANK[value] ?? 0) <= (RANK[actor[ref.module]?.access] ?? 0);
  if (value !== "true") return true;
  return actor[ref.module]?.access !== "none" && actor[ref.module]?.sub[ref.sub] === true;
}

export type PowerRefusal = { code: "TARGET_IS_ADMIN" | "ADMIN_ROLE_ADMIN_ONLY" | "MANAGE_ACCESS_ADMIN_ONLY" | "BEYOND_OWN_ACCESS"; cells?: string[] };

/**
 * Why a power user may not make this change (null = allowed). `before` / `after` are the target's
 * effective cells; a cell counts as GAINED when its value rises (a higher level, an action turned on).
 */
export function powerUserRefusal(a: { actor: Cells; targetRole: string; desiredRole: string; before: Cells; after: Cells }): PowerRefusal | null {
  if (a.targetRole === "admin") return { code: "TARGET_IS_ADMIN" };
  if (a.desiredRole === "admin") return { code: "ADMIN_ROLE_ADMIN_ONLY" };
  if (holdsManageAccess(a.before) !== holdsManageAccess(a.after)) return { code: "MANAGE_ACCESS_ADMIN_ONLY", cells: [MANAGE_ACCESS_KEY] };
  const beyond: string[] = [];
  for (const ref of allCells()) {
    const from = getCell(a.before, ref);
    const to = getCell(a.after, ref);
    if (from === to) continue;
    const gained = ref.sub === null ? (RANK[to] ?? 0) > (RANK[from] ?? 0) : to === "true";
    if (gained && !withinOwn(a.actor, ref, to)) beyond.push(cellKey(ref));
  }
  return beyond.length ? { code: "BEYOND_OWN_ACCESS", cells: beyond } : null;
}

export const POWER_REFUSAL_TEXT: Record<PowerRefusal["code"], { ar: string; en: string }> = {
  TARGET_IS_ADMIN: { ar: "حساب مدير المنشأة يغيّر صلاحياته مدير المنشأة فقط. لم يُحفظ شيء.", en: "Only the administrator changes an administrator's access. Nothing was saved." },
  ADMIN_ROLE_ADMIN_ONLY: { ar: "دور «مدير المنشأة» يمنحه مدير المنشأة فقط. لم يُحفظ شيء.", en: "Only the administrator gives the administrator role. Nothing was saved." },
  MANAGE_ACCESS_ADMIN_ONLY: { ar: "صلاحية «مستخدم متقدّم» يمنحها أو يزيلها مدير المنشأة فقط. لم يُحفظ شيء.", en: "Only the administrator grants or removes the power-user permission. Nothing was saved." },
  BEYOND_OWN_ACCESS: { ar: "لا يمكنك منح صلاحية لا تملكها أنت. لم يُحفظ شيء.", en: "You cannot grant a permission you do not hold yourself. Nothing was saved." },
};
