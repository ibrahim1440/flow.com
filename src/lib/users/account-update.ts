// The one path that changes an existing account (role, permissions, credentials, active state):
// PUT /api/employees/[id] and the users & roles screens (/api/users/*) both run it, so every
// existing control — the payroll-duty conflicts (Q-3), the second-person grant flow (owner decision
// 1b), the verified-individual rule for privileged grants (16 Oct), the held credential changes
// (QA2 P1-B), the row lock and the audit with its exact diff — applies identically to both.
//
// Moved verbatim from src/app/api/employees/[id]/route.ts (batch "Users & roles"), with these
// additions that hold on BOTH paths:
//   · who changes access (owner decision 19 Oct): a change of another account's role, permissions or
//     custom role is made by the administrator or by a power user (employees › manage_access) within
//     the power-user guardrails (src/lib/users/power.ts) — employees › edit alone no longer does;
//   · no self-elevation (P-4, UR-S08): nobody changes their own role, permissions, custom role or
//     active state — refused before anything is written;
//   · the last active administrator stays an active administrator (UR-S09);
//   · the custom role an account follows (Employee.accessRoleId), and an optional hook that runs in
//     the same transaction after the update (the screens record the exceptions behind the change).
import { NextResponse } from "@/lib/api-response";
import { hash } from "bcryptjs";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireFreshAuth, requirePrivilegedAction, type SessionUser } from "@/lib/auth-server";
import { isEnrolled } from "@/lib/auth/mfa";
import { handlePrismaError } from "@/lib/api-error";
import { isPinLookupConflict, pinSetThrottle, pinUnavailable } from "@/lib/pin-set-guard";
import { setFreshSession } from "@/lib/session-cookie";
import { identityOf, loginAttested, SUBJECT_NOT_VERIFIED_EN } from "@/lib/hr/identity";
import { gainedPrivileges, isPrivilegedStored, normalizeUsername, usernameValid, USERNAME_INVALID } from "@/lib/auth/privileged";
import { revokeSessions } from "@/lib/auth/session";
import { recordEmployeeAudit, diffEmployeeChange, lockEmployeeForAdmin } from "@/lib/services/employee-audit";
import { extractIp, hashRateLimitKey } from "@/lib/rate-limit";
import { validatePin } from "@/lib/pin-policy";
import { pinLookup, pinVerifierInput, requirePinLookupSecret } from "@/lib/pin-lookup";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { assertNoNewPayrollConflicts, conflictMessageEn, DutyConflictError, heldReviewedSubs, payrollDuties, effectivePermissions, sensitiveGrants, storedPermissions, withoutSensitiveGrants } from "@/lib/hr/sod";
import { recordRevocationReviewIn, requestPermissionChangeIn, type CredentialChange } from "@/lib/hr/services/permission-change";
import { hasSubPrivilege, ROLE_LABELS } from "@/lib/auth-shared";
import { isSimpleMode } from "@/lib/simple-mode";
import { HrError } from "@/lib/hr/core";
import { toArabic } from "@/lib/hr/messages-ar";
import { diffCells, effectiveCells, normalize } from "./model";
import { LAST_ADMIN, SELF_ACCESS, ACCESS_MANAGER_ONLY, OTHER_FIELDS_NEED_EDIT, UsersError } from "./errors";
import { accessActor, powerUserRefusal, POWER_REFUSAL_TEXT } from "./power";

/** A privileged grant to a login that is not a verified person (audited after the rollback). */
class GrantRefused extends Error {
  constructor(readonly accountId: string, readonly privileged: string[]) { super("SUBJECT_NOT_VERIFIED"); }
}

/** Actor plus a hashed address — the same treatment login attempts already give one. */
export function auditContext(request: Request, actorId: string) {
  return {
    actorId,
    ipHash: hashRateLimitKey(extractIp(request)),
    userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
  };
}

/** The number automated WhatsApp messages reach this employee on. Stored as typed; refused
 *  only when no WhatsApp number could ever be read from it. */
function phoneNumberError(phoneNumber: unknown): string | null {
  if (phoneNumber === undefined || phoneNumber === null || phoneNumber === "") return null;
  if (typeof phoneNumber !== "string" || phoneNumber.length > 30) return "Invalid phone number.";
  const p = normalizePhoneForWhatsApp(phoneNumber);
  return p.ok ? null : `Phone number: ${p.reason}`;
}

