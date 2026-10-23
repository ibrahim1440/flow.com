// Workstations W2 — what a station device does before anybody works on it: activation (S1), the
// roster of tiles (S2), the station PIN sign-in (S3 / S4), and ending the session (S4 lock, S5
// switch, sign-out, the idle end). Every answer is generic where it could tell an outsider something
// (H1, PHASE7-DEVICES-BACKEND §3.7); every event is audited with sourceInterface STATION and never a
// PIN, code or token.
import { timingSafeEqual } from "node:crypto";
import { compare } from "bcryptjs";
import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { signToken } from "@/lib/auth";
import { credentialVersion } from "@/lib/credential-version";
import { revokeSession } from "@/lib/auth/session";
import { extractIp, hashRateLimitKey, isIdentifierRateLimited, isPairRateLimited, pruneExpired, recordFailedAttempt } from "@/lib/rate-limit";
import { requirePinLookupSecret } from "@/lib/pin-lookup";
import { validatePin } from "@/lib/pin-policy";
import { releaseClaim } from "./claims";
import { newRequestKey } from "@/lib/request-key";
import {
  STATION_DEVICE_COOKIE, STATION_DEVICE_COOKIE_MAX_AGE, STATION_SESSION_COOKIE, STATION_SESSION_ABSOLUTE_MS,
  activationCodeHash, deviceTokenHash, newDeviceToken, normalizeActivationCode, normalizeDeviceCode, stationInitials, stationPinVerifierInput, STATION_HOME,
  type StationPolicyValues,
} from "@/lib/station/device";
import { afterWrongPin, isAdminRole, onRoster } from "@/lib/station/access";
import { StationError, stationAudit, stationPolicy, type DeviceRow, type StationRow, stationActorOf } from "./guard";

const reqInfo = (request: Request) => ({ ip: extractIp(request), userAgent: request.headers.get("user-agent") });
const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: "strict" as const, path: "/" };

