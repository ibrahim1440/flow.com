import { cookies } from "next/headers";
import { withArabicError } from "@/lib/i18n/api-errors";
import { credentialVersion } from "./credential-version";
import { NextResponse } from "next/server";
import { verifyToken, parsePermissions, buildDefaultPermissions, hasModuleAccess, canEdit, hasSubPrivilege, type UserPayload, type Permissions } from "./auth";
import { prisma } from "./db";
import { checkSession, revokeSession, freshEnough, REAUTH_AR, REAUTH_EN, type SessionMethod } from "./auth/session";
import { isPrivileged, PRIVILEGED_MODULES, PRIVILEGED_SUBS } from "./auth/privileged";
import { mfaMode } from "./auth/mfa";
import { stockChangeRefusal, stockAuthSnapshot } from "./auth/stock-change";
import { isBcryptHash } from "./auth/secret";
import { isSimpleMode, simpleModePermissions } from "./simple-mode";

export async function getUser(): Promise<UserPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) return null;
  return verifyToken(token);
}

/**
 * The authenticated caller, with authorization state read live from the database.
 *
 * The token proves WHO is calling. It does not decide what they may do.
 *
 * It used to decide half of it. Permissions were re-read here — good — but `active` was
 * never selected and `role` was taken from the token, so two things survived that should
 * not have. Deactivating an employee left them working normally until their token expired,
 * up to eight hours later: the one control an operations manager reaches for when somebody
 * leaves, or when a device goes missing, did nothing they could observe. And demoting an
 * admin left `role: "admin"` in a signed token that no later change could contradict —
 * which is the field that gates employee deletion and the production surplus override.
 *
 * So the rule is now the whole rule: the subject comes from the token, and existence,
 * active state, role and permissions all come from the row. A revoked account is
 * unauthenticated on its very next request.
 *
 * The cost is nothing new — this query already ran on every authenticated request; it
 * simply selects three columns instead of one.
 */
export type SessionUser = UserPayload & {
  permissions: Permissions;
  /** The live session: its last strong authentication (step-up) and how it signed in. */
  authTime: Date;
  sessionId: string;
  sessionMethod: SessionMethod;
  sessionMfa: boolean;
  /** PIN | PASSWORD | null: the secret of the session's last strong authentication. */
  authFactor: "PIN" | "PASSWORD" | null;
  privileged: boolean;
  /** AUTH_MFA_MODE=required and a privileged account without MFA: it may only enroll. */
  mfaEnrollmentRequired: boolean;
  /** An administrator issued a temporary password: the account may only set its own (UR-03e / UR-04). */
  passwordChangeRequired: boolean;
};

export async function getUserWithPermissions(): Promise<SessionUser | null> {
  const user = await getUser();
  if (!user) return null;

  let employee = await prisma.employee.findUnique({
    where: { id: user.id },
    select: {
      active: true, role: true, permissions: true, username: true, pin: true, password: true, passwordMustChange: true,
      // An exception past its expiry stops applying at once (Figma UR-09, owner §9.2): settled here,
      // before this request is judged, so no session keeps an expired grant.
      permissionOverrides: { where: { endedAt: null, expiresAt: { lte: new Date() } }, select: { id: true }, take: 1 },
    },
  });
  if (employee && employee.permissionOverrides.length) {
    const { settleExpiredOverrides } = await import("./users/overrides");
    await settleExpiredOverrides(user.id);
    employee = await prisma.employee.findUnique({
      where: { id: user.id },
      select: { active: true, role: true, permissions: true, username: true, pin: true, password: true, passwordMustChange: true, permissionOverrides: { where: { id: "-" }, select: { id: true } } },
    });
  }

  // Deleted, or deactivated since the token was issued. Both resolve as not authenticated
  // rather than as forbidden: there is no live account behind this request at all.
  if (!employee || !employee.active) return null;
  // Credentials changed since the token was issued (password, PIN or username reset): every
  // earlier session ends (QA P1-B — a reset applied by a second person revokes the old ones).
  if (user.cv !== credentialVersion({ id: user.id, ...employee })) return null;
  // Owner security decision: the token is a pointer to a server-side session. Logout, expiry
  // (idle 4 h, absolute 12 h) and revocation end it on the next request.
  const session = await checkSession(user.sid, user.id);
  if (!session) return null;

  let permissions = parsePermissions(employee.permissions as string);
  if (!permissions || Object.keys(permissions).length === 0) {
    permissions = buildDefaultPermissions(employee.role);
  }
  // SIMPLE MODE: the admin role holds every module and sub-privilege (client nav reads this too).
  permissions = simpleModePermissions(permissions, employee.role);
  const privileged = isPrivileged(permissions, employee.role);
  // A privileged account never works through a PIN-only session: if it became privileged after
  // signing in that way, the session ends here (and the promotion itself revokes them).
  if (privileged && session.method === "PIN") {
    await revokeSession(session.id, "PRIVILEGED_PIN_ONLY");
    return null;
  }
  // SIMPLE MODE: two-step verification stays optional (never forced by AUTH_MFA_MODE=required).
  const mfaEnrollmentRequired = !isSimpleMode() && privileged && mfaMode() === "required" && !(await prisma.authMfa.findUnique({ where: { employeeId: user.id }, select: { enrolledAt: true } }))?.enrolledAt;
  // The live role overwrites the token's copy, so every `user.role === "admin"` call site
  // downstream reads current state without any of them having to know that.
  return { ...user, role: employee.role, permissions, authTime: session.authTime, sessionId: session.id, sessionMethod: session.method, sessionMfa: session.mfa, authFactor: session.authFactor, privileged, mfaEnrollmentRequired, passwordChangeRequired: employee.passwordMustChange };
}

