// «المستخدمون والصلاحيات» (Figma Phase 8) — the server side of the screens: the directory (UR-01),
// the profile and its tabs (UR-02 / UR-08 / UR-09 / UR-02d / UR-02e), a change of one account's
// access (UR-02b → UR-10), new accounts (UR-03), credentials (UR-04) and revocation (UR-11).
//
// Who may do what (the routes enforce it; these helpers assume the gate has run):
//   · read: any holder of the `employees` module (UR-S06 «عرض فقط» — profiles and effective
//     permissions, no buttons); the audit log, other people's sessions and the HR people picker are
//     for the administrator role only;
//   · every write: the administrator role, after a recent step-up (requireAdminAction, stepUp) —
//     owner rule «only the admin edits roles and permissions» — and never on one's own account;
//   · except (owner decision 19 Oct) a change of another account's role, permissions or exceptions,
//     which a power user (employees › manage_access) may also make, within the guardrails of
//     power.ts (gate.ts on the routes, the shared account path for the rules).
import { hash } from "bcryptjs";
import { randomBytes, randomInt } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { hasModuleAccess, type Permissions } from "@/lib/auth-shared";
import { recordEmployeeAudit, lockEmployeeForAdmin, type AuditContext } from "@/lib/services/employee-audit";
import { assertNoNewPayrollConflicts, payrollDuties, effectivePermissions } from "@/lib/hr/sod";
import { gainedPrivileges, normalizeUsername, usernameValid, withoutPrivileged } from "@/lib/auth/privileged";
import { isSimpleMode } from "@/lib/simple-mode";
import { hashRateLimitKey } from "@/lib/rate-limit";
import { revokeSession, revokeSessions } from "@/lib/auth/session";
import { describeUserAgent, sessionRef, deviceKey, deviceRef } from "@/lib/auth/device";
import { isLive } from "@/lib/auth/my-security";
import { audit as hrAudit } from "@/lib/hr/core";
import { assertLinkChangeAllowed } from "@/lib/hr/services/people";
import { isSensitive, moduleLabel, subLabel, SYSTEM_ROLES, NO_ACCESS_ROLE, GROUPS } from "./catalog";
import {
  allCells, applyOverrides, cellKey, composeAccount, effectiveCells, effectOf, explain, getCell, isCustomized, normalize, parseCellKey,
  storedCells, templateCells, toDocument, validValue, type CellRef, type CellValue, type Cells,
} from "./model";
import { accountTemplate, recordOverrides, settleExpiredOverrides } from "./overrides";
import { cleanReason } from "./roles";
import { updateAccount, auditContext } from "./account-update";
import { UsersError } from "./errors";
import { accessActor, isPowerUserAccount, powerUserRefusal, POWER_REFUSAL_TEXT } from "./power";
import { AUDIT_ACTIONS, describe } from "./audit";
import type { SessionUser } from "@/lib/auth-server";

type Viewer = { id: string; role: string; permissions: Permissions; preferredLanguage?: "ar" | "en" };

/** The users area's abilities for a viewer (pages hide what the routes refuse). */
export function usersCaps(v: Viewer) {
  const actor = accessActor(v);
  return {
    view: hasModuleAccess(v.permissions, "employees"),
    // Owner rule: only the administrator role edits users, roles, credentials and sessions.
    manage: v.role === "admin",
    // Owner decision 19 Oct: the administrator or a power user changes other users' access.
    manageAccess: actor !== null,
    powerUser: actor === "power",
    /** A power user's own cells: the ceiling of what it may grant (null for the administrator). */
    limit: actor === "power" ? normalize(v.permissions) : null,
    simpleMode: isSimpleMode(),
  };
}

/** The read gate of the administrator-only reads (audit log, another account's sessions, HR people). */
export function isUsersAdmin(v: { role: string }): boolean {
  return v.role === "admin";
}

const LOCK_WINDOW_MS = 15 * 60 * 1000;
/** Failed sign-ins under one username in the window at which sign-in is refused (login route: pair 10). */
export const LOCK_THRESHOLD = 10;
const loginIdentifier = (username: string) => hashRateLimitKey("login:" + username);

export type UserStatus = "active" | "inactive" | "locked" | "mustChange";

async function lockState(usernames: string[]): Promise<Map<string, { count: number; last: Date | null }>> {
  const map = new Map<string, { count: number; last: Date | null }>();
  if (!usernames.length) return map;
  const byHash = new Map(usernames.map((u) => [loginIdentifier(u), u]));
  const rows = await prisma.loginAttempt.groupBy({
    by: ["identifierHash"], where: { identifierHash: { in: [...byHash.keys()] }, createdAt: { gte: new Date(Date.now() - LOCK_WINDOW_MS) } },
    _count: { _all: true }, _max: { createdAt: true },
  });
  for (const r of rows) map.set(byHash.get(r.identifierHash)!, { count: r._count._all, last: r._max.createdAt });
  return map;
}

/** The latest SIGN-IN of each account (a session opened by a sign-in, not a replaced one). I-9. */
async function lastSignIns(ids?: string[]): Promise<Map<string, { at: Date; method: string; userAgent: string | null }>> {
  const rows = ids && ids.length === 0 ? [] : await prisma.$queryRaw<{ employeeId: string; createdAt: Date; method: string; userAgent: string | null }[]>`
    SELECT DISTINCT ON ("employeeId") "employeeId", "createdAt", method, "userAgent"
    FROM "AuthSession"
    WHERE "authTime" >= "createdAt" - interval '1 second'
    ORDER BY "employeeId", "createdAt" DESC`;
  return new Map(rows.filter((r) => !ids || ids.includes(r.employeeId)).map((r) => [r.employeeId, { at: r.createdAt, method: r.method, userAgent: r.userAgent }]));
}

