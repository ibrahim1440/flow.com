// P-3 segregation of duties — which duties one person may not hold together (owner decisions
// E4, Q-1, Q-2, Q-3, and owner decisions 1 and 2 of 16 Oct). Pure: shared by the
// permission-assignment API (server-side refusal), the employee editor (warning), the conflicts
// report and the permission-change approval.
//
// Payroll EXECUTION is four separate roles: preparation (Finance), final approval (management),
// payment recording (the designated operator) and post-approval cancellation (a separately
// authorized duty). Payroll ADMINISTRATION — the payroll policy / account map (policy_manage) —
// and PERMISSION GRANTING — creating accounts and editing their permissions — are separated from
// all four (decision 1a). Per run the payroll services enforce the execution separation again,
// whatever duties a person holds.
import { buildDefaultPermissions, hasModuleAccess, hasSubPrivilege, parsePermissions, type Permissions } from "@/lib/auth-shared";
import { isSimpleMode, simpleModePermissions } from "@/lib/simple-mode";

/** Payroll execution duties (HR sub-privileges). */
export const PAYROLL_SOD_DUTIES = ["payroll_prepare", "payroll_approve", "payroll_pay", "payroll_cancel_approved"] as const;
export type PayrollExecDuty = (typeof PAYROLL_SOD_DUTIES)[number];
/** Administration / permission-granting duties (decision 1a). */
// accounts_manage_access: the "power user" (employees › manage_access, owner decision 19 Oct) grants
// permissions to others, so it is a permission-granting duty under decision 1a too.
export const ADMIN_SOD_DUTIES = ["policy_manage", "accounts_create", "accounts_edit", "accounts_manage_access"] as const;
export type AdminDuty = (typeof ADMIN_SOD_DUTIES)[number];
export type PayrollSodDuty = PayrollExecDuty | AdminDuty;
export const SOD_DUTIES: PayrollSodDuty[] = [...PAYROLL_SOD_DUTIES, ...ADMIN_SOD_DUTIES];

/** Where each duty lives in the permission document. */
const SOURCE: Record<PayrollSodDuty, [module: string, sub: string]> = {
  payroll_prepare: ["hr", "payroll_prepare"],
  payroll_approve: ["hr", "payroll_approve"],
  payroll_pay: ["hr", "payroll_pay"],
  payroll_cancel_approved: ["hr", "payroll_cancel_approved"],
  policy_manage: ["hr", "policy_manage"],
  accounts_create: ["employees", "create"],
  accounts_edit: ["employees", "edit"],
  accounts_manage_access: ["employees", "manage_access"],
};

/** Pairs one person may not hold together. */
export const PAYROLL_CONFLICT_PAIRS: [PayrollSodDuty, PayrollSodDuty][] = [
  ["payroll_prepare", "payroll_approve"], // E4: nobody prepares and finally approves
  ["payroll_prepare", "payroll_pay"], // Q-1: preparer ≠ payment recorder
  ["payroll_approve", "payroll_pay"], // Q-1: approver ≠ payment recorder
  ["payroll_prepare", "payroll_cancel_approved"], // Q-2: post-approval cancellation is independent of preparation…
  ["payroll_approve", "payroll_cancel_approved"], // …and of approval
  ["payroll_pay", "payroll_cancel_approved"], // owner decision 2: recording payment ≠ cancelling an approved run
  // Owner decision 1a: payroll administration and permission granting ≠ any payroll execution duty.
  ...ADMIN_SOD_DUTIES.flatMap((a) => PAYROLL_SOD_DUTIES.map((x) => [a, x] as [PayrollSodDuty, PayrollSodDuty])),
];

export const PAYROLL_DUTY_AR: Record<PayrollSodDuty, string> = {
  payroll_prepare: "إعداد مسيرات الرواتب",
  payroll_approve: "اعتماد مسيرات الرواتب",
  payroll_pay: "تسجيل صرف الرواتب",
  payroll_cancel_approved: "إلغاء مسير معتمد",
  policy_manage: "إدارة سياسة الرواتب والإعدادات",
  accounts_create: "إنشاء الحسابات",
  accounts_edit: "تعديل صلاحيات الحسابات",
  accounts_manage_access: "مستخدم متقدّم · إدارة صلاحيات المستخدمين",
};