// DEF-08/09: the English `error` is unchanged; `errorAr` is added when the message is known.
export function unauthorized(msg = "Not authenticated") {
  return NextResponse.json(withArabicError({ error: msg }), { status: 401 });
}

export function forbidden(msg = "Insufficient permissions") {
  return NextResponse.json(withArabicError({ error: msg }), { status: 403 });
}

export async function requireAuth(opts: { allowMfaEnrollment?: boolean; allowPasswordChange?: boolean } = {}) {
  const user = await getUserWithPermissions();
  if (!user) return { user: null as never, error: unauthorized() };
  if (user.mfaEnrollmentRequired && !opts.allowMfaEnrollment) {
    return { user: null as never, error: NextResponse.json({ error: "يجب تفعيل التحقق بخطوتين لهذا الحساب أولًا.", errorEn: "Two-step verification must be set up for this account first.", code: "MFA_ENROLLMENT_REQUIRED" }, { status: 403 }) };
  }
  // A temporary password (UR-03e / UR-04): until the person sets their own, the only things the
  // account may do are set it (PUT /api/profile/password), confirm its identity and sign out.
  if (user.passwordChangeRequired && !opts.allowPasswordChange) {
    return { user: null as never, error: NextResponse.json({ error: "يجب تغيير كلمة المرور المؤقتة أولًا.", errorEn: "Change the temporary password first.", code: "PASSWORD_CHANGE_REQUIRED" }, { status: 403 }) };
  }
  return { user, error: null };
}

/** Step-up for a sensitive route: 401 REAUTH_REQUIRED unless the session authenticated recently. */
export function requireFreshAuth(user: { authTime?: Date | string }) {
  if (freshEnough(user.authTime)) return null;
  return NextResponse.json({ error: REAUTH_AR, errorEn: REAUTH_EN, code: "REAUTH_REQUIRED" }, { status: 401 });
}

/**
 * Owner decision (16 Oct) and the orchestrator's ruling: EVERY privileged permission
 * (src/lib/auth/privileged.ts) is exercised only by an INDIVIDUAL account — a login linked to a
 * verified person (Option A; the codebase has no shared / station account marker). An unverified
 * holder keeps the permission but is refused when exercising it (403 IDENTITY_NOT_VERIFIED,
 * audited IDENTITY_NOT_VERIFIED_REFUSED with the step) and is listed as blocked in the report.
 * The sensitive approvals and payments also need a recent step-up (401 REAUTH_REQUIRED, which the
 * dashboard dialog handles and retries) — the keys in STEP_UP_KEYS.
 *
 * Applied centrally: requireSub (every route guarded by a privileged sub), financeHandler (every
 * finance mutation), hrHandler (every non-self HR mutation by a privileged actor), and inline where
 * a route checks a privileged sub itself. The route inventory is in docs/hr/SOD.md §19.
 */
export const STEP_UP_KEYS: ReadonlySet<string> = new Set([
  "commissions.approve", "commissions.record_payout",
  "sales.quote_approve_discount",
  "settings.reset", "settings.training_reset",
  "inventory.adjust", "inventory.override", "orders.approve",
  "accounting.journal_approve", "accounting.journal_post", "accounting.journal_reverse", "accounting.period_lock", "accounting.period_close",
  "finance.budget_approve", "finance.transfer_approve", "finance.spend_override_approve", "finance.period_close", "finance.payment",
  // Owner decision 19 Oct: a power user changing another account's access steps up like the administrator.
  "employees.manage_access",
  // Owner decision D2 (production simplification): the exceptional QC approval steps up.
  "qc.finalize_override",
]);

/** Is `module.sub` (or the whole module) a privileged permission? */
export function isPrivilegedKey(module: string, sub?: string): boolean {
  return (PRIVILEGED_MODULES as readonly string[]).includes(module) || (!!sub && PRIVILEGED_SUBS.some(([m, s]) => m === module && s === sub));
}