/** The station cookies: set the device token (activation) and clear the session. */
export function setDeviceCookie(res: NextResponse, token: string) {
  res.cookies.set(STATION_DEVICE_COOKIE, token, { ...COOKIE_BASE, maxAge: STATION_DEVICE_COOKIE_MAX_AGE });
  res.cookies.set(STATION_SESSION_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
  return res;
}
export function clearDeviceCookies(res: NextResponse) {
  res.cookies.set(STATION_DEVICE_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
  res.cookies.set(STATION_SESSION_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
  return res;
}
export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(STATION_SESSION_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
  return res;
}

const secret = () => process.env.JWT_SECRET ?? "";
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// ── S1 · activation ────────────────────────────────────────────────────────────────────────────
export const ACTIVATION_REFUSED = () => new StationError(401, "ACTIVATION_REFUSED", "رمز التفعيل غير صحيح أو انتهت صلاحيته. اطلب رمزًا جديدًا من «أجهزة المحطات».", "The activation code is wrong or has expired. Ask for a new one in “Station devices”.");
const RATE_LIMITED = () => new StationError(429, "RATE_LIMITED", "محاولات كثيرة. انتظر قليلًا ثم حاول.", "Too many attempts. Wait a little and try again.");
/** Wrong activation codes against one device's current code before the code is dropped. */
export const ACTIVATION_MAX_ATTEMPTS = 5;

/**
 * POST /api/station/activate {deviceCode, activationCode}: the device that showed deviceCode on S1
 * becomes ACTIVE with a new device token (hq_station). The code is single use, short lived, and its
 * wrong attempts are limited per device code and address (and per issued code: dropped at 5).
 */
export async function activateDevice(request: Request, raw: Record<string, unknown>, currentToken: string | null) {
  const info = reqInfo(request);
  const ipHash = hashRateLimitKey(info.ip);
  const deviceCode = normalizeDeviceCode(raw.deviceCode);
  const perCode = hashRateLimitKey(`station-activate:${deviceCode ?? "invalid"}`);
  const all = hashRateLimitKey("station-activate:all");
  await pruneExpired();
  if ((await isPairRateLimited(ipHash, perCode, ACTIVATION_MAX_ATTEMPTS)) || (await isIdentifierRateLimited(all, 30))) {
    await stationAudit({ action: "STATION_ACTIVATED", result: "REFUSED", reasonCode: "RATE_LIMITED", ...info });
    throw RATE_LIMITED();
  }
  const code = normalizeActivationCode(raw.activationCode);
  const failed = async (reason: string, device?: { id: string; stationId: string }) => {
    await recordFailedAttempt(ipHash, perCode);
    await recordFailedAttempt(ipHash, all);
    await stationAudit({ action: "STATION_ACTIVATED", result: "FAILURE", reasonCode: reason, device: device ?? null, ...info });
    return ACTIVATION_REFUSED();
  };
  if (!deviceCode || !code) throw await failed("MALFORMED");
  const hash = activationCodeHash(code, deviceCode, secret());
  const now = new Date();
  const pending = await prisma.stationDevice.findMany({ where: { deviceCode, status: "PENDING", activationCodeHash: { not: null } }, select: { id: true, stationId: true, activationCodeHash: true, activationExpiresAt: true, activationAttempts: true } });
  const match = pending.find((d) => d.activationCodeHash && same(d.activationCodeHash, hash));
  if (!match) {
    // Count the wrong code against every live code of this device code; drop a code at the limit.
    for (const d of pending) {
      const n = d.activationAttempts + 1;
      await prisma.stationDevice.updateMany({ where: { id: d.id, status: "PENDING" }, data: n >= ACTIVATION_MAX_ATTEMPTS ? { activationAttempts: n, activationCodeHash: null, activationExpiresAt: null } : { activationAttempts: n } });
    }
    throw await failed(pending.length ? "WRONG_CODE" : "NO_PENDING_DEVICE", pending[0]);
  }
  if (!match.activationExpiresAt || match.activationExpiresAt <= now) {
    await prisma.stationDevice.updateMany({ where: { id: match.id, status: "PENDING" }, data: { activationCodeHash: null, activationExpiresAt: null } });
    throw await failed("EXPIRED", match);
  }
  const token = newDeviceToken();
  const out = await prisma.$transaction(async (tx) => {
    // Single use: only the row still holding THIS code becomes active (a second use finds none).
    const r = await tx.stationDevice.updateMany({
      where: { id: match.id, status: "PENDING", activationCodeHash: hash },
      data: { status: "ACTIVE", tokenHash: deviceTokenHash(token), activatedAt: now, lastSeenAt: now, activationCodeHash: null, activationExpiresAt: null, activationAttempts: 0, userAgent: info.userAgent?.slice(0, 300) ?? null },
    });
    if (r.count !== 1) return null;
    // The browser held another device's token: that registration ends (one browser, one device).
    if (currentToken) {
      const old = await tx.stationDevice.findUnique({ where: { tokenHash: deviceTokenHash(currentToken) }, select: { id: true, status: true } });
      if (old && old.id !== match.id && old.status === "ACTIVE") {
        await tx.stationDevice.update({ where: { id: old.id }, data: { status: "REVOKED", revokedAt: now, revokeReason: "REPLACED_ON_THIS_BROWSER" } });
        await tx.authSession.updateMany({ where: { stationDeviceId: old.id, revokedAt: null }, data: { revokedAt: now, revokedReason: "STATION_DEVICE_REVOKED" } });
      }
    }
    return tx.stationDevice.findUniqueOrThrow({ where: { id: match.id }, select: { id: true, stationId: true, displayName: true, registeredById: true, station: { select: { name: true, type: true, place: true } } } });
  }, TX_OPTS);
  if (!out) throw await failed("ALREADY_USED", match);
  await stationAudit({ userId: out.registeredById, action: "STATION_ACTIVATED", result: "SUCCESS", device: out, ...info });
  return { token, device: out };
}

// ── S2 · the roster ────────────────────────────────────────────────────────────────────────────
export type RosterEntry = { id: string; name: string; initials: string; supervisor: boolean; locked: boolean };

/**
 * GET /api/station/roster: the assigned employees with a station PIN — name, initials, the
 * supervisor label and whether their PIN is locked on THIS device. Nothing else (no role, no
 * username, no permissions, no task data). Never the admin role (D12).
 */
export async function stationRoster(device: DeviceRow): Promise<RosterEntry[]> {
  const rows = await prisma.stationAssignment.findMany({
    where: { stationId: device.stationId },
    select: { supervisor: true, employee: { select: { id: true, name: true, role: true, active: true, stationPin: { select: { employeeId: true, attempts: { where: { stationDeviceId: device.id }, select: { lockedAt: true } } } } } } },
  });
  return rows
    .filter((r) => onRoster({ active: r.employee.active, role: r.employee.role, hasPin: !!r.employee.stationPin, assigned: true }))
    .map((r) => ({ id: r.employee.id, name: r.employee.name, initials: stationInitials(r.employee.name), supervisor: r.supervisor, locked: !!r.employee.stationPin?.attempts[0]?.lockedAt }))
    .sort((a, b) => a.name.localeCompare(b.name, "ar"));
}

// ── S3 · the station PIN ───────────────────────────────────────────────────────────────────────
const WRONG_PIN = () => new StationError(401, "STATION_PIN_WRONG", "الرمز غير صحيح. حاول مرة أخرى.", "The PIN is not correct. Try again.");
export const PIN_LOCKED = () => new StationError(423, "STATION_PIN_LOCKED", "تعذّر الدخول بهذا الرمز على هذا الجهاز. اطلب من مسؤول النظام إعادة تفعيله.", "This PIN cannot be used on this device. Ask the administrator to re-enable it.");
const NOT_ON_ROSTER = () => new StationError(401, "STATION_PIN_WRONG", "الرمز غير صحيح. حاول مرة أخرى.", "The PIN is not correct. Try again.");
const ADMIN_REFUSED = () => new StationError(403, "STATION_ADMIN_REFUSED", "حساب المسؤول لا يدخل من أجهزة المحطات. استخدم جهازك الشخصي.", "The administrator account does not sign in at station devices. Use your own device.");

/**
 * POST /api/station/sign-in {employeeId, pin}: the PIN is checked against the SELECTED employee only
 * (J-2). Wrong → counted per employee per device; at the policy limit the PIN locks on this device
 * (generic message) until the administrator re-enables it (UR-04). Right → every other session on
 * this device ends (one person at a time), and a STATION session opens bound to the device.
 */
export async function stationSignIn(request: Request, device: DeviceRow, station: StationRow, raw: Record<string, unknown>, policy: StationPolicyValues) {
  const info = reqInfo(request);
  const ipHash = hashRateLimitKey(info.ip);
  const perDevice = hashRateLimitKey(`station-pin:${device.id}`);
  await pruneExpired();
  if (await isPairRateLimited(ipHash, perDevice, 30)) {
    await stationAudit({ action: "STATION_SIGN_IN", result: "REFUSED", reasonCode: "RATE_LIMITED", device, ...info });
    throw RATE_LIMITED();
  }
  const employeeId = typeof raw.employeeId === "string" ? raw.employeeId : "";
  const pin = validatePin(raw.pin);
  const e = employeeId ? await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, name: true, role: true, active: true, permissions: true, preferredLanguage: true, username: true, pin: true, password: true, stationPin: { select: { verifier: true } } } }) : null;
  const assignment = e ? await prisma.stationAssignment.findUnique({ where: { stationId_employeeId: { stationId: station.id, employeeId: e.id } }, select: { supervisor: true } }) : null;
  if (e && e.active && isAdminRole(e.role)) {
    await stationAudit({ userId: e.id, action: "STATION_SIGN_IN", result: "REFUSED", reasonCode: "ADMIN_ROLE", device, ...info });
    throw ADMIN_REFUSED();
  }
  if (e && e.active && !assignment) {
    // S7: the attempt is recorded with the device and the employee («سُجّلت المحاولة …»).
    await stationAudit({ userId: e.id, action: "STATION_SIGN_IN", result: "REFUSED", reasonCode: "NOT_ASSIGNED", device, ...info });
    throw new StationError(403, "STATION_NOT_ASSIGNED", `${e.name} غير مكلّف بهذه المحطة.`, `${e.name} is not assigned to this station.`, { name: e.name });
  }
  if (!e || !assignment || !onRoster({ active: e.active, role: e.role, hasPin: !!e.stationPin, assigned: true })) {
    await recordFailedAttempt(ipHash, perDevice);
    await stationAudit({ userId: e?.id ?? null, action: "STATION_SIGN_IN", result: "FAILURE", reasonCode: "NOT_ON_ROSTER", device, ...info });
    throw NOT_ON_ROSTER();
  }
  const attempt = await prisma.stationPinAttempt.findUnique({ where: { employeeId_stationDeviceId: { employeeId: e.id, stationDeviceId: device.id } } });
  if (attempt?.lockedAt) {
    await stationAudit({ userId: e.id, action: "STATION_SIGN_IN", result: "REFUSED", reasonCode: "PIN_LOCKED", device, ...info });
    throw PIN_LOCKED();
  }
  const ok = pin.ok && (await compare(stationPinVerifierInput(pin.pin, requirePinLookupSecret()), e.stationPin!.verifier));
  if (!ok) {
    await recordFailedAttempt(ipHash, perDevice);
    const next = afterWrongPin(attempt?.failedCount ?? 0, policy.pinMaxAttempts);
    const now = new Date();
    await prisma.stationPinAttempt.upsert({
      where: { employeeId_stationDeviceId: { employeeId: e.id, stationDeviceId: device.id } },
      create: { employeeId: e.id, stationDeviceId: device.id, failedCount: next.failedCount, lastFailedAt: now, lockedAt: next.locked ? now : null },
      update: { failedCount: next.failedCount, lastFailedAt: now, lockedAt: next.locked ? now : null },
    });
    await stationAudit({ userId: e.id, action: "STATION_PIN_FAILED", result: "FAILURE", device, ...info });
    if (next.locked) {
      await stationAudit({ userId: e.id, action: "STATION_PIN_LOCKED", result: "REFUSED", reasonCode: `ATTEMPTS_${policy.pinMaxAttempts}`, device, ...info });
      // feat/notifications: the person is told in the ERP (me.station_pin_locked). No actor: the
      // attempts may not have been theirs. Best effort — the refusal stands either way.
      try {
        const { notify } = await import("@/lib/notifications/notify");
        await notify(prisma, { event: "me.station_pin_locked", dedupeKey: `${e.id}:${device.id}:${now.toISOString()}`, entity: { type: "StationDevice", id: device.id }, facts: { device: device.displayName }, people: { subject: e.id } });
      } catch (err) {
        console.error("[station] lock notification failed:", (err as Error)?.name ?? "error");
      }
      throw PIN_LOCKED();
    }
    throw WRONG_PIN();
  }
  const now = Date.now();
  const sessionId = (await import("node:crypto")).randomBytes(24).toString("base64url");
  const replaced = await prisma.$transaction(async (tx) => {
    await tx.stationPinAttempt.deleteMany({ where: { employeeId: e.id, stationDeviceId: device.id } });
    // One person at a time on a station device (PHASE7-DEVICES-BACKEND §3.3).
    const r = await tx.authSession.updateMany({ where: { stationDeviceId: device.id, revokedAt: null }, data: { revokedAt: new Date(now), revokedReason: "STATION_REPLACED" } });
    await tx.authSession.create({
      data: { id: sessionId, employeeId: e.id, method: "STATION_PIN", mfa: false, authFactor: null, scope: "STATION", stationId: station.id, stationDeviceId: device.id, expiresAt: new Date(now + STATION_SESSION_ABSOLUTE_MS), ipHash, userAgent: info.userAgent?.slice(0, 300) ?? null },
    });
    return r.count;
  }, TX_OPTS);
  const lang = e.preferredLanguage === "en" ? "en" : "ar";
  const token = await signToken({ id: e.id, name: e.name, role: e.role, permissions: {}, preferredLanguage: lang, cv: credentialVersion(e), sid: sessionId, scope: "STATION" } as never, new Date(now + STATION_SESSION_ABSOLUTE_MS));
  await stationAudit({ userId: e.id, action: "STATION_SIGN_IN", result: "SUCCESS", reasonCode: "STATION_PIN", device, metadata: { sessionsReplaced: replaced }, ...info });
  const res = NextResponse.json({ employee: { id: e.id, name: e.name, initials: stationInitials(e.name), supervisor: assignment.supervisor, preferredLanguage: lang }, home: STATION_HOME[station.type] }, { status: 200, headers: { "Cache-Control": "no-store" } });
  res.cookies.set(STATION_SESSION_COOKIE, token, { ...COOKIE_BASE, maxAge: Math.floor(STATION_SESSION_ABSOLUTE_MS / 1000) });
  return res;
}