const ACCOUNT_SELECT = {
  id: true, name: true, username: true, role: true, permissions: true, active: true, createdAt: true, accessRoleId: true, phoneNumber: true,
  workEmail: true,
  passwordMustChange: true, passwordTempExpiresAt: true, pinResetRequired: true, password: true, pinLookup: true,
  accessRole: { select: { id: true, name: true, permissions: true } },
  hrPerson: { select: { id: true, fullNameAr: true, fullNameEn: true, jobTitle: true, workEmail: true, department: { select: { nameAr: true, nameEn: true } } } },
  externalPerson: { select: { id: true } },
  permissionOverrides: { orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.EmployeeSelect;
type AccountRow = Prisma.EmployeeGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/** The subject account holds the administrator role (a power user never changes it). */
const isAdminAccount = (e: Pick<AccountRow, "role">) => e.role === "admin";

function roleOf(e: Pick<AccountRow, "role" | "accessRole">) {
  if (e.accessRole) return { key: "custom", id: e.accessRole.id, name: e.accessRole.name, nameEn: e.accessRole.name, system: false };
  const s = SYSTEM_ROLES.find((r) => r.key === e.role) ?? NO_ACCESS_ROLE;
  return { key: e.role, id: s.key, name: s.ar, nameEn: s.en, system: true };
}

function statusOf(e: Pick<AccountRow, "active" | "passwordMustChange">, locked: boolean): UserStatus {
  if (!e.active) return "inactive";
  if (locked) return "locked";
  if (e.passwordMustChange) return "mustChange";
  return "active";
}

function cellsOf(e: AccountRow) {
  const template = templateCells(e.role, e.accessRole?.permissions ?? null);
  const effective = effectiveCells(e.permissions as string, e.role);
  return { template, effective };
}

function sensitiveActive(effective: Cells) {
  return allCells().filter((ref) => isSensitive(ref.module, ref.sub) && (ref.sub === null ? effective[ref.module].access !== "none" : effective[ref.module].access !== "none" && effective[ref.module].sub[ref.sub]));
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** UR-01 — every account, with what the directory, its filters and the preview show. */
export async function directory() {
  await settleExpiredOverrides();
  const rows = await prisma.employee.findMany({ select: ACCOUNT_SELECT, orderBy: [{ active: "desc" }, { createdAt: "asc" }] });
  const locks = await lockState(rows.map((r) => r.username).filter((u): u is string => !!u));
  const signIns = await lastSignIns();
  const now = Date.now();
  return rows.map((e) => {
    const { template, effective } = cellsOf(e);
    const lock = e.username ? locks.get(e.username) : undefined;
    const locked = !!lock && lock.count >= LOCK_THRESHOLD;
    const active = e.permissionOverrides.filter((o) => !o.endedAt && (!o.expiresAt || o.expiresAt.getTime() > now));
    const s = signIns.get(e.id);
    return {
      id: e.id, name: e.name, username: e.username, role: roleOf(e), customized: isCustomized(effective, template),
      status: statusOf(e, locked), active: e.active,
      // Owner decision 19 Oct: a power user (employees › manage_access), marked in the list.
      powerUser: isPowerUserAccount(e.role, effective),
      overrides: { active: active.length, ended: e.permissionOverrides.length - active.length },
      lastSignIn: s ? { at: s.at.toISOString(), method: s.method, device: describeUserAgent(s.userAgent) } : null,
      hr: e.hrPerson ? { id: e.hrPerson.id, name: e.hrPerson.fullNameAr, department: e.hrPerson.department?.nameAr ?? null } : null,
      external: !!e.externalPerson,
      modules: GROUPS.flatMap((g) => g.modules).filter((m) => effective[m].access !== "none"),
      sensitive: sensitiveActive(effective).map((ref) => ({ key: cellKey(ref), label: ref.sub ? subLabel(ref.module, ref.sub) : `${moduleLabel(ref.module)} · ${effective[ref.module].access === "edit" ? "تعديل" : "عرض"}`, source: effectOf(ref, getCell(effective, ref), getCell(template, ref)) ? "override" : "role" })),
    };
  });
}

/** The account events that name this account (UR-02 «آخر التغييرات», UR-02e timeline). */
async function accountEvents(id: string, take = 40) {
  return prisma.$queryRaw<{ id: string; userId: string | null; action: string; result: string; reasonCode: string | null; sourceInterface: string; userAgent: string | null; metadata: Prisma.JsonValue; occurredAt: Date }[]>`
    SELECT id, "userId", action, result, "reasonCode", "sourceInterface", "userAgent", metadata, "occurredAt" FROM "AuthAuditLog"
    WHERE (metadata ->> 'targetEmployeeId') = ${id}
       OR ("userId" = ${id} AND action IN ('SIGN_IN', 'MFA_SIGN_IN', 'PASSWORD_CHANGED_SELF'))
    ORDER BY "occurredAt" DESC LIMIT ${take}`;
}

/** UR-02 — one account: facts, role, effective permissions with their sources, exceptions, history. */
export async function profile(id: string, viewer: Viewer) {
  await settleExpiredOverrides(id);
  const e = await prisma.employee.findUnique({ where: { id }, select: ACCOUNT_SELECT });
  if (!e) return null;
  const { template, effective } = cellsOf(e);
  const lock = e.username ? (await lockState([e.username])).get(e.username) : undefined;
  const locked = !!lock && lock.count >= LOCK_THRESHOLD;
  const events = await accountEvents(id);
  const actorIds = [...new Set([...events.map((x) => x.userId), ...e.permissionOverrides.flatMap((o) => [o.createdById, o.endedById])].filter((x): x is string => !!x))];
  const actors = new Map((await prisma.employee.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]));
  const created = events.find((x) => x.action === "EMPLOYEE_CREATED");
  const lastPerm = events.find((x) => ["EMPLOYEE_PERMISSIONS_CHANGED", "EMPLOYEE_ROLE_CHANGED"].includes(x.action));
  const signIn = (await lastSignIns([id])).get(id);
  const pwChanged = events.find((x) => x.action === "PASSWORD_CHANGED_SELF" || (x.action === "EMPLOYEE_CREDENTIAL_CHANGED" && JSON.stringify(x.metadata ?? {}).includes("password")));
  const pinChange = await prisma.hrAuditLog.findFirst({ where: { action: "PIN_CHANGED_SELF", entityType: "Employee", entityId: id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }).catch(() => null);
  const overrides = e.permissionOverrides.map((o) => ({
    id: o.id, module: o.module, sub: o.sub, effect: o.effect, value: o.value, roleValue: o.roleValue, sensitive: o.sensitive, reason: o.reason,
    expiresAt: iso(o.expiresAt), reviewAt: iso(o.reviewAt), createdAt: o.createdAt.toISOString(), createdByName: o.createdById ? actors.get(o.createdById) ?? null : null,
    endedAt: iso(o.endedAt), endReason: o.endReason, endedByName: o.endedById ? actors.get(o.endedById) ?? null : null,
  }));
  const groups = explain(effective, template, overrides);
  const caps = usersCaps(viewer);
  return {
    id: e.id, name: e.name, username: e.username, phoneNumber: e.phoneNumber, role: roleOf(e), customized: isCustomized(effective, template),
    status: statusOf(e, locked), active: e.active, self: viewer.id === e.id,
    lock: locked ? { attempts: lock!.count, since: iso(lock!.last) } : null,
    hr: e.hrPerson ? { id: e.hrPerson.id, name: e.hrPerson.fullNameAr, nameEn: e.hrPerson.fullNameEn, jobTitle: e.hrPerson.jobTitle, department: e.hrPerson.department?.nameAr ?? null, departmentEn: e.hrPerson.department?.nameEn ?? null } : null,
    external: !!e.externalPerson,
    // «البريد الإلكتروني للشركة» (feat/credit-hold): the linked HR person's, else the account's own.
    companyEmail: { email: (e.hrPerson ? e.hrPerson.workEmail : e.workEmail) ?? null, source: e.hrPerson ? "hr" : "account" },
    createdAt: e.createdAt.toISOString(), createdByName: created?.userId ? actors.get(created.userId) ?? null : null,
    lastPermissionChange: lastPerm ? { at: lastPerm.occurredAt.toISOString(), byName: lastPerm.userId ? actors.get(lastPerm.userId) ?? null : null } : null,
    lastSignIn: signIn ? { at: signIn.at.toISOString(), method: signIn.method, device: describeUserAgent(signIn.userAgent) } : null,
    password: { set: !!e.password, temporary: e.passwordMustChange, tempExpiresAt: iso(e.passwordTempExpiresAt), changedAt: pwChanged ? pwChanged.occurredAt.toISOString() : null },
    pin: { set: !!e.pinLookup && !e.pinResetRequired, resetPending: e.pinResetRequired, changedAt: iso(pinChange?.createdAt) },
    // Workstations W2: the station PIN the person set themselves (StationPin; never its value).
    stationPin: await prisma.stationPin.findUnique({ where: { employeeId: id }, select: { setAt: true, attempts: { where: { lockedAt: { not: null } }, select: { lockedAt: true } } } })
      .then((sp) => ({ set: !!sp, setAt: iso(sp?.setAt), locked: (sp?.attempts.length ?? 0) > 0 })),
    template, effective, groups, overrides,
    sensitive: sensitiveActive(effective).map((ref) => ({ key: cellKey(ref), module: ref.module, sub: ref.sub, source: effectOf(ref, getCell(effective, ref), getCell(template, ref)) ? "override" : "role" })),
    events: events.filter((x) => AUDIT_ACTIONS[x.action]).map((x) => ({ ...describe(x, actors, viewer.preferredLanguage === "en" ? "en" : "ar"), device: describeUserAgent(x.userAgent) })),
    powerUser: isPowerUserAccount(e.role, effective),
    caps: { ...caps, manageThis: caps.manage && viewer.id !== e.id, accessThis: viewer.id !== e.id && (caps.manage || (caps.powerUser && !isAdminAccount(e))) },
    computedAt: new Date().toISOString(),
  };
}

/** UR-02d (another account's devices and sessions, administrator only). Refs only, never ids. */
export async function accountSessions(id: string) {
  const now = Date.now();
  const rows = await prisma.authSession.findMany({
    where: { employeeId: id, OR: [{ createdAt: { gte: new Date(now - 90 * 24 * 60 * 60 * 1000) } }, { revokedAt: null, expiresAt: { gt: new Date(now) } }] },
    orderBy: { createdAt: "desc" }, take: 500,
    select: { id: true, method: true, mfa: true, createdAt: true, lastSeenAt: true, authTime: true, expiresAt: true, revokedAt: true, userAgent: true, deviceId: true },
  });
  const sessions = rows.filter((r) => isLive(r, now)).map((r) => ({ ref: sessionRef(r.id), method: r.method, mfa: r.mfa, createdAt: r.createdAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(), device: describeUserAgent(r.userAgent), deviceRef: deviceRef(deviceKey(r)) }));
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(deviceKey(r), [...(groups.get(deviceKey(r)) ?? []), r]);
  const devices = [...groups.entries()].map(([k, list]) => {
    const signIns = list.filter((s) => s.authTime.getTime() >= s.createdAt.getTime() - 1000);
    const last = signIns[0] ?? null;
    return { ref: deviceRef(k), device: describeUserAgent(list[0].userAgent), lastSignInAt: iso(last?.createdAt), lastSignInMethod: last?.method ?? null, lastSeenAt: list.map((s) => s.lastSeenAt).sort((a, b) => b.getTime() - a.getTime())[0].toISOString(), liveSessions: list.filter((s) => isLive(s, now)).length };
  }).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  return { sessions: sessions.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)), devices };
}

/** End one session, the sessions of one device («إلغاء الثقة»), or all of an account's sessions. */
export async function endAccountSessions(ctx: AuditContext, id: string, target: { session?: string; device?: string; reason?: string | null }): Promise<number> {
  const now = Date.now();
  const e = await prisma.employee.findUnique({ where: { id }, select: { name: true } });
  if (!e) throw new UsersError(404, "NOT_FOUND", "المستخدم غير موجود.", "User not found.");
  const live = await prisma.authSession.findMany({ where: { employeeId: id, revokedAt: null, expiresAt: { gt: new Date(now) } }, select: { id: true, revokedAt: true, expiresAt: true, lastSeenAt: true, deviceId: true, userAgent: true } });
  const hit = live.filter((s) => isLive(s, now) && (target.session ? sessionRef(s.id) === target.session : target.device ? deviceRef(deviceKey(s)) === target.device : true));
  if ((target.session || target.device) && !hit.length) throw new UsersError(404, "SESSION_NOT_FOUND", "الجلسة غير موجودة أو انتهت.", "That session does not exist or has ended.");
  const reasonCode = target.session ? "SESSION_ENDED_ADMIN" : target.device ? "DEVICE_SESSIONS_ENDED_ADMIN" : "SESSIONS_ENDED_ADMIN";
  await prisma.$transaction(async (tx) => {
    for (const s of hit) await revokeSession(s.id, reasonCode, tx);
    await recordUsersAudit(tx, ctx, reasonCode, { targetEmployeeId: id, targetName: e.name, sessions: hit.length, ...(target.reason ? { reason: target.reason } : {}) });
  }, TX_OPTS);
  return hit.length;
}

export async function recordUsersAudit(tx: Prisma.TransactionClient | typeof prisma, ctx: AuditContext, action: string, metadata: Record<string, unknown>) {
  await tx.authAuditLog.create({ data: { userId: ctx.actorId, action, result: "SUCCESS", sourceInterface: "WEB", ipHash: ctx.ipHash, userAgent: ctx.userAgent, metadata: metadata as Prisma.InputJsonValue } });
}

// ── A change of one account's access (UR-02b → UR-10; UR-09 add / remove) ──────────────────────

export type AccessChange = {
  /** A system role key, or «custom» with accessRoleId for a custom role; absent = unchanged. */
  role?: string; accessRoleId?: string | null;
  /** The cells the editor set (cell key → value). */
  cells: Record<string, string>;
  reason: string; expiresAt?: string | null;
  /** A permanent sensitive grant (O-2): needs a review date; SIMPLE MODE only (no approver otherwise). */
  permanent?: boolean; reviewAt?: string | null;
};

function parseDate(v: unknown, code: string): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new UsersError(400, code, "التاريخ غير صالح.", "Invalid date.");
  return d;
}