export const IDENTITY_REQUIRED_AR = "حسابك غير مرتبط بشخص موثّق الهوية؛ هذه الصلاحية تُمارس من حساب فردي موثّق فقط.";

/** The gate itself: verified individual (audited with `step`), then — when asked — a recent step-up. */
export async function requirePrivilegedAction(user: { id: string; authTime?: Date | string }, step: string, opts: { stepUp?: boolean } = {}): Promise<NextResponse | null> {
  // SIMPLE MODE: no verified identity is required; a recent step-up (PIN or password) still is.
  if (isSimpleMode()) return opts.stepUp === false ? null : requireFreshAuth(user);
  const { assertVerifiedActor } = await import("./hr/identity");
  try {
    await assertVerifiedActor(user, step);
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    return NextResponse.json({ error: IDENTITY_REQUIRED_AR, errorEn: err.message ?? "Not a verified individual account.", code: err.code ?? "IDENTITY_NOT_VERIFIED" }, { status: err.status ?? 403 });
  }
  return opts.stepUp === false ? null : requireFreshAuth(user);
}

/** The gate for a permission key: identity always (privileged keys), step-up for STEP_UP_KEYS. */
export async function privilegedGate(user: { id: string; authTime?: Date | string }, module: string, sub?: string): Promise<NextResponse | null> {
  if (!isPrivilegedKey(module, sub)) return null;
  const key = sub ? `${module}.${sub}` : module;
  return requirePrivilegedAction(user, key, { stepUp: STEP_UP_KEYS.has(key) });
}

/** The same gate, thrown (for a check that happens inside a service or transaction). */
export async function assertPrivilegedGate(user: { id: string; authTime?: Date | string }, module: string, sub?: string): Promise<void> {
  const refused = await privilegedGate(user, module, sub);
  if (refused) {
    const body = (await refused.clone().json()) as { error: string; errorEn?: string; code?: string };
    throw { _appCode: refused.status, message: body.error, errorEn: body.errorEn, code: body.code };
  }
}

/**
 * Owner decision 4 (17 Oct): the gate of a PRIVILEGED STOCK CHANGE — `inventory › adjust` (a stock
 * count / adjustment) or `inventory › override` (the restock of a cancelled roast). The checks and
 * their order are in src/lib/auth/stock-change.ts: the sub; a verified identity; independent
 * approval evidence (non-admin holders); a username + real PIN; a username + PIN session; a fresh
 * step-up made with the PIN. The admin role is exempt from the evidence step only. Every refusal is
 * bilingual with a stable code; every refusal after the sub check is audited
 * (INVENTORY_PRIVILEGED_REFUSED; IDENTITY_NOT_VERIFIED_REFUSED for the identity step). A refusal
 * audit is best effort — the refusal stands either way — and a failure to write it is logged.
 */
export async function stockChangeGate(
  user: { id: string; role?: string; permissions: Permissions; authTime?: Date | string; sessionMethod?: SessionMethod; sessionMfa?: boolean; sessionId?: string; authFactor?: "PIN" | "PASSWORD" | null },
  module: "inventory",
  sub: "adjust" | "override",
): Promise<NextResponse | null> {
  const step = `${module}.${sub}`;
  const holdsSub = hasModuleAccess(user.permissions, module) && hasSubPrivilege(user.permissions, module, sub);
  // SIMPLE MODE: holding the sub is enough, plus a recent step-up made with the PIN OR the password —
  // no verified identity, approval evidence, username + PIN credential or username + PIN session.
  if (isSimpleMode()) {
    if (!holdsSub) {
      const r = stockChangeRefusal(sub, { holdsSub, verified: false, approved: false, username: null, pin: null, sessionMethod: user.sessionMethod, authFactor: user.authFactor, authTime: user.authTime });
      return NextResponse.json({ error: r!.error, errorEn: r!.errorEn, code: r!.code }, { status: r!.status });
    }
    return requireFreshAuth(user);
  }
  let verified = false;
  if (holdsSub) {
    const { assertVerifiedActor } = await import("./hr/identity");
    // Audits IDENTITY_NOT_VERIFIED_REFUSED itself when it refuses.
    verified = await assertVerifiedActor(user, step).then(() => true, () => false);
  }
  const account = holdsSub && verified ? await prisma.employee.findUnique({ where: { id: user.id }, select: { username: true, pin: true, role: true } }) : null;
  let approved = false;
  if (account) {
    if (account.role === "admin") approved = true;
    else {
      const { evidencedSubs } = await import("./inventory/privilege-evidence");
      const q = <T,>(sql: string, params: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...params);
      approved = (await evidencedSubs(q, { id: user.id, role: account.role })).includes(sub);
    }
  }
  const refusal = stockChangeRefusal(sub, { holdsSub, verified, approved, username: account?.username, pin: account?.pin, sessionMethod: user.sessionMethod, authFactor: user.authFactor, authTime: user.authTime });
  if (!refusal) return null;
  if (holdsSub && verified) {
    const { audit } = await import("./hr/core");
    await audit(prisma, { action: "INVENTORY_PRIVILEGED_REFUSED", entityType: "Employee", entityId: user.id, actorId: user.id, after: { step, code: refusal.code, approved, auth: stockAuthSnapshot(user), credential: { username: !!account?.username, pin: isBcryptHash(account?.pin) } } })
      .catch((e: unknown) => console.error(`[stockChangeGate] refusal audit not written (${step}, ${refusal.code}):`, e instanceof Error ? e.message : e));
  }
  return NextResponse.json({ error: refusal.error, errorEn: refusal.errorEn, code: refusal.code, ...("factor" in refusal ? { factor: refusal.factor } : {}) }, { status: refusal.status });
}

