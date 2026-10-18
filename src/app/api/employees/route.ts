import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { hash } from "bcryptjs";
import { requireSub, requireAuth } from "@/lib/auth-server";
import { recordEmployeeAudit } from "@/lib/services/employee-audit";
import { assertNoNewPayrollConflicts, conflictMessageEn, DutyConflictError, payrollDuties, effectivePermissions, sensitiveGrants, storedPermissions, withoutSensitiveGrants } from "@/lib/hr/sod";
import { SUBJECT_NOT_VERIFIED_EN } from "@/lib/hr/identity";
import { isPinLookupConflict, pinSetThrottle, pinUnavailable } from "@/lib/pin-set-guard";
import { gainedPrivileges, normalizeUsername, usernameValid, USERNAME_INVALID, withoutPrivileged } from "@/lib/auth/privileged";
import { ROLE_LABELS } from "@/lib/auth-shared";
import { HrError } from "@/lib/hr/core";
import { toArabic } from "@/lib/hr/messages-ar";
import { validatePin } from "@/lib/pin-policy";
import { pinLookup, pinVerifierInput, requirePinLookupSecret } from "@/lib/pin-lookup";
import { extractIp, hashRateLimitKey } from "@/lib/rate-limit";
import { handlePrismaError } from "@/lib/api-error";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";

/** Actor plus a hashed address â the same treatment login attempts already give one. */
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