/**
 * Compose and validate the document a change will store, then run it through the shared account
 * path (updateAccount: every existing check, the lock, the audit) and record its exceptions in the
 * same transaction. Refusals happen before anything is written.
 */
export async function changeAccess(request: Request, user: SessionUser, id: string, raw: unknown) {
  const b = (raw ?? {}) as Record<string, unknown>;
  const reason = cleanReason(b.reason);
  if (id === user.id) throw new UsersError(403, "SELF_ACCESS_CHANGE", "لا يمكنك تغيير دورك أو صلاحياتك. يغيّرها مسؤول آخر.", "You cannot change your own role or permissions. Another administrator does.");
  await settleExpiredOverrides(id);
  const e = await prisma.employee.findUnique({ where: { id }, select: { id: true, role: true, permissions: true, accessRoleId: true, active: true } });
  if (!e) throw new UsersError(404, "NOT_FOUND", "المستخدم غير موجود.", "User not found.");

  // The role after the change.
  let roleKey = e.role;
  let accessRoleId: string | null = e.accessRoleId;
  if (b.accessRoleId !== undefined && b.accessRoleId !== null && b.accessRoleId !== "") {
    const r = await prisma.accessRole.findUnique({ where: { id: String(b.accessRoleId) }, select: { id: true } });
    if (!r) throw new UsersError(400, "ROLE_NOT_FOUND", "الدور غير موجود.", "Role not found.");
    roleKey = "custom"; accessRoleId = r.id;
  } else if (typeof b.role === "string" && b.role) {
    if (!SYSTEM_ROLES.some((r) => r.key === b.role) && b.role !== "custom") throw new UsersError(400, "UNKNOWN_ROLE", "دور غير معروف.", "Unknown role.");
    roleKey = b.role; accessRoleId = null;
  }
  const template = await accountTemplate(prisma, { role: roleKey, accessRoleId });
  const roleChanged = roleKey !== e.role || accessRoleId !== e.accessRoleId;

  // The cells the editor set.
  const cellsIn = (b.cells && typeof b.cells === "object" ? b.cells : {}) as Record<string, unknown>;
  const set: { ref: CellRef; value: CellValue }[] = [];
  for (const [k, v] of Object.entries(cellsIn)) {
    const ref = parseCellKey(k);
    if (!ref || !validValue(ref, v)) throw new UsersError(400, "INVALID_CELL", `خانة غير صالحة: ${k}`, `Invalid cell: ${k}`);
    set.push({ ref, value: v });
  }
  if (!set.length && !roleChanged) throw new UsersError(400, "NOTHING_TO_SAVE", "لا تغييرات للحفظ.", "Nothing to save.");

  const now = new Date();
  const expiresAt = parseDate(b.expiresAt, "INVALID_EXPIRY");
  const reviewAt = parseDate(b.reviewAt, "INVALID_REVIEW");
  if (expiresAt && expiresAt.getTime() <= now.getTime()) throw new UsersError(400, "EXPIRY_IN_PAST", "تاريخ الانتهاء يجب أن يكون في المستقبل.", "The expiry must be in the future.");
  if (reviewAt && reviewAt.getTime() <= now.getTime()) throw new UsersError(400, "REVIEW_IN_PAST", "تاريخ المراجعة يجب أن يكون في المستقبل.", "The review date must be in the future.");

  // The exceptions that stay in force (a role change keeps them: «يستبدل القالب ويُبقي الاستثناءات»).
  const keep = await prisma.permissionOverride.findMany({ where: { employeeId: id, endedAt: null }, select: { module: true, sub: true, value: true, endedAt: true, expiresAt: true } });
  const before = storedCells(e.permissions as string, e.role);
  // Cells that differ from the old role with no exception on record (set before exceptions existed)
  // are kept too, when the role is unchanged — a save must not silently drop them.
  const legacy = roleChanged ? [] : allCells().filter((ref) => getCell(before, ref) !== getCell(template, ref) && !keep.some((k) => k.module === ref.module && (k.sub ?? null) === ref.sub)).map((ref) => ({ module: ref.module, sub: ref.sub, value: getCell(before, ref), endedAt: null, expiresAt: null }));
  const desired = composeAccount(template, [...keep, ...legacy], set, now.getTime());
  // UR-S12: an action the editor turned on under a closed module is an error; others are cleared.
  for (const x of set) if (x.ref.sub && x.value === "true" && desired[x.ref.module].access === "none") {
    throw new UsersError(400, "SUB_WITHOUT_MODULE", "الإجراء مفعّل والوحدة «لا وصول». اختر «عرض» أو أزل الإجراء.", "An action is on while its module has no access.", { cells: [cellKey(x.ref)] });
  }
  for (const m of Object.keys(desired)) if (desired[m].access === "none") for (const s of Object.keys(desired[m].sub)) desired[m].sub[s] = false;

  // A power user's guardrails, refused here first so the screen shows the real reason (the shared
  // account path checks them again under the row lock).
  const actorCells = normalize(user.permissions);
  if (accessActor(user) === "power") {
    const r = powerUserRefusal({ actor: actorCells, targetRole: e.role, desiredRole: roleKey, before: effectiveCells(e.permissions as string, e.role), after: effectiveCells(JSON.stringify(toDocument(desired)), roleKey) });
    if (r) throw new UsersError(403, r.code, POWER_REFUSAL_TEXT[r.code].ar, POWER_REFUSAL_TEXT[r.code].en, r.cells ? { cells: r.cells } : undefined);
  }

  // O-2: a sensitive GRANT made now needs an expiry, or — permanent — a review date and (SIMPLE MODE
  // off) a separate approval this path does not provide (UR-S21 / UR-S22).
  const newSensitive = set.filter((x) => isSensitive(x.ref.module, x.ref.sub) && effectOf(x.ref, getCell(desired, x.ref), getCell(template, x.ref)) === "GRANT");
  if (newSensitive.length && !expiresAt) {
    if (b.permanent !== true) throw new UsersError(400, "SENSITIVE_EXPIRY_REQUIRED", "مطلوب: الصلاحية الحساسة المؤقتة تتطلب تاريخ انتهاء. لم يُحفظ شيء.", "Required: a temporary sensitive permission needs an expiry date. Nothing was saved.", { cells: newSensitive.map((x) => cellKey(x.ref)) });
    if (!reviewAt) throw new UsersError(400, "REVIEW_DATE_REQUIRED", "المنح الحساس الدائم يتطلب تاريخ مراجعة دورية.", "A permanent sensitive grant needs a periodic review date.");
    if (!isSimpleMode()) throw new UsersError(409, "PERMANENT_SENSITIVE_NEEDS_APPROVAL", "منح حساس دائم: يتطلب اعتمادًا من مخوَّل غير طالب المنح وتاريخ مراجعة دورية. لا يسري قبل الاعتماد.", "A permanent sensitive grant needs approval by an authorised person other than the requester.");
  }

  const desiredDoc = toDocument(desired);
  // The exceptions this save makes, named in the audit event of the change itself (UR-12 «منح … حتى …
  // · منع …»); the cells' before / after are the event's exact diff.
  const planned = set.map((x) => ({ cell: cellKey(x.ref), effect: effectOf(x.ref, getCell(desired, x.ref), getCell(template, x.ref)), value: getCell(desired, x.ref), roleValue: getCell(template, x.ref) })).filter((x) => x.effect);
  return updateAccount(request, user, id, { role: roleKey, permissions: desiredDoc, reason }, {
    accessRoleId,
    auditExtra: { reason, via: "USERS_SCREEN", overrides: planned, ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}), ...(reviewAt && !expiresAt ? { reviewAt: reviewAt.toISOString() } : {}), ...(roleChanged ? { roleId: accessRoleId ?? roleKey } : {}) },
    afterUpdate: async (tx, ctx) => {
      const after = storedCells(ctx.updated.permissions, ctx.updated.role);
      await recordOverrides(tx, { employeeId: id, template, after, requested: set.map((x) => x.ref), reason, expiresAt, reviewAt: expiresAt ? null : reviewAt, actorId: user.id, now });
    },
  });
}

