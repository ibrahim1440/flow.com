import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { hash } from "bcryptjs";
import { requireSub, requireAuth, requireFreshAuth, requireAdminAction } from "@/lib/auth-server";
import { isEnrolled } from "@/lib/auth/mfa";
import { handlePrismaError } from "@/lib/api-error";
import { isPinLookupConflict, pinSetThrottle, pinUnavailable } from "@/lib/pin-set-guard";
import { setFreshSession } from "@/lib/session-cookie";
import { identityOf, loginAttested, SUBJECT_NOT_VERIFIED_EN } from "@/lib/hr/identity";
import { gainedPrivileges, isPrivilegedStored, normalizeUsername, usernameValid, USERNAME_INVALID } from "@/lib/auth/privileged";

/** A privileged grant to a login that is not a verified person (audited after the rollback). */
class GrantRefused extends Error {
  constructor(readonly accountId: string, readonly privileged: string[]) { super("SUBJECT_NOT_VERIFIED"); }
}
import { revokeSessions } from "@/lib/auth/session";
import {
  recordEmployeeAudit, diffEmployeeChange, lockEmployeeForAdmin,
} from "@/lib/services/employee-audit";
import { extractIp, hashRateLimitKey } from "@/lib/rate-limit";
import { validatePin } from "@/lib/pin-policy";
import { pinLookup, pinVerifierInput, requirePinLookupSecret } from "@/lib/pin-lookup";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { assertNoNewPayrollConflicts, conflictMessageEn, DutyConflictError, heldReviewedSubs, payrollDuties, effectivePermissions, sensitiveGrants, storedPermissions, withoutSensitiveGrants } from "@/lib/hr/sod";
import { recordRevocationReviewIn, requestPermissionChangeIn, type CredentialChange } from "@/lib/hr/services/permission-change";
import { ROLE_LABELS } from "@/lib/auth-shared";
import { HrError } from "@/lib/hr/core";
import { toArabic } from "@/lib/hr/messages-ar";

/** Actor plus a hashed address — the same treatment login attempts already give one. */
function auditContext(request: Request, actorId: string) {
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

const SELECT_FULL = {
  id: true, name: true, username: true, role: true, permissions: true,
  defaultRoute: true, active: true, createdAt: true, phoneNumber: true,
} as const;

const ALLOWED_DEFAULT_ROUTES = new Set([
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

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireSub("employees", "edit");
  if (error) return error;

  const { id } = await params;
  const { name, username, role: rawRole, permissions, pin, password, defaultRoute, active, phoneNumber, reason, confirmReviewedSubs } = await request.json();
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
        select: { role: true, active: true, permissions: true, username: true },
      });
      // Q-3 / QA P1-1: judged on the EFFECTIVE grant after the change — submitted or stored
      // permissions with the resulting role's defaults — so a role-only change counts too. It may
      // keep an existing conflicting pair (until reviewed) but never add one.
      const beforeGrant = { permissions: before.permissions as string | null, role: before.role };
      const desired = { permissions: permissions !== undefined ? storedPermissions(permissions) : (before.permissions as string | null), role: typeof role === "string" && role ? role : before.role };
      assertNoNewPayrollConflicts(desired, beforeGrant);
      // Owner decision 1b: a GRANT of a segregated duty (or of the admin role) waits for a second
      // account editor; the rest of the change — revocations included — applies now.
      const grants = sensitiveGrants(desired, beforeGrant);
      // Owner decision (16 Oct): ANY privileged permission newly granted (not only the payroll
      // duties that become requests) goes only to an individual account — a login linked to a
      // verified person. Refused (409 SUBJECT_NOT_VERIFIED) and audited otherwise.
      const privilegedGained = gainedPrivileges(desired, beforeGrant);
      if (privilegedGained.length && !(await identityOf(tx, id)).verified) {
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
      const holdsDuties = isPrivilegedStored(beforeGrant.permissions, beforeGrant.role) || isPrivilegedStored(desired.permissions, desired.role) || before.role === "admin" || desired.role === "admin" || payrollDuties(effectivePermissions(beforeGrant.permissions, beforeGrant.role)).length > 0 || payrollDuties(effectivePermissions(desired.permissions, desired.role)).length > 0 || (await identityOf(tx, id)).personVerified || (await loginAttested(tx, id));
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
        before,
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
          metadata: e.metadata,
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
      return { ...updated, pendingApproval };
    }, TX_OPTS);

    const res = NextResponse.json(employee);
    // Review item 2: the caller's OWN credential change keeps them signed in (a fresh token).
    if (id === user.id && (newPin || password || username !== undefined)) await setFreshSession(res, user.id, user);
    return res;
  } catch (err) {
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

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  // Deleting an account is the admin role exercised: a verified individual, after a recent step-up.
  const refused = await requireAdminAction(user, "employees.delete", { stepUp: true, message: "Only admins can delete employees" });
  if (refused) return refused;

  const { id } = await params;

  try {
    // Both or neither. The audit is written first so that the metadata can describe an
    // employee that still exists; if the delete then fails — an operational foreign key,
    // a QC record, a cupping score — the whole transaction rolls back and no successful
    // deletion event survives to contradict an employee who is still there.
    await prisma.$transaction(async (tx) => {
      // The same lock the edit path takes, for the same reason: the audit must describe
      // the employee as they actually were at the moment they were deleted, not as they
      // were before an edit that committed while this transaction was reading.
      if (!(await lockEmployeeForAdmin(tx, id))) {
        throw { _appCode: 404, message: "Employee not found." };
      }

      const target = await tx.employee.findUniqueOrThrow({
        where: { id },
        select: { name: true, role: true, active: true },
      });

      await recordEmployeeAudit(tx, auditContext(request, user.id), [{
        action: "EMPLOYEE_DELETED",
        targetEmployeeId: id,
        targetName: target.name,
        metadata: { role: target.role, activeAtDeletion: target.active },
      }]);

      await tx.employee.delete({ where: { id } });
    }, TX_OPTS);

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    // The transaction above throws the `{ _appCode }` shape the newer routes use.
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    const code = (err as { code?: string })?.code;
    if (code === "P2003" || code === "P2014") {
      return NextResponse.json(
        { error: "Cannot delete this employee because they have linked operational records. Please deactivate their account instead." },
        { status: 400 }
      );
    }
    return handlePrismaError(err);
  }
}