const SELECT_ROSTER = {
  id: true, name: true, role: true, active: true,
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


/**
 * O(1) uniqueness on the keyed lookup.
 *
 * PINs must stay globally unique while PIN-only login exists: a shared PIN cannot
 * identify which of two employees is standing at the pad, and whoever the first matching
 * row happens to be would own the other one's actions. This is the friendly pre-check;
 * UNIQUE(pinLookup) is what actually decides under concurrency.
 */
async function isPinTaken(lookup: string, excludeId?: string): Promise<boolean> {
  const existing = await prisma.employee.findFirst({
    where: {
      pinLookup: lookup,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  return existing !== null;
}

export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;

  const isAdmin = user.role === "admin";
  const employees = await prisma.employee.findMany({
    orderBy: { createdAt: "desc" },
    select: isAdmin ? SELECT_FULL : SELECT_ROSTER,
  });
  return NextResponse.json(employees);
}

/** A refused conflicting payroll-duty assignment (Q-3): named duties, and an audit row without credentials. */
async function dutyConflictResponse(e: DutyConflictError, actorId: string, username: string) {
  // The account does not exist yet: the row names the attempted username (QA P3), never a credential.
  await prisma.hrAuditLog.create({ data: { action: "HR_DUTY_CONFLICT_REFUSED", entityType: "Employee", entityId: `new:${username}`.slice(0, 120), after: { username, conflicts: e.conflicts }, actorId } }).catch(() => undefined);
  return NextResponse.json({ error: e.message, errorEn: conflictMessageEn(e.conflicts), code: e.code, conflicts: e.conflicts }, { status: e.status });
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("employees", "create");
  if (error) return error;

  const { name, username, pin, password, role: rawRole, permissions, defaultRoute, phoneNumber, reason } = await request.json();
  // QA2 P3: one spelling per role — trimmed, lower-case, and one of the known roles.
  const role = typeof rawRole === "string" ? rawRole.trim().toLowerCase() : "";
  if (!Object.hasOwn(ROLE_LABELS, role)) return NextResponse.json({ error: "Unknown role.", errorEn: "Unknown role." }, { status: 400 });

  if (!normalizeUsername(username)) return NextResponse.json({ error: "Username is required" }, { status: 400 });
  if (!usernameValid(username)) return NextResponse.json(USERNAME_INVALID, { status: 400 });
  const phoneError = phoneNumberError(phoneNumber);
  if (phoneError) return NextResponse.json({ error: phoneError }, { status: 400 });
  const pinShape = validatePin(pin);
  if (!pinShape.ok) return NextResponse.json({ error: pinShape.message }, { status: 400 });
  if (defaultRoute !== undefined && defaultRoute !== null && defaultRoute !== "") {
    if (!ALLOWED_DEFAULT_ROUTES.has(defaultRoute))
      return NextResponse.json({ error: "Invalid defaultRoute." }, { status: 400 });
  }

  // Q-3 / QA P1-1: a new account never starts with conflicting payroll duties — judged on what
  // the session will actually grant (submitted permissions, or the role's defaults when empty).
  const desired = { permissions: storedPermissions(permissions), role: String(role ?? "") };
  try {
    assertNoNewPayrollConflicts(desired, null);
  } catch (e) {
    if (e instanceof DutyConflictError) return dutyConflictResponse(e, user.id, String(username));
    throw e;
  }
  // Owner decision 1b: segregated duties (or the admin role) are not granted by one person. The
  // account is created without them; the grant waits for a second account editor.
  const grants = sensitiveGrants(desired, null);
  // Owner decision (16 Oct): a new login is nobody's yet, so NO privileged permission (payroll or
  // any other: finance, account administration, inventory adjust/override, order approval, …) is
  // granted at creation — the account starts without it, and it is granted once the login belongs
  // to a verified person.
  const privilegedGained = gainedPrivileges(desired, null);
  const pending = grants.duties.length > 0 || grants.toAdmin || privilegedGained.length > 0;
  const initial = pending ? withoutPrivileged(withoutSensitiveGrants(desired, null), null) : desired;
  const startDuties = payrollDuties(effectivePermissions(initial.permissions, initial.role));

  // Review item 1: throttled, one generic refusal, and the verifier derived before the
  // uniqueness lookup so a taken PIN answers in the same time as a free one.
  const limited = await pinSetThrottle(request, user.id);
  if (limited) return limited;
  const secret = requirePinLookupSecret();
  const lookup = pinLookup(pinShape.pin, secret);
  const verifier = await hash(pinVerifierInput(pinShape.pin, secret), 10);
  if (await isPinTaken(lookup)) return pinUnavailable(request, user.id, null, "EMPLOYEE_CREATE");

  try {
    // Hashing is slow and has no business inside a transaction holding a connection open.
    // Version B writes the two live credential columns together:
    //   pin       bcrypt(pinVerifierInput(pin)) — the proof, over the keyed derivation and
    //             never the raw PIN, so a stolen row cannot be attacked offline
    //   pinLookup keyed HMAC selector — what login actually searches on
    // The legacy pinHash column is deliberately NOT written: it is inert under Version B and
    // migration #19 removes it. A fresh account therefore carries no pinHash at all.
    const hashedPin = verifier;
    const hashedPassword = password ? await hash(password, 10) : null;

    // The account and the record of its creation commit together. An account that exists
    // with no record of who created it, or with what authority, is the gap this closes.
    const employee = await prisma.$transaction(async (tx) => {
      const created = await tx.employee.create({
        data: {
          name,
          username: normalizeUsername(username),
          pin: hashedPin,
          pinLookup: lookup,
          role: initial.role,
          permissions: initial.permissions ?? "{}",
          defaultRoute: defaultRoute || "/dashboard",
          phoneNumber: typeof phoneNumber === "string" && phoneNumber.trim() ? phoneNumber.trim() : null,
          ...(hashedPassword ? { password: hashedPassword } : {}),
        },
        select: SELECT_FULL,
      });

      // The credential the account was created WITH is never recorded â only that one
      // was set, and which kind.
      await recordEmployeeAudit(tx, auditContext(request, user.id), [{
        action: "EMPLOYEE_CREATED",
        targetEmployeeId: created.id,
        targetName: created.name,
        metadata: {
          role: created.role,
          active: created.active,
          credentials: [ "pin", ...(hashedPassword ? ["password"] : []) ],
        },
      }]);
      // The effective segregated duties the account starts with (role defaults included).
      if (startDuties.length) await tx.hrAuditLog.create({ data: { action: "HR_EFFECTIVE_DUTIES_CHANGED", entityType: "Employee", entityId: created.id, before: [], after: { role: created.role, duties: startDuties }, actorId: user.id } });
      // Option A: a new login is linked to nobody yet, so it is not a verified person and the
      // sensitive part cannot even be requested. The account is created without it; the response
      // and the audit say so, and the duties are requested after the login is linked to a person
      // and that identity is verified.
      let identityRequired: { code: string; grants: string[]; toAdmin: boolean; privileged?: string[]; message: string; messageEn: string } | null = null;
      if (pending) {
        identityRequired = { code: "SUBJECT_NOT_VERIFIED", grants: grants.duties, toAdmin: grants.toAdmin, privileged: privilegedGained, message: toArabic(SUBJECT_NOT_VERIFIED_EN) ?? SUBJECT_NOT_VERIFIED_EN, messageEn: SUBJECT_NOT_VERIFIED_EN };
        await tx.hrAuditLog.create({ data: { action: "PERMISSION_GRANT_REFUSED_UNVERIFIED", entityType: "Employee", entityId: created.id, after: { grants: grants.duties, toAdmin: grants.toAdmin, privileged: privilegedGained, reason: typeof reason === "string" ? reason.trim().slice(0, 300) : null }, actorId: user.id } });
      }

      return { ...created, pendingApproval: null, identityRequired };
    }, TX_OPTS);

    return NextResponse.json(employee, { status: 201 });
  } catch (err) {
    if (err instanceof HrError) return NextResponse.json({ error: toArabic(err.message) ?? err.message, errorEn: err.message, code: err.code }, { status: err.status });
    if (isPinLookupConflict(err)) return pinUnavailable(request, user.id, null, "EMPLOYEE_CREATE");
    return handlePrismaError(err);
  }
}