export const SELECT_FULL = {
  id: true, name: true, username: true, role: true, permissions: true,
  defaultRoute: true, active: true, createdAt: true, phoneNumber: true,
} as const;

export const ALLOWED_DEFAULT_ROUTES = new Set([
  "/dashboard",
  "/dashboard/inventory",
  "/dashboard/orders",
  "/dashboard/production",
  "/dashboard/qc",
  "/dashboard/packaging",
  "/dashboard/dispatch",
  "/dashboard/history",
  "/dashboard/analytics",
  "/dashboard/labels",
  "/dashboard/employees",
  "/dashboard/customers",
  "/dashboard/purchases",
  "/dashboard/settings",
  "/dashboard/profile",
]);

/** Friendly pre-check on the keyed lookup; UNIQUE(pinLookup) is the real arbiter. */
async function isPinTaken(lookup: string, excludeId: string): Promise<boolean> {
  const existing = await prisma.employee.findFirst({
    where: { pinLookup: lookup, id: { not: excludeId } },
    select: { id: true },
  });
  return existing !== null;
}

/** A refused conflicting payroll-duty assignment (Q-3): named duties, and an audit row without credentials. */
async function dutyConflictResponse(e: DutyConflictError, actorId: string, targetId: string) {
  await prisma.hrAuditLog.create({ data: { action: "HR_DUTY_CONFLICT_REFUSED", entityType: "Employee", entityId: targetId, after: { conflicts: e.conflicts }, actorId } }).catch(() => undefined);
  return NextResponse.json({ error: e.message, errorEn: conflictMessageEn(e.conflicts), code: e.code, conflicts: e.conflicts }, { status: e.status });
}

/** The fields an account change may carry (the PUT body of /api/employees/[id]). */
export type AccountChangeBody = {
  name?: unknown; username?: unknown; role?: unknown; permissions?: unknown; pin?: unknown; password?: unknown;
  defaultRoute?: unknown; active?: unknown; phoneNumber?: unknown; reason?: unknown; confirmReviewedSubs?: unknown;
};

export type AccountChangeOptions = {
  /** The custom role the account follows after the change (undefined = unchanged, null = none). */
  accessRoleId?: string | null;
  /** Merged into the metadata of every audit event this change writes (reason, the screen, …). */
  auditExtra?: Record<string, unknown>;
  /** Runs in the same transaction, after the update, before the commit. */
  afterUpdate?: (tx: Prisma.TransactionClient, ctx: { before: { role: string; permissions: string; active: boolean }; updated: { id: string; name: string; role: string; permissions: string; active: boolean }; pending: boolean }) => Promise<void>;
};

/** Is any other account an active administrator? (UR-S09, read under the target's row lock.) */
export async function otherActiveAdmins(tx: Prisma.TransactionClient, id: string): Promise<number> {
  return tx.employee.count({ where: { role: "admin", active: true, id: { not: id } } });
}

