// Owner security decision (16 Oct, Option A): a PRIVILEGED account signs in with its username
// AND its PIN (or username + password), never with a PIN alone, and must have a username.
// Pure: shared by sign-in, the session check, the account editor and the MFA report.
//
// The documented list — an account is privileged when ANY of these holds (effective
// permissions: stored permissions, or the role's defaults when none are stored):
//   · the admin role;
//   · any access to the finance or accounting modules (money and the books);
//   · user / permission / identity management: employees › create, edit or manage_access (the
//     "power user" who changes other users' permissions — owner decision 19 Oct);
//   · payroll and HR administration: hr › payroll_prepare, payroll_approve, payroll_pay,
//     payroll_cancel_approved, policy_manage, people_manage, private_view, contracts_manage,
//     offboard; and (orchestrator ruling on the re-test, AUTH-D) hr › recruit (it links logins),
//     documents_view, documents_manage, advances_manage, attendance_manage, leave_manage,
//     assets_manage, performance_manage;
//   · sensitive approvals and payments: hr › advances_approve, advances_disburse,
//     leave_approve, attendance_approve; commissions › approve, record_payout, manage_plans,
//     collection_verify, collection_reject, collection_reverse; sales › quote_approve_discount;
//   · destructive administration: settings › reset, training_reset;
//   · system administration: automation › manage_connection (which number sends, and whether).
//   · operations (owner decision, 16 Oct, DECISIONS-2026-10-16.md): inventory › adjust,
//     inventory › override, orders › approve — also step-up and verified-individual at action
//     time (requirePrivilegedAction).
// Everything else is an OPERATIONAL account, which may keep signing in with a PIN alone.
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { effectivePermissions } from "@/lib/hr/sod";

export const PRIVILEGED_MODULES = ["finance", "accounting"] as const;
export const PRIVILEGED_SUBS: [module: string, sub: string][] = [
  ["employees", "create"], ["employees", "edit"], ["employees", "manage_access"],
  ["hr", "payroll_prepare"], ["hr", "payroll_approve"], ["hr", "payroll_pay"], ["hr", "payroll_cancel_approved"],
  ["hr", "policy_manage"], ["hr", "people_manage"], ["hr", "private_view"], ["hr", "contracts_manage"], ["hr", "offboard"],
  ["hr", "recruit"], ["hr", "documents_view"], ["hr", "documents_manage"], ["hr", "advances_manage"], ["hr", "attendance_manage"],
  ["hr", "leave_manage"], ["hr", "assets_manage"], ["hr", "performance_manage"],
  ["hr", "advances_approve"], ["hr", "advances_disburse"], ["hr", "leave_approve"], ["hr", "attendance_approve"],
  ["commissions", "approve"], ["commissions", "record_payout"], ["commissions", "manage_plans"],
  ["commissions", "collection_verify"], ["commissions", "collection_reject"], ["commissions", "collection_reverse"],
  ["sales", "quote_approve_discount"],
  ["settings", "reset"], ["settings", "training_reset"],
  ["automation", "manage_connection"],
  ["inventory", "adjust"], ["inventory", "override"], ["orders", "approve"],
];

/** Why an account is privileged (empty = operational). Stable keys, for the audit and the report. */
export function privilegeReasons(permissions: Permissions, role: string): string[] {
  const out: string[] = [];
  if (role === "admin") out.push("role:admin");
  for (const m of PRIVILEGED_MODULES) if (hasModuleAccess(permissions, m)) out.push(`module:${m}`);
  for (const [m, sub] of PRIVILEGED_SUBS) if (hasModuleAccess(permissions, m) && hasSubPrivilege(permissions, m, sub)) out.push(`${m}.${sub}`);
  return out;
}

export function isPrivileged(permissions: Permissions, role: string): boolean {
  return privilegeReasons(permissions, role).length > 0;
}

/** The stored form of an account (permissions as stored, role) → privileged, exactly as the session will see it. */
export function isPrivilegedStored(storedPermissions: string | Permissions | null | undefined, role: string): boolean {
  return isPrivileged(effectivePermissions(storedPermissions as string | null, role), role);
}

/**
 * Usernames in normal form, identical to the database's auth_norm_username (migration
 * 20261016200000) and independent of any locale: NFKC; leading/trailing ASCII whitespace removed;
 * only ASCII A-Z folded to a-z (String#toLowerCase would also fold İ, Σ, … differently from the
 * database); blank is none.
 */
/**
 * Re-test follow-up 2 (look-alike usernames): after normalization a username is 3–64 characters
 * of [a-z0-9._-] only — the database CHECK (migration 20261016220000) holds the same rule.
 */
export const USERNAME_RULE = /^[a-z0-9._-]{3,64}$/;
export const usernameValid = (v: unknown) => { const n = normalizeUsername(v); return n !== null && USERNAME_RULE.test(n); };
export const USERNAME_INVALID = { error: "اسم المستخدم من 3 إلى 64 حرفًا: حروف إنجليزية صغيرة وأرقام و . _ - فقط.", errorEn: "A username is 3–64 characters: a–z, 0–9, dot, underscore or hyphen.", code: "USERNAME_INVALID" } as const;

export function normalizeUsername(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.normalize("NFKC").replace(/^[\u0020\u0009\u000A\u000B\u000C\u000D]+|[\u0020\u0009\u000A\u000B\u000C\u000D]+$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
  return t || null;
}

/**
 * Owner decision (16 Oct): a privileged permission is granted only to an INDIVIDUAL account —
 * one linked to a verified person. What `after` gains over `before` in privilege reasons
 * (empty = nothing privileged is newly granted). Stored forms, role defaults applied.
 */
export function gainedPrivileges(after: { permissions: string | null; role: string }, before: { permissions: string | null; role: string } | null): string[] {
  const now = privilegeReasons(effectivePermissions(after.permissions, after.role), after.role);
  const was = new Set(before ? privilegeReasons(effectivePermissions(before.permissions, before.role), before.role) : []);
  return now.filter((r) => !was.has(r));
}

/** The same grant without anything privileged it would newly add (for a login that is nobody's yet). */
export function withoutPrivileged(after: { permissions: string | null; role: string }, before: { permissions: string | null; role: string } | null): { permissions: string; role: string } {
  const gained = new Set(gainedPrivileges(after, before));
  const p = structuredClone(effectivePermissions(after.permissions, after.role)) as Permissions;
  for (const m of PRIVILEGED_MODULES) if (gained.has(`module:${m}`)) p[m] = { access: "none" } as never;
  for (const [m, sub] of PRIVILEGED_SUBS) {
    const mod = p[m] as { sub?: Record<string, boolean> } | undefined;
    if (gained.has(`${m}.${sub}`) && mod?.sub) mod.sub[sub] = false;
  }
  const role = gained.has("role:admin") ? (before?.role && before.role !== "admin" ? before.role : "custom") : after.role;
  return { permissions: JSON.stringify(p), role };
}