/**
 * The admin role is privileged too (`role:admin` in privileged.ts), so a route that checks the
 * ROLE rather than a permission sub exercises it under the same rule: a verified individual
 * (audited with the step `role:admin <step>`), plus a recent step-up on the destructive or
 * sensitive ones. adminRoleGate gates an admin path that has already been chosen (an ownership or
 * surplus override); requireAdminAction is the whole check for an admin-only action. The route
 * inventory (scripts/auth/privileged-route-inventory.ts) fails on a role check that uses neither.
 */
export async function adminRoleGate(user: { id: string; authTime?: Date | string }, step: string, opts: { stepUp?: boolean } = {}): Promise<NextResponse | null> {
  return requirePrivilegedAction(user, `role:admin ${step}`, { stepUp: opts.stepUp ?? false });
}

/** Admin-only action: 403 for any other role, then the admin-role gate. */
export async function requireAdminAction(user: { id: string; role: string; authTime?: Date | string }, step: string, opts: { stepUp?: boolean; message?: string } = {}): Promise<NextResponse | null> {
  if (user.role !== "admin") return forbidden(opts.message);
  return adminRoleGate(user, step, opts);
}

/** The admin-role gate, thrown (for an override decided inside a transaction). */
export async function assertAdminRoleGate(user: { id: string; authTime?: Date | string }, step: string, opts: { stepUp?: boolean } = {}): Promise<void> {
  const refused = await adminRoleGate(user, step, opts);
  if (refused) {
    const body = (await refused.clone().json()) as { error: string; errorEn?: string; code?: string };
    throw { _appCode: refused.status, message: body.error, errorEn: body.errorEn, code: body.code };
  }
}

export async function requireModule(module: string) {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  if (!hasModuleAccess(user.permissions, module)) {
    return { user: null as never, error: forbidden() };
  }
  return { user, error: null };
}

export async function requireEdit(module: string) {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  if (!canEdit(user.permissions, module)) {
    return { user: null as never, error: forbidden() };
  }
  return { user, error: null };
}

export async function requireSub(module: string, subKey: string) {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  if (!hasSubPrivilege(user.permissions, module, subKey)) {
    return { user: null as never, error: forbidden() };
  }
  // A privileged permission is exercised by a verified individual only (and, for the sensitive
  // approvals and payments, after a recent step-up).
  const refused = await privilegedGate(user, module, subKey);
  if (refused) return { user: null as never, error: refused };
  return { user, error: null };
}

/**
 * Any one of several subs of a module. The first OPERATIONAL sub the caller holds lets them through
 * with no further check; a caller who holds only privileged ones goes through the gate of the first
 * of those (verified individual, and step-up for STEP_UP_KEYS). Used where a routine duty and a
 * privileged one may both do the same thing — the inventory catalogue (bean records, suppliers) is
 * maintained by `inventory › receive`, and an `inventory › adjust` holder may still do it.
 */
export async function requireAnySub(module: string, subKeys: string[]) {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  const held = subKeys.filter((s) => hasSubPrivilege(user.permissions, module, s));
  if (held.length === 0) return { user: null as never, error: forbidden() };
  if (held.some((s) => !isPrivilegedKey(module, s))) return { user, error: null };
  const refused = await privilegedGate(user, module, held[0]);
  if (refused) return { user: null as never, error: refused };
  return { user, error: null };
}

// Read-only cross-module access: grants access when the user has ANY of the
// listed modules. Used so workflow stages can read relational data (bean names,
// order details, batch records) without needing permissions on the source module.
export async function requireAnyModule(...modules: string[]) {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  const allowed = modules.some((m) => hasModuleAccess(user.permissions, m));
  if (!allowed) return { user: null as never, error: forbidden() };
  return { user, error: null };
}

export { credentialVersion };