export async function updateAccount(request: Request, user: SessionUser, id: string, body: AccountChangeBody, opts: AccountChangeOptions = {}) {
  const { name, username, role: rawRole, permissions, pin, password, defaultRoute, active, phoneNumber, reason, confirmReviewedSubs } = body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the request body, validated field by field below
  // Re-test AUTH-A: one's OWN credential change, on a privileged or MFA-enrolled account, needs a
  // recent step-up (username + secret + verification code); the session alone is not enough.
  if (id === user.id && (pin || password || (username !== undefined && username !== null)) && (user.privileged || (await isEnrolled(user.id)))) {
    const stale = requireFreshAuth(user);
    if (stale) return stale;
  }
  // QA2 P3: one spelling per role — trimmed, lower-case, and one of the known roles.
  const role = typeof rawRole === "string" ? rawRole.trim().toLowerCase() : rawRole;
  if (role !== undefined && role !== null && role !== "" && !(typeof role === "string" && Object.hasOwn(ROLE_LABELS, role))) {
    return NextResponse.json({ error: "Unknown role.", errorEn: "Unknown role." }, { status: 400 });
  }
  // A power user (not the administrator) changing access exercises a privileged permission: a
  // verified individual (SIMPLE MODE: not required) after a recent step-up — the same step-up the
  // administrator gives on the users & roles routes. Asked whenever the body carries access fields.
  const actorCells = normalize(user.permissions);
  const actor = accessActor(user);
  const carriesAccess = (rawRole !== undefined && rawRole !== null && rawRole !== "") || permissions !== undefined || opts.accessRoleId !== undefined;
  if (actor === "power" && carriesAccess && id !== user.id) {
    const refused = await requirePrivilegedAction(user, "employees.manage_access", { stepUp: true });
    if (refused) return refused;
  }
  const phoneError = phoneNumberError(phoneNumber);
  if (phoneError) return NextResponse.json({ error: phoneError }, { status: 400 });

  // One PIN shape, enforced identically on every path that sets one.
  let newPin: string | null = null;
  let newLookup: string | null = null;
  let secret: string | null = null;
  let newVerifier: string | null = null;
  if (pin) {
    const pinShape = validatePin(pin);
    if (!pinShape.ok) return NextResponse.json({ error: pinShape.message }, { status: 400 });
    // Review item 1: throttled, one generic refusal, verifier derived before the lookup.
    const limited = await pinSetThrottle(request, user.id);
    if (limited) return limited;
    newPin = pinShape.pin;
    secret = requirePinLookupSecret();
    newLookup = pinLookup(newPin, secret);
    newVerifier = await hash(pinVerifierInput(newPin, secret), 10);
    if (await isPinTaken(newLookup, id)) return pinUnavailable(request, user.id, id, "EMPLOYEE_EDIT");
  }

  const data: Record<string, unknown> = { name, role };
  // Usernames in normal form (trim, NFKC, case-fold), unique by database index.
  if (username !== undefined && username !== null && username !== "" && !usernameValid(username)) return NextResponse.json(USERNAME_INVALID, { status: 400 });
  if (username !== undefined) data.username = normalizeUsername(username);
  // Only when the request actually supplies them.
  //
  // This line used to run unconditionally, so `JSON.stringify(undefined || {})` wrote "{}"
  // whenever the field was absent: a PUT that changed nothing but the role — or the name,
  // or the default route — silently erased the employee's entire permission grant, leaving
  // an account that could still log in and could do nothing. Nothing reported it, because
  // until this wave nothing recorded permission changes at all; it surfaced the moment the
  // audit started describing the exact diff, as an unexplained revocation of every module.
  if (permissions !== undefined) {
    data.permissions =
      typeof permissions === "string" ? permissions : JSON.stringify(permissions || {});
  }
  if (defaultRoute !== undefined) {
    if (!ALLOWED_DEFAULT_ROUTES.has(defaultRoute))
      return NextResponse.json({ error: "Invalid defaultRoute." }, { status: 400 });
    data.defaultRoute = defaultRoute;
  }
  // Version B writes the two live credential columns together:
  //   pin       bcrypt(pinVerifierInput(pin)) — the proof, over the keyed derivation and
  //             never the raw PIN, so a stolen row cannot be attacked offline
  //   pinLookup keyed HMAC selector — what login actually searches on
  // The legacy pinHash column is deliberately NOT written: it is inert under Version B and
  // migration #19 removes it. Refreshing it here would keep a precomputable selector alive.
  if (newPin && newLookup && secret && newVerifier) {
    data.pin = newVerifier;
    data.pinLookup = newLookup;
  }
  if (password) data.password = await hash(password, 10);
  if (active !== undefined) data.active = active;
  if (phoneNumber !== undefined) data.phoneNumber = typeof phoneNumber === "string" && phoneNumber.trim() ? phoneNumber.trim() : null;
  if (opts.accessRoleId !== undefined) data.accessRoleId = opts.accessRoleId;

  try {
    // The change and the record of it commit together — and both are derived from a row
    // this transaction has LOCKED.
    //
    // Being inside a transaction is not enough, and an earlier version of this comment
    // claimed otherwise. A plain findUnique takes no lock, so under READ COMMITTED another
    // administrator could change the same employee between the read and the write: the
    // update would land on the newer row while the diff still described the older one, so
    // the audit recorded a transition out of a state that no longer existed. Worse,
    // `permissions` is one document — two administrators editing at once write whole blobs,
    // and the later write silently discards the earlier grant.
    const employee = await prisma.$transaction(async (tx) => {
      // First statement: everything below reads the row this lock protects.
      if (!(await lockEmployeeForAdmin(tx, id))) {
        throw { _appCode: 404, message: "Employee not found." };
      }

      const before = await tx.employee.findUniqueOrThrow({
        where: { id },
        select: { role: true, active: true, permissions: true, username: true, name: true, accessRoleId: true, defaultRoute: true, phoneNumber: true },
      });
      // Q-3 / QA P1-1: judged on the EFFECTIVE grant after the change — submitted or stored
      // permissions with the resulting role's defaults — so a role-only change counts too. It may
      // keep an existing conflicting pair (until reviewed) but never add one.
      const beforeGrant = { permissions: before.permissions as string | null, role: before.role };
      const desired = { permissions: permissions !== undefined ? storedPermissions(permissions) : (before.permissions as string | null), role: typeof role === "string" && role ? role : before.role };

      // P-4 / UR-S08: nobody changes their own access — role, permissions, custom role or active
      // state — on any path. Credentials, name and language stay the person's own business.
      const beforeCells = effectiveCells(before.permissions as string | null, before.role);
      const afterCells = effectiveCells(desired.permissions, desired.role);
      const permissionsChanged = desired.role !== before.role
        || diffCells(beforeCells, afterCells).length > 0
        || (opts.accessRoleId !== undefined && opts.accessRoleId !== before.accessRoleId);
      const accessChanged = permissionsChanged || (active !== undefined && active !== before.active);
      if (id === user.id && accessChanged) throw SELF_ACCESS();
      // Owner decision 19 Oct: another account's role / permissions / custom role change only by the
      // administrator or a power user, and a power user only within the guardrails (power.ts).
      // An administrator's account is the administrator's: a power user may not even rewrite its stored
      // document (SIMPLE MODE reads every admin as holding everything, so a diff would not show it).
      if (actor === "power" && before.role === "admin" && carriesAccess) {
        throw new UsersError(403, "TARGET_IS_ADMIN", POWER_REFUSAL_TEXT.TARGET_IS_ADMIN.ar, POWER_REFUSAL_TEXT.TARGET_IS_ADMIN.en);
      }
      if (permissionsChanged) {
        if (!actor) throw ACCESS_MANAGER_ONLY();
        if (actor === "power") {
          const r = powerUserRefusal({ actor: actorCells, targetRole: before.role, desiredRole: desired.role, before: beforeCells, after: afterCells });
          if (r) throw new UsersError(403, r.code, POWER_REFUSAL_TEXT[r.code].ar, POWER_REFUSAL_TEXT[r.code].en, r.cells ? { cells: r.cells } : undefined);
        }
      }
      // A power user without employees › edit changes access only — not the account's other fields.
      if (actor === "power" && !hasSubPrivilege(user.permissions, "employees", "edit")) {
        const other = (name !== undefined && name !== before.name) || (username !== undefined && normalizeUsername(username) !== before.username)
          || !!pin || !!password || (defaultRoute !== undefined && defaultRoute !== before.defaultRoute)
          || (active !== undefined && active !== before.active) || (phoneNumber !== undefined && (typeof phoneNumber === "string" && phoneNumber.trim() ? phoneNumber.trim() : null) !== before.phoneNumber);
        if (other) throw OTHER_FIELDS_NEED_EDIT();
      }
      // UR-S09: the last active administrator is neither demoted nor deactivated.
      const staysAdmin = desired.role === "admin" && (active === undefined ? before.active : active === true);
      if (before.role === "admin" && before.active && !staysAdmin && (await otherActiveAdmins(tx, id)) === 0) throw LAST_ADMIN(before.name);

      assertNoNewPayrollConflicts(desired, beforeGrant);
      // Owner decision 1b: a GRANT of a segregated duty (or of the admin role) waits for a second
      // account editor; the rest of the change — revocations included — applies now.
      const grants = sensitiveGrants(desired, beforeGrant);
      // Owner decision (16 Oct): ANY privileged permission newly granted (not only the payroll
      // duties that become requests) goes only to an individual account — a login linked to a
      // verified person. Refused (409 SUBJECT_NOT_VERIFIED) and audited otherwise.
      const privilegedGained = gainedPrivileges(desired, beforeGrant);
      // SIMPLE MODE: no verified identity is needed to grant a privileged permission.
      if (privilegedGained.length && !isSimpleMode() && !(await identityOf(tx, id)).verified) {
        throw new GrantRefused(id, privilegedGained);
      }
      const pending = grants.duties.length > 0 || grants.toAdmin || grants.subs.length > 0;
      // Inventory Option A, runbook §10.7 item 8: an account that ALREADY holds a reviewed sub
      // (inventory adjust / override) with no approval record — a legacy one-editor grant — cannot
      // gain it again, so a plain save would be a silent 200. `confirmReviewedSubs: true` asks for
      // the held subs to be confirmed by a second account editor: a PERMISSION_CHANGE request naming
      // them (payload.subs), applied unchanged on approval — the approval evidence the impact report
      // accepts. Refused when the account will hold none of them.
      const confirmSubs = confirmReviewedSubs === true ? heldReviewedSubs(desired).filter((k) => heldReviewedSubs(beforeGrant).includes(k) && !grants.subs.includes(k)) : [];
      if (confirmReviewedSubs === true && confirmSubs.length === 0 && grants.subs.length === 0) {
        throw new HrError("Nothing to confirm: the account will hold neither inventory adjust nor inventory override.", 400, "NOTHING_TO_CONFIRM");
      }
      if (pending) {
        const now = withoutSensitiveGrants(desired, beforeGrant);
        data.permissions = now.permissions;
        data.role = now.role;
      }
      // QA2 P1-B: a credential change (password, PIN, username) or a reactivation of an account that
      // holds a segregated duty or is admin is not applied by one editor either — it joins the
      // second-person request (hashes only). Editing one's OWN credentials stays immediate.
      // Deactivation always applies at once.
      // Review P2-5: judged on the duties BEFORE and AFTER this change, and for any login of a
      // VERIFIED person whether or not it holds duties today. Review NEW-1: also any login named by a
      // live verification (linked or not), and (owner security decision) any privileged account.
      // SIMPLE MODE: the admin's credential change (username, PIN, password) or reactivation applies at
      // once — it is not held for a second account editor.
      const holdsDuties = !isSimpleMode() && (isPrivilegedStored(beforeGrant.permissions, beforeGrant.role) || isPrivilegedStored(desired.permissions, desired.role) || before.role === "admin" || desired.role === "admin" || payrollDuties(effectivePermissions(beforeGrant.permissions, beforeGrant.role)).length > 0 || payrollDuties(effectivePermissions(desired.permissions, desired.role)).length > 0 || (await identityOf(tx, id)).personVerified || (await loginAttested(tx, id)));
      let credentials: CredentialChange | null = null;
      if (holdsDuties) {
        const c: CredentialChange = {};
        if (user.id !== id) {
          if (data.username !== undefined && data.username !== before.username) { c.username = data.username as string; delete data.username; }
          if (data.pin) { c.pin = data.pin as string; c.pinLookup = data.pinLookup as string; delete data.pin; delete data.pinLookup; }
          if (data.password) { c.password = data.password as string; delete data.password; }
        }
        if (data.active === true && before.active === false) { c.activate = true; delete data.active; }
        if (Object.keys(c).length) credentials = c;
      }
      const applied = { permissions: (data.permissions as string | undefined) ?? (before.permissions as string | null), role: (data.role as string | undefined) || before.role };
      const dutiesBefore = payrollDuties(effectivePermissions(beforeGrant.permissions, beforeGrant.role));
      const dutiesNow = payrollDuties(effectivePermissions(applied.permissions, applied.role));
      if (dutiesBefore.join() !== dutiesNow.join()) {
        await tx.hrAuditLog.create({ data: { action: "HR_EFFECTIVE_DUTIES_CHANGED", entityType: "Employee", entityId: id, before: { role: before.role, duties: dutiesBefore }, after: { role: applied.role, duties: dutiesNow }, actorId: user.id } });
      }

      const updated = await tx.employee.update({ where: { id }, data, select: SELECT_FULL });
      // Owner security decision: a PRIVILEGED account has a username (it signs in with username +
      // PIN or password) — judged on the permissions it will end up with, and the username it will
      // end up with (a held username change counts).
      const finalUsername = credentials?.username !== undefined ? credentials.username : updated.username;
      if (isPrivilegedStored(desired.permissions, desired.role) && !finalUsername) throw new HrError("A privileged account needs a username: it signs in with username and PIN.", 400, "USERNAME_REQUIRED");
      // Promotion to privileged: its PIN-only sessions end now (it must sign in the strong way).
      if (isPrivilegedStored(updated.permissions as string, updated.role) && !isPrivilegedStored(beforeGrant.permissions, beforeGrant.role)) {
        const ended = await revokeSessions(tx, id, "PROMOTED_PRIVILEGED", { method: "PIN" });
        await tx.hrAuditLog.create({ data: { action: "AUTH_PIN_SESSIONS_REVOKED_PRIVILEGED", entityType: "Employee", entityId: id, after: { sessions: ended }, actorId: user.id } });
      }

      const events = diffEmployeeChange(
        before as { role: string; active: boolean; permissions: string },
        {
          role: updated.role,
          active: updated.active,
          permissions: updated.permissions as string,
        },
        { pin: Boolean(pin) && !credentials?.pin, password: Boolean(password) && !credentials?.password },
      );
      await recordEmployeeAudit(
        tx,
        auditContext(request, user.id),
        events.map((e) => ({
          action: e.action,
          targetEmployeeId: id,
          targetName: updated.name,
          metadata: { ...e.metadata, ...(opts.auditExtra ?? {}) },
        })),
      );

      // Revocations applied now leave a post-hoc review item for another person (never blocking).
      const revoked = dutiesBefore.filter((d) => !dutiesNow.includes(d));
      const fromAdmin = before.role === "admin" && updated.role !== "admin";
      if (revoked.length || fromAdmin) {
        await recordRevocationReviewIn(tx, { actorId: user.id, accountId: id, accountName: updated.name, revoked, fromAdmin, before: beforeGrant, after: { permissions: updated.permissions as string, role: updated.role } });
      }
      const pendingApproval = pending || credentials || confirmSubs.length
        ? await requestPermissionChangeIn(tx, { actorId: user.id, accountId: id, accountName: updated.name, desired: pending ? desired : { permissions: updated.permissions as string, role: updated.role }, before: { permissions: updated.permissions as string, role: updated.role }, credentials, confirmSubs, reason: typeof reason === "string" && reason.trim().length >= 5 ? reason.trim().slice(0, 300) : (credentials && !pending && !confirmSubs.length ? "تغيير بيانات دخول حساب يحمل مهام حساسة" : grants.duties.length || grants.toAdmin ? "منح مهام رواتب حساسة" : confirmSubs.length && !pending ? "تأكيد صلاحية مخزون مميّزة قائمة لمشرف" : "منح صلاحية مخزون مميّزة لمشرف") })
        : null;
      if (opts.afterUpdate) {
        await opts.afterUpdate(tx, {
          before: { role: before.role, permissions: before.permissions as string, active: before.active },
          updated: { id: updated.id, name: updated.name, role: updated.role, permissions: updated.permissions as string, active: updated.active },
          pending: !!pendingApproval,
        });
      }
      return { ...updated, pendingApproval };
    }, TX_OPTS);

    const res = NextResponse.json(employee);
    // Review item 2: the caller's OWN credential change keeps them signed in (a fresh token).
    if (id === user.id && (newPin || password || username !== undefined)) await setFreshSession(res, user.id, user);
    return res;
  } catch (err) {
    if (err instanceof UsersError) return err.response();
    if (err instanceof GrantRefused) {
      await prisma.hrAuditLog.create({ data: { action: "PERMISSION_GRANT_REFUSED_UNVERIFIED", entityType: "Employee", entityId: err.accountId, after: { privileged: err.privileged }, actorId: user.id } }).catch(() => undefined);
      return NextResponse.json({ error: toArabic(SUBJECT_NOT_VERIFIED_EN) ?? SUBJECT_NOT_VERIFIED_EN, errorEn: SUBJECT_NOT_VERIFIED_EN, code: "SUBJECT_NOT_VERIFIED", privileged: err.privileged }, { status: 409 });
    }
    if (isPinLookupConflict(err)) return pinUnavailable(request, user.id, id, "EMPLOYEE_EDIT");
    if (err instanceof DutyConflictError) return dutyConflictResponse(err, user.id, id);
    if (err instanceof HrError) return NextResponse.json({ error: toArabic(err.message) ?? err.message, errorEn: err.message, code: err.code }, { status: err.status });
    // The transaction above throws the `{ _appCode }` shape the newer routes use.
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