export const PAYROLL_DUTY_EN: Record<PayrollSodDuty, string> = {
  payroll_prepare: "Prepare payroll runs",
  payroll_approve: "Approve payroll runs",
  payroll_pay: "Record payroll payment",
  payroll_cancel_approved: "Cancel an approved run",
  policy_manage: "Manage payroll policy and settings",
  accounts_create: "Create accounts",
  accounts_edit: "Edit account permissions",
  accounts_manage_access: "Power user: manage other users' permissions",
};

/**
 * The permissions a stored value grants — EXACTLY the rule the session applies
 * (auth-server getUserWithPermissions): a string is parsed (unparseable → custom defaults), and
 * an absent, null or empty result means the ROLE's defaults (for admin: every duty).
 */
export function effectivePermissions(raw: string | Permissions | null | undefined, role: string): Permissions {
  let p: Permissions | null = raw == null ? null : typeof raw === "string" ? parsePermissions(raw) : raw;
  if (!p || typeof p !== "object" || Object.keys(p).length === 0) p = buildDefaultPermissions(role);
  // SIMPLE MODE: the admin role holds everything (the same rule the session applies).
  return simpleModePermissions(p, role);
}

/** The value the employees API stores for submitted permissions (same expression as the routes). */
export function storedPermissions(submitted: unknown): string {
  return typeof submitted === "string" ? submitted : JSON.stringify(submitted || {});
}

const holds = (p: Permissions, d: PayrollSodDuty) => {
  const [m, sub] = SOURCE[d];
  return hasModuleAccess(p, m) && hasSubPrivilege(p, m, sub);
};

/** The segregated duties (execution and administration) these permissions effectively grant. */
export function payrollDuties(p: Permissions): PayrollSodDuty[] {
  return SOD_DUTIES.filter((d) => holds(p, d));
}

/** The conflicting duty pairs these permissions hold. */
export function payrollDutyConflicts(p: Permissions): [PayrollSodDuty, PayrollSodDuty][] {
  return PAYROLL_CONFLICT_PAIRS.filter(([a, b]) => holds(p, a) && holds(p, b));
}

/** Conflicts `after` holds that `before` did not — a change may keep an existing pair (until reviewed) but never add one. */
export function newPayrollConflicts(before: Permissions | null, after: Permissions): [PayrollSodDuty, PayrollSodDuty][] {
  const had = new Set((before ? payrollDutyConflicts(before) : []).map(([a, b]) => `${a}|${b}`));
  return payrollDutyConflicts(after).filter(([a, b]) => !had.has(`${a}|${b}`));
}

export function conflictMessageEn(pairs: [PayrollSodDuty, PayrollSodDuty][]): string {
  return `One person may not hold both ${pairs.map(([a, b]) => `“${PAYROLL_DUTY_EN[a]}” and “${PAYROLL_DUTY_EN[b]}”`).join(", nor ")}.`;
}

export function conflictMessageAr(pairs: [PayrollSodDuty, PayrollSodDuty][]): string {
  return `لا يجمع شخص واحد بين ${pairs.map(([a, b]) => `«${PAYROLL_DUTY_AR[a]}» و«${PAYROLL_DUTY_AR[b]}»`).join("، ولا بين ")}.`;
}

/** The refusal the permission-assignment API raises for new conflicting duties (Q-3). */
export class DutyConflictError extends Error {
  readonly status = 409;
  readonly code = "SOD_DUTY_CONFLICT";
  constructor(readonly conflicts: [PayrollSodDuty, PayrollSodDuty][]) {
    super(conflictMessageAr(conflicts));
    this.name = "DutyConflictError";
  }
}

export type AccountGrant = { permissions: string | null; role: string };

/**
 * Server-side check for an assignment (Q-3; QA P1-1). Compares the EFFECTIVE permissions after
 * the change — the stored or submitted permissions combined with the resulting role's defaults —
 * with the effective permissions before it, so a role-only change (custom → admin with empty
 * permissions) or empty / "{}" / "null" permissions cannot slip through. A change may keep a
 * pair the account already had (existing assignments stay until reviewed and are listed by the
 * conflicts report) but never add one. Returns the effective duty change for the audit.
 */
