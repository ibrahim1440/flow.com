// SIMPLE (single-owner) MODE — owner decision, 19 Oct 2026.
//
// The company currently has ONE person who is admin, accountant and payroll operator. The RC3.1
// controls that assume several people (verified identities, username + PIN sessions, PIN-only
// step-up, two-person approvals, segregation of duties, the Phase 1 payroll lock, disabled manual
// journals) cannot be satisfied by one person, so they are BYPASSED — not removed — while this
// switch is on. Every bypass in the code base goes through isSimpleMode() and carries a short
// "SIMPLE MODE" comment at its site, so the full controls come back by setting one environment
// variable (SIMPLE_MODE=off) once the team grows. Nothing was deleted.
//
// ON by default (no new environment variable is needed in production); OFF only when SIMPLE_MODE
// is exactly "off". Database-level guards are handled separately by the owner-run scripts
// scripts/release/simple-mode-db.sql (and simple-mode-db-revert.sql).
//
// Pure: no server dependencies, safe to import from client components.
import { buildDefaultPermissions, type Permissions } from "./auth-shared";

export function isSimpleMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.SIMPLE_MODE !== "off";
}

/**
 * Sign-in screen: the "username + PIN" and "PIN only" methods are hidden (their code and the
 * server routes stay). A separate constant because the login page is a client component and does
 * not see server environment variables. Flip to true to show the PIN methods again.
 */
export const SHOW_PIN_SIGN_IN = false;

/**
 * SIMPLE MODE: an account with the admin role holds EVERY module at "edit" and every
 * sub-privilege, whatever its stored permission document says. Any other role keeps its
 * permissions unchanged. With simple mode off, returns `permissions` as given.
 */
export function simpleModePermissions(permissions: Permissions, role: string | null | undefined, env: Record<string, string | undefined> = process.env): Permissions {
  if (!isSimpleMode(env) || role !== "admin") return permissions;
  return buildDefaultPermissions("admin");
}