/** The cell value a removed exception returns to (the role's value). */
export async function removeOverride(request: Request, user: SessionUser, id: string, overrideId: string, raw: unknown) {
  const o = await prisma.permissionOverride.findFirst({ where: { id: overrideId, employeeId: id, endedAt: null } });
  if (!o) throw new UsersError(404, "OVERRIDE_NOT_FOUND", "الاستثناء غير موجود أو انتهى.", "That exception does not exist or has ended.");
  const e = await prisma.employee.findUniqueOrThrow({ where: { id }, select: { role: true, accessRoleId: true } });
  const template = await accountTemplate(prisma, e);
  const ref = { module: o.module, sub: o.sub };
  return changeAccess(request, user, id, { cells: { [cellKey(ref)]: getCell(template, ref) }, reason: (raw as { reason?: unknown })?.reason });
}

// ── New accounts (UR-03) ───────────────────────────────────────────────────────────────────────

const TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** A temporary password: 3 × 4 characters, unambiguous, shown once (UR-03e). */
export function temporaryPassword(): string {
  const part = () => Array.from({ length: 4 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join("");
  return `${part()}-${part()}-${part()}`;
}
export const TEMP_PASSWORD_HOURS = 72;

/** An unusable PIN verifier: the account has no PIN until its person sets one (UR-03d «رمز المحطة»). */
async function unusablePin(): Promise<string> {
  return hash(randomBytes(32).toString("base64url"), 10);
}

export async function usernameAvailable(raw: unknown): Promise<{ username: string | null; valid: boolean; available: boolean; suggestion: string | null }> {
  const u = normalizeUsername(raw);
  if (!u || !usernameValid(u)) return { username: u, valid: false, available: false, suggestion: null };
  const taken = async (x: string) => (await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Employee" WHERE auth_norm_username("username") = auth_norm_username(${x}) LIMIT 1`).length > 0;
  if (!(await taken(u))) return { username: u, valid: true, available: true, suggestion: null };
  let suggestion: string | null = null;
  const [first, ...rest] = u.split(".");
  const candidates = [rest.length ? `${first}.${rest.join(".")}${rest.join("").slice(0, 1)}` : `${u}1`, `${u}2`, `${u}.${new Date().getFullYear() % 100}`];
  for (const c of candidates) if (usernameValid(c) && !(await taken(c))) { suggestion = c; break; }
  return { username: u, valid: true, available: false, suggestion };
}

/** HR people with no login yet (UR-03a «ملف الموظف»), still employed. */
export async function linkablePeople() {
  return prisma.hrEmployee.findMany({
    where: { accountId: null, status: { not: "SEPARATED" } },
    select: { id: true, fullNameAr: true, fullNameEn: true, employeeNo: true, jobTitle: true, department: { select: { nameAr: true } } },
    orderBy: { fullNameAr: "asc" }, take: 500,
  });
}

export async function createUser(request: Request, user: SessionUser, raw: unknown) {
  const b = (raw ?? {}) as Record<string, unknown>;
  const ctx = auditContext(request, user.id);
  const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 120) throw new UsersError(400, "NAME_REQUIRED", "الاسم المعروض مطلوب.", "A display name is required.");
  const avail = await usernameAvailable(b.username);
  if (!avail.valid) throw new UsersError(400, "USERNAME_INVALID", "اسم المستخدم من 3 إلى 64 حرفًا: حروف إنجليزية صغيرة وأرقام و . _ - فقط.", "A username is 3–64 characters: a–z, 0–9, dot, underscore or hyphen.");
  if (!avail.available) throw new UsersError(409, "USERNAME_TAKEN", `مستخدَم لحساب آخر.${avail.suggestion ? ` جرّب ${avail.suggestion}` : ""}`, "This username is taken.", { suggestion: avail.suggestion });

  // The role (P-1: «بلا وصول» unless one is chosen explicitly).
  let roleKey = "custom";
  let accessRoleId: string | null = null;
  if (typeof b.accessRoleId === "string" && b.accessRoleId) {
    if (!(await prisma.accessRole.findUnique({ where: { id: b.accessRoleId }, select: { id: true } }))) throw new UsersError(400, "ROLE_NOT_FOUND", "الدور غير موجود.", "Role not found.");
    accessRoleId = b.accessRoleId;
  } else if (typeof b.role === "string" && b.role) {
    if (!SYSTEM_ROLES.some((r) => r.key === b.role) && b.role !== "custom") throw new UsersError(400, "UNKNOWN_ROLE", "دور غير معروف.", "Unknown role.");
    roleKey = b.role;
  }
  const template = await accountTemplate(prisma, { role: roleKey, accessRoleId });

  // Sensitive permissions in the role's modules, each enabled explicitly (P-3), with a reason and expiry.
  const sensitiveKeys = Array.isArray(b.sensitive) ? b.sensitive.filter((x): x is string => typeof x === "string") : [];
  const set: { ref: CellRef; value: CellValue }[] = [];
  for (const k of sensitiveKeys) {
    const ref = parseCellKey(k);
    if (!ref || !ref.sub || !isSensitive(ref.module, ref.sub) || template[ref.module].access === "none") throw new UsersError(400, "INVALID_SENSITIVE", `صلاحية حساسة غير صالحة: ${k}`, `Invalid sensitive permission: ${k}`);
    set.push({ ref, value: "true" });
  }
  let reason: string | null = null;
  let expiresAt: Date | null = null;
  if (set.length) {
    reason = cleanReason(b.sensitiveReason);
    expiresAt = parseDate(b.sensitiveExpiresAt, "INVALID_EXPIRY");
    if (!expiresAt || expiresAt.getTime() <= Date.now()) throw new UsersError(400, "SENSITIVE_EXPIRY_REQUIRED", "مطلوب: الصلاحية الحساسة المؤقتة تتطلب تاريخ انتهاء.", "A temporary sensitive permission needs an expiry date.");
  }
  let cells = composeAccount(template, [], set);
  let doc = JSON.stringify(toDocument(cells));
  // Q-3: a new account never starts with conflicting payroll duties.
  assertNoNewPayrollConflicts({ permissions: doc, role: roleKey }, null);
  // Owner decision (16 Oct): a new login is nobody's verified person yet, so — SIMPLE MODE off — no
  // privileged permission is granted at creation; it is granted once the login is a verified person.
  let withheld: string[] = [];
  if (!isSimpleMode()) {
    withheld = gainedPrivileges({ permissions: doc, role: roleKey }, null);
    if (withheld.length) {
      const w = withoutPrivileged({ permissions: doc, role: roleKey }, null);
      doc = w.permissions; roleKey = w.role;
      cells = storedCells(doc, roleKey);
    }
  }

  const linkId = typeof b.hrEmployeeId === "string" && b.hrEmployeeId ? b.hrEmployeeId : null;
  const temp = temporaryPassword();
  const passwordHash = await hash(temp, 10);
  const pin = await unusablePin();
  const tempExpiresAt = new Date(Date.now() + TEMP_PASSWORD_HOURS * 60 * 60 * 1000);
  const phoneNumber = typeof b.phoneNumber === "string" && b.phoneNumber.trim() ? b.phoneNumber.trim().slice(0, 30) : null;

  const created = await prisma.$transaction(async (tx) => {
    const emp = await tx.employee.create({
      data: {
        name, username: avail.username, pin, pinLookup: null, pinResetRequired: true, password: passwordHash, passwordMustChange: true, passwordTempExpiresAt: tempExpiresAt,
        role: roleKey, accessRoleId, permissions: doc, defaultRoute: "/dashboard", phoneNumber,
      },
      select: { id: true, name: true, role: true, active: true },
    });
    if (linkId) {
      const person = await tx.hrEmployee.findUnique({ where: { id: linkId }, select: { id: true, accountId: true } });
      if (!person) throw new UsersError(400, "HR_NOT_FOUND", "ملف الموظف غير موجود.", "HR record not found.");
      if (person.accountId) throw new UsersError(409, "HR_HAS_ACCOUNT", "لملف الموظف هذا حساب بالفعل.", "This HR record already has a login.");
      // SIMPLE MODE: a privileged new login is allowed and its audit carries the bypass marker.
      const bypass = await assertLinkChangeAllowed(tx, null, emp.id);
      await tx.hrEmployee.update({ where: { id: linkId }, data: { accountId: emp.id, version: { increment: 1 } } });
      await hrAudit(tx, { action: "ACCOUNT_LINK", entityType: "HrEmployee", entityId: linkId, employeeId: linkId, before: { accountId: null }, after: { accountId: emp.id, ...bypass }, actorId: user.id });
    }
    if (set.length) {
      await recordOverrides(tx, { employeeId: emp.id, template, after: cells, requested: set.map((x) => x.ref), reason: reason!, expiresAt, reviewAt: null, actorId: user.id });
    }
    const duties = payrollDuties(effectivePermissions(doc, roleKey));
    if (duties.length) await tx.hrAuditLog.create({ data: { action: "HR_EFFECTIVE_DUTIES_CHANGED", entityType: "Employee", entityId: emp.id, before: [], after: { role: roleKey, duties }, actorId: user.id } });
    if (withheld.length) await tx.hrAuditLog.create({ data: { action: "PERMISSION_GRANT_REFUSED_UNVERIFIED", entityType: "Employee", entityId: emp.id, after: { privileged: withheld, reason }, actorId: user.id } });
    // The credential the account was created with is never recorded — only that one was issued.
    await recordEmployeeAudit(tx, ctx, [{
      action: "EMPLOYEE_CREATED", targetEmployeeId: emp.id, targetName: emp.name,
      metadata: { role: roleKey, accessRoleId, active: true, credentials: ["password"], temporaryPassword: true, hrLinked: !!linkId, sensitive: set.map((x) => cellKey(x.ref)), via: "USERS_SCREEN", ...(reason ? { reason } : {}) },
    }]);
    return emp;
  }, TX_OPTS);
  return { id: created.id, name: created.name, username: avail.username, temporaryPassword: temp, expiresAt: tempExpiresAt.toISOString(), withheld };
}

// ── Credentials (UR-04) ────────────────────────────────────────────────────────────────────────

export async function credentialsAction(request: Request, user: SessionUser, id: string, raw: unknown) {
  const b = (raw ?? {}) as Record<string, unknown>;
  const action = b.action;
  const reason = cleanReason(b.reason);
  if (id === user.id) throw new UsersError(403, "SELF_CREDENTIALS", "بيانات دخولك من «ملفي والأمان».", "Your own credentials are changed from your profile.");
  const ctx = auditContext(request, user.id);
  const e = await prisma.employee.findUnique({ where: { id }, select: { id: true, name: true, username: true, active: true } });
  if (!e) throw new UsersError(404, "NOT_FOUND", "المستخدم غير موجود.", "User not found.");

  if (action === "unlock") {
    if (!e.username) throw new UsersError(409, "NO_USERNAME", "لا اسم مستخدم لهذا الحساب؛ لا قفل لفتحه.", "This account has no username, so it has no lock.");
    const n = await prisma.$transaction(async (tx) => {
      const r = await tx.loginAttempt.deleteMany({ where: { identifierHash: loginIdentifier(e.username!) } });
      await recordUsersAudit(tx, ctx, "ACCOUNT_UNLOCKED", { targetEmployeeId: id, targetName: e.name, reason, attemptsCleared: r.count });
      return r.count;
    }, TX_OPTS);
    return { action, attemptsCleared: n };
  }

  if (action === "reset_password") {
    const temp = temporaryPassword();
    const expiresAt = new Date(Date.now() + TEMP_PASSWORD_HOURS * 60 * 60 * 1000);
    let applied = false;
    const res = await updateAccount(request, user, id, { password: temp, reason }, {
      auditExtra: { reason, kind: "TEMPORARY_PASSWORD", via: "USERS_SCREEN" },
      afterUpdate: async (tx) => {
        const row = await tx.employee.findUniqueOrThrow({ where: { id }, select: { password: true } });
        // Applied now (not held for a second account editor): mark it temporary and end every session.
        if (row.password && (await import("bcryptjs")).compareSync(temp, row.password)) {
          applied = true;
          await tx.employee.update({ where: { id }, data: { passwordMustChange: true, passwordTempExpiresAt: expiresAt } });
          await revokeSessions(tx, id, "PASSWORD_RESET_ADMIN");
        }
      },
    });
    if (!res.ok) return res;
    const body = await res.json();
    return { action, temporaryPassword: temp, expiresAt: expiresAt.toISOString(), applied, pendingApproval: body.pendingApproval ?? null };
  }

  if (action === "reset_pin") {
    const pin = await unusablePin();
    await prisma.$transaction(async (tx) => {
      if (!(await lockEmployeeForAdmin(tx, id))) throw new UsersError(404, "NOT_FOUND", "المستخدم غير موجود.", "User not found.");
      await tx.employee.update({ where: { id }, data: { pin, pinLookup: null, pinResetRequired: true } });
      // Workstations W2: «إعادة تعيين رمز المحطة» clears the station PIN too (and its lockouts); the
      // person sets a new one from «ملفي» after confirming their identity (J-6).
      const { clearStationPin } = await import("@/lib/services/station/admin");
      const station = await clearStationPin(tx, id);
      const ended = await revokeSessions(tx, id, "PIN_RESET_ADMIN");
      await recordEmployeeAudit(tx, ctx, [{ action: "EMPLOYEE_CREDENTIAL_CHANGED", targetEmployeeId: id, targetName: e.name, metadata: { credentials: ["pin"], kind: "PIN_CLEARED", reason, sessionsEnded: ended + station.sessionsEnded, stationPinCleared: station.cleared, via: "USERS_SCREEN" } }]);
    }, TX_OPTS);
    return { action };
  }

  // Workstations W2 (D7): a station PIN locked after too many wrong attempts on a device is
  // re-enabled here; the PIN itself is unchanged (UR-04).
  if (action === "reenable_station_pin") {
    const n = await prisma.$transaction(async (tx) => {
      const { reenableStationPin } = await import("@/lib/services/station/admin");
      const r = await reenableStationPin(tx, id);
      await recordUsersAudit(tx, ctx, "STATION_PIN_REENABLED", { targetEmployeeId: id, targetName: e.name, reason, devices: r.devices });
      // feat/notifications: the person learns their station PIN works again (me.station_pin_reenabled).
      if (r.devices > 0) {
        const { notify } = await import("@/lib/notifications/notify");
        await notify(tx, { event: "me.station_pin_reenabled", dedupeKey: `${id}:${Date.now()}`, actorId: ctx.actorId ?? null, entity: { type: "Employee", id }, people: { subject: id } });
      }
      return r.devices;
    }, TX_OPTS);
    return { action, devices: n };
  }
  throw new UsersError(400, "UNKNOWN_ACTION", "إجراء غير معروف.", "Unknown action.");
}

// ── Revocation (UR-11) ─────────────────────────────────────────────────────────────────────────

/** What the revoke dialog needs: can the account be deleted (a dry run that always rolls back), its claimed station tasks. */
export async function revokeCheck(id: string) {
  const claims = await prisma.workItemClaim.findMany({ where: { claimedById: id, status: "ACTIVE" }, select: { id: true, stationType: true, itemType: true, itemId: true, claimedAt: true } });
  let deletable = true;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.employee.delete({ where: { id } });
      throw new Error("ROLLBACK_DRY_RUN");
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2003" || code === "P2014") deletable = false;
    else if ((err as Error)?.message !== "ROLLBACK_DRY_RUN") deletable = false;
  }
  return { deletable, claims: claims.map((c) => ({ ...c, claimedAt: c.claimedAt.toISOString() })) };
}

export async function revokeAccess(request: Request, user: SessionUser, id: string, raw: unknown) {
  const b = (raw ?? {}) as Record<string, unknown>;
  const reason = cleanReason(b.reason);
  const claims = b.claims === "keep" ? "keep" : "release";
  if (id === user.id) throw new UsersError(403, "SELF_ACCESS_CHANGE", "لا يمكنك إيقاف حسابك.", "You cannot revoke your own access.");
  return updateAccount(request, user, id, { active: false, reason }, {
    auditExtra: { reason, claims, via: "USERS_SCREEN" },
    afterUpdate: async (tx, ctx) => {
      if (ctx.updated.active) return;
      // «تُنهى جلساتها كلها» — the rows are ended too, so «الجلسات النشطة» lists none.
      await revokeSessions(tx, id, "ACCESS_REVOKED");
      if (claims === "release") {
        await tx.workItemClaim.updateMany({ where: { claimedById: id, status: "ACTIVE" }, data: { status: "RELEASED", activeItemRef: null, releasedAt: new Date(), releasedById: user.id, releasedByName: user.name } });
      }
    },
  });
}

export async function reactivate(request: Request, user: SessionUser, id: string, raw: unknown) {
  const reason = cleanReason((raw as { reason?: unknown })?.reason);
  return updateAccount(request, user, id, { active: true, reason }, { auditExtra: { reason, via: "USERS_SCREEN" } });
}

/** Re-exported for the routes. */
export { templateCells, applyOverrides };