export function assertNoNewPayrollConflicts(after: AccountGrant, before: AccountGrant | null): { before: PayrollSodDuty[]; after: PayrollSodDuty[] } {
  const prior = before ? effectivePermissions(before.permissions, before.role) : null;
  const next = effectivePermissions(after.permissions, after.role);
  // SIMPLE MODE: one person may hold every payroll duty (no duty-conflict refusal).
  const added = isSimpleMode() ? [] : newPayrollConflicts(prior, next);
  if (added.length) throw new DutyConflictError(added);
  return { before: prior ? payrollDuties(prior) : [], after: payrollDuties(next) };
}

// ── Owner decision 1b: grants of sensitive duties need a second person ─────────────────

/**
 * What a change GRANTS that needs independent approval: any segregated duty the account did not
 * effectively hold before, and becoming an `admin` (a role other modules trust directly).
 * Revocations are not grants: they apply at once (and are audited), so an incident can be
 * contained without waiting for a second person.
 */
export function sensitiveGrants(after: AccountGrant, before: AccountGrant | null): { duties: PayrollSodDuty[]; toAdmin: boolean; subs: ReviewedGrantSub[] } {
  const prior = before ? effectivePermissions(before.permissions, before.role) : null;
  const next = effectivePermissions(after.permissions, after.role);
  const had = new Set(prior ? payrollDuties(prior) : []);
  const duties = payrollDuties(next).filter((d) => !had.has(d));
  const subs = REVIEWED_GRANT_SUBS.filter((k) => holdsSub(next, k) && !(prior && holdsSub(prior, k)));
  // SIMPLE MODE: no grant waits for a second account editor — it applies at once (and is audited).
  if (isSimpleMode()) return { duties: [], toAdmin: false, subs: [] };
  return { duties, toAdmin: after.role === "admin" && before?.role !== "admin", subs };
}

/**
 * Privileged permissions outside the payroll duties whose GRANT also waits for a second account
 * editor (owner decision 16 Oct, inventory privileges Option A): stock adjustment and inventory
 * override are granted only individually, to an authorised supervisor, through this flow — never
 * by one editor, never by a role default, never automatically.
 */
export const REVIEWED_GRANT_SUBS = ["inventory.adjust", "inventory.override"] as const;
export type ReviewedGrantSub = (typeof REVIEWED_GRANT_SUBS)[number];
export const REVIEWED_GRANT_SUB_AR: Record<ReviewedGrantSub, string> = { "inventory.adjust": "تعديل المخزون (جرد)", "inventory.override": "تجاوز المخزون (إعادة بن دفعة ملغاة)" };
export const REVIEWED_GRANT_SUB_EN: Record<ReviewedGrantSub, string> = { "inventory.adjust": "Stock adjustment", "inventory.override": "Inventory override (restock a cancelled roast)" };
const holdsSub = (p: Permissions, key: string) => {
  const [m, sub] = key.split(".");
  return hasModuleAccess(p, m) && hasSubPrivilege(p, m, sub);
};
/** The reviewed-grant subs an account effectively holds (stored permissions, or its role default). */
export function heldReviewedSubs(g: AccountGrant): ReviewedGrantSub[] {
  const p = effectivePermissions(g.permissions, g.role);
  return REVIEWED_GRANT_SUBS.filter((k) => holdsSub(p, k));
}

/**
 * The grant that may apply AT ONCE while the sensitive part waits for approval: the requested
 * effective permissions with every newly granted segregated duty switched off, stored explicitly
 * (so role defaults cannot re-grant them), and the previous role kept if the change would make
 * the account an admin.
 */
export function withoutSensitiveGrants(after: AccountGrant, before: AccountGrant | null): AccountGrant {
  const g = sensitiveGrants(after, before);
  const p = structuredClone(effectivePermissions(after.permissions, after.role)) as Permissions;
  for (const d of g.duties) {
    const [m, sub] = SOURCE[d];
    const mod = p[m];
    if (mod?.sub) mod.sub[sub] = false;
  }
  for (const k of g.subs) {
    const [m, sub] = k.split(".");
    const mod = p[m];
    if (mod?.sub) mod.sub[sub] = false;
  }
  return { permissions: JSON.stringify(p), role: g.toAdmin ? (before?.role && before.role !== "admin" ? before.role : "custom") : after.role };
}
