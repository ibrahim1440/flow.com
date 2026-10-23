// Workstations W2 — the pure access rules of a station (no database, no server): what a station
// session may hold, who appears on a station's tiles, the PIN lockout and the idle end, and the
// UR-13 «الآن» state. Shared by the guard, the admin screens and the unit tests.
import { canEdit, hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { PRIVILEGED_MODULES, PRIVILEGED_SUBS } from "@/lib/auth/privileged";
import { STATION_PRIVILEGE, type StationType } from "./device";

/**
 * A station session never exercises a privileged key (SOD.md §19: privileged keys are held by
 * verified individuals at their own sessions). The station actor's permissions are the employee's
 * effective permissions with every privileged module and sub removed.
 */
export function stationPermissions(perms: Permissions): Permissions {
  const out: Permissions = {};
  for (const [m, p] of Object.entries(perms ?? {})) {
    if ((PRIVILEGED_MODULES as readonly string[]).includes(m)) continue;
    const sub = { ...(p.sub ?? {}) };
    for (const [pm, ps] of PRIVILEGED_SUBS) if (pm === m) delete sub[ps];
    out[m] = { ...p, sub };
  }
  return out;
}

/** The module privilege the station's work needs (UR-13 «الإجراءات فيها», UR-S17). */
export function holdsStationPrivilege(perms: Permissions, type: StationType): boolean {
  const need = STATION_PRIVILEGE[type];
  if (!need) return false;
  return need.sub ? hasModuleAccess(perms, need.module) && hasSubPrivilege(perms, need.module, need.sub) : canEdit(perms, need.module);
}

/** One more wrong PIN: the new count and whether it locks (D7: locked at the policy limit). */
export function afterWrongPin(failedCount: number, maxAttempts: number): { failedCount: number; locked: boolean } {
  const n = Math.max(0, failedCount) + 1;
  return { failedCount: n, locked: n >= maxAttempts };
}

/** D7: a station session unused for idleMinutes ends (back to the employee tiles). */
export function stationIdleExpired(lastSeenAt: Date, now: number, idleMinutes: number): boolean {
  return now - lastSeenAt.getTime() > idleMinutes * 60_000;
}

/**
 * Who appears on a station's S2 tiles (UR-S18, D12): an active account assigned to the station,
 * with a station PIN set, that is not the admin role. Nothing else decides it (a missing module
 * privilege still shows the name — UR-S17 — and the station refuses the work).
 */
export function onRoster(e: { active: boolean; role: string; hasPin: boolean; assigned: boolean }): boolean {
  return e.active && e.assigned && e.hasPin && !isAdminRole(e.role);
}

/**
 * D12: the admin role never signs in at a station device (SIMPLE MODE would otherwise bypass every
 * check). The SUBJECT's role — a refusal, never a grant: the station refuses, the roster leaves the
 * name out, UR-13 refuses the assignment (privileged-route inventory: LIB_ROLE_CHECKS).
 */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin";
}

/** UR-13 «الآن»: can this person sign in at the station now, and if not, why (first reason). */
export type AccessNow = "can_sign_in" | "not_allowed" | "admin" | "inactive" | "no_pin" | "locked" | "no_privilege";
export function accessNow(a: { allowed: boolean; admin: boolean; active: boolean; hasPin: boolean; locked: boolean; holdsPrivilege: boolean }): AccessNow {
  if (!a.allowed) return "not_allowed";
  if (a.admin) return "admin";
  if (!a.active) return "inactive";
  if (!a.hasPin) return "no_pin";
  if (a.locked) return "locked";
  if (!a.holdsPrivilege) return "no_privilege";
  return "can_sign_in";
}