// ── S4 / S5 · ending the session ───────────────────────────────────────────────────────────────
export type EndKind = "LOCK" | "SWITCH" | "SIGN_OUT" | "IDLE";

/**
 * Ends the station session (lock, switch, sign-out, the idle lock). S5: the outgoing employee
 * chooses what happens to an active claim — kept for them (default; never released without their
 * choice) or released for a colleague (logged in their name, no stock moves).
 */
export async function endStationSession(request: Request, ctx: { device: DeviceRow; session: { id: string; employeeId: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date }; employee: { id: string; name: string; role: string; permissions: string; preferredLanguage: string } }, kind: EndKind, claims: "keep" | "release") {
  const info = reqInfo(request);
  let released = 0;
  if (claims === "release") {
    const actor = stationActorOf(ctx.employee, ctx.session, ctx.device, false);
    const mine = await prisma.workItemClaim.findMany({ where: { claimedById: ctx.employee.id, status: "ACTIVE" }, select: { id: true } });
    for (const c of mine) {
      await releaseClaim({ user: actor, claimId: c.id, key: `station-switch-${newRequestKey()}` });
      released++;
    }
  }
  await revokeSession(ctx.session.id, `STATION_${kind}`);
  const action = kind === "SWITCH" ? "STATION_SWITCH" : "STATION_SIGN_OUT";
  await stationAudit({ userId: ctx.employee.id, action, result: "SUCCESS", reasonCode: kind, device: ctx.device, metadata: { claimsReleased: released }, ...info });
  const active = await prisma.workItemClaim.count({ where: { claimedById: ctx.employee.id, status: "ACTIVE" } });
  return { kind, released, activeTasks: active, at: new Date().toISOString(), employee: { id: ctx.employee.id, name: ctx.employee.name, initials: stationInitials(ctx.employee.name) } };
}

export { stationPolicy };
