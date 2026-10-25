// Owner security decision (16 Oct) — server-side sessions.
//
// A token is only a pointer: it names its AuthSession row (sid) and the account's credential
// digest (cv). A request is authenticated only while that row exists, is not revoked, and
// neither deadline has passed:
//   · idle:     SESSION_IDLE_MS since the session was last used (4 h);
//   · absolute: SESSION_ABSOLUTE_MS since sign-in (12 h), whatever the activity.
// Logout revokes the row, so a token replayed after logout (or after expiry) is refused (401).
// authTime is the last STRONG authentication (sign-in or step-up); sensitive actions need it
// within STEP_UP_MS (10 min), otherwise 401 REAUTH_REQUIRED.
import { randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { credentialVersion } from "@/lib/credential-version";
import { extractIp, hashRateLimitKey } from "@/lib/rate-limit";

import { SESSION_IDLE_MS, SESSION_ABSOLUTE_MS } from "./session-policy";
import { DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE, deviceIdFromCookieHeader, newDeviceId, validDeviceId } from "./device";
import { LANG_COOKIE, LANG_COOKIE_MAX_AGE } from "@/lib/i18n/language-switch";

export { SESSION_IDLE_MS, SESSION_ABSOLUTE_MS };
/** lastSeenAt is written at most this often (not on every request). */
const TOUCH_MS = 60 * 1000;

export type SessionMethod = "PIN" | "USERNAME_PIN" | "PASSWORD";
type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function createSession(employeeId: string, method: SessionMethod, mfa: boolean, request?: Request, db: Db = prisma, device?: { deviceId: string | null; ipHash: string | null; userAgent: string | null }) {
  const id = randomBytes(24).toString("base64url");
  const now = Date.now();
  // Own profile (Figma TD-11): the browser this session is opened from — the hq_device cookie it
  // already holds, or a new id the response sets (setSessionCookie). A session that replaces
  // another (a self credential change) inherits the replaced one's browser, address and agent.
  const deviceId = device ? device.deviceId : request ? (deviceIdFromCookieHeader(request.headers.get("cookie")) ?? newDeviceId()) : null;
  const ipHash = device ? device.ipHash : request ? hashRateLimitKey(extractIp(request)) : null;
  const userAgent = device ? device.userAgent : request?.headers.get("user-agent")?.slice(0, 300) ?? null;
  return db.authSession.create({
    // Owner decision 4: the secret this sign-in used (a step-up overwrites it with its own).
    data: { id, employeeId, method, mfa, authFactor: method === "PASSWORD" ? "PASSWORD" : "PIN", expiresAt: new Date(now + SESSION_ABSOLUTE_MS), ipHash, userAgent, deviceId },
  });
}

/**
 * The cookie for a session: the token names the row; it never outlives the absolute deadline.
 * It carries only the slim claims (./session-token.ts) — the permissions, name and role are read
 * from the database on every request, so the cookie stays a few hundred bytes for any account.
 */
export async function setSessionCookie(response: NextResponse, employeeId: string, session: { id: string; expiresAt: Date; deviceId?: string | null }) {
  // Loaded here, not at the top: the revocation helpers below are used by HR services that also
  // run outside the Next.js server (integration tests), where "server-only" cannot load.
  const { signToken } = await import("@/lib/auth");
  const e = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { id: true, preferredLanguage: true, username: true, pin: true, password: true } });
  const token = await signToken({ id: e.id, sid: session.id, cv: credentialVersion({ id: e.id, username: e.username, pin: e.pin, password: e.password }), preferredLanguage: e.preferredLanguage === "en" ? "en" : "ar" }, session.expiresAt);
  const maxAge = Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
  response.cookies.set("token", token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge, path: "/" });
  // The quick language switch: the sign-in screen after a sign-out speaks the account's saved
  // language (a display preference, never a credential — see lib/i18n/language-switch.ts).
  response.cookies.set(LANG_COOKIE, e.preferredLanguage === "en" ? "en" : "ar", { httpOnly: false, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: LANG_COOKIE_MAX_AGE, path: "/" });
  // The browser id outlives the session (it names the browser, not the sign-in); never a credential.
  if (validDeviceId(session.deviceId)) response.cookies.set(DEVICE_COOKIE, session.deviceId, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: DEVICE_COOKIE_MAX_AGE, path: "/" });
  return response;
}

export async function startSession(response: NextResponse, employeeId: string, method: SessionMethod, mfa: boolean, request?: Request) {
  const s = await createSession(employeeId, method, mfa, request);
  return setSessionCookie(response, employeeId, s);
}

export async function revokeSession(id: string, reason: string, db: Db = prisma) {
  await db.authSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason.slice(0, 120) } });
}

/** Revoke every live session of an account (optionally only one sign-in method, or all but one). */
export async function revokeSessions(db: Db, employeeId: string, reason: string, opts: { method?: SessionMethod; exceptId?: string } = {}) {
  const r = await db.authSession.updateMany({ where: { employeeId, revokedAt: null, ...(opts.method ? { method: opts.method } : {}), ...(opts.exceptId ? { id: { not: opts.exceptId } } : {}) }, data: { revokedAt: new Date(), revokedReason: reason.slice(0, 120) } });
  return r.count;
}

/** PIN | PASSWORD: the secret of the last strong authentication; null = not recorded (older session). */
export type AuthFactor = "PIN" | "PASSWORD";
export type LiveSession = { id: string; method: SessionMethod; mfa: boolean; authTime: Date; authFactor: AuthFactor | null; createdAt: Date; expiresAt: Date };

/**
 * The live session a token names, or null (missing, another account's, revoked, idle or past its
 * deadline — or of another scope). Workstations W2: only an ERP-scope session is an ERP session. A
 * STATION session (opened by a station PIN on a registered station device) is refused here, before
 * anything is touched, so a station token never authenticates an ERP API and an ERP request never
 * refreshes a station session's idle clock (getUserWithPermissions is the one caller).
 */
export async function checkSession(sid: string | undefined, employeeId: string): Promise<LiveSession | null> {
  if (!sid) return null;
  const s = await prisma.authSession.findUnique({ where: { id: sid } });
  if (!s || s.employeeId !== employeeId || s.revokedAt) return null;
  if (s.scope !== "ERP") return null;
  const now = Date.now();
  if (now >= s.expiresAt.getTime()) return null;
  if (now - s.lastSeenAt.getTime() > SESSION_IDLE_MS) {
    await revokeSession(s.id, "IDLE_TIMEOUT");
    return null;
  }
  if (now - s.lastSeenAt.getTime() > TOUCH_MS) await prisma.authSession.updateMany({ where: { id: s.id, revokedAt: null }, data: { lastSeenAt: new Date(now) } });
  const authFactor = s.authFactor === "PIN" || s.authFactor === "PASSWORD" ? s.authFactor : null;
  return { id: s.id, method: s.method as SessionMethod, mfa: s.mfa, authTime: s.authTime, authFactor, createdAt: s.createdAt, expiresAt: s.expiresAt };
}

export { STEP_UP_MS, freshEnough, REAUTH_AR, REAUTH_EN } from "./step-up";
