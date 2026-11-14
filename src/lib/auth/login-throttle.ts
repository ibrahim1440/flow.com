// P2 SEC-09 (owner decision 5; numbers approved 13 Nov, ب8): a wrong password or PIN typed by someone else must never be
// enough to keep the real owner out. Before this, 20 failures under one username from anywhere locked the account for
// 15 minutes — the right password included — so anyone who knew a rep's username could lock them out.
//
//   · progressive delay, per (address + username): after 5 failures in the window each attempt waits 2 s, 4 s, 8 s …
//     up to 30 s after the previous failure — the password is not even checked before the wait is over;
//   · temporary lock, per username: 10 failures within 15 minutes (from any address) lock it for 15 minutes — EXCEPT on a
//     known device: a browser (hq_device) the account has already signed in from successfully. A guesser cannot hold
//     that device, so the owner keeps signing in from their own phone during an attack;
//   · alerts: the lock, and more than 20 failures within an hour, notify the user administrators (employees › edit) and
//     are audited;
//   · «فتح القفل»: the administrator's existing unlock (POST /api/users/[id]/credentials, action unlock) — audited.
//
// No new table: the failures are the existing LoginAttempt rows (pruned after an hour), the known devices the existing
// AuthSession.deviceId of the account.
import { prisma } from "@/lib/db";
import { hashRateLimitKey, PIN_GLOBAL } from "@/lib/rate-limit";
import { decide, failuresSince, knownDeviceFrom, THROTTLE, type ThrottleDecision } from "./login-throttle-rules";

export { decide, delayFor, failuresSince, knownDeviceFrom, DISTRUSTING_REVOCATIONS, THROTTLE, type ThrottleDecision } from "./login-throttle-rules";

/** The login identifier of a username (the same hash the login route counts under). */
export const loginIdentifier = (normalizedUsername: string) => hashRateLimitKey("login:" + normalizedUsername);

/**
 * Whether this browser (a SIGNED hq_device — lib/auth/device.ts) is a known device of the account: a successful sign-in
 * within 90 days, not ended by an administrator, and after the latest administrator revocation of the device (gate B3).
 */
export async function isKnownDevice(employeeId: string | null | undefined, deviceId: string | null | undefined, now: Date = new Date()): Promise<boolean> {
  if (!employeeId || !deviceId) return false;
  const sessions = await prisma.authSession.findMany({ where: { employeeId, deviceId }, select: { createdAt: true, revokedAt: true, revokedReason: true }, orderBy: { createdAt: "desc" }, take: 200 });
  return knownDeviceFrom(sessions, now);
}

export async function loginThrottle(input: { ipHash: string; identifierHash: string; employeeId: string | null; deviceId: string | null; now?: Date }): Promise<ThrottleDecision> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - THROTTLE.windowMin * 60_000);
  const [pair, account, knownDevice, lastSuccess] = await Promise.all([
    prisma.loginAttempt.findMany({ where: { ipHash: input.ipHash, identifierHash: input.identifierHash, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, select: { createdAt: true }, take: 50 }),
    prisma.loginAttempt.findMany({ where: { identifierHash: input.identifierHash, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, select: { createdAt: true }, take: 50 }),
    isKnownDevice(input.employeeId, input.deviceId, now),
    // The last successful sign-in of this account from this address: the delay counts only the failures after it.
    input.employeeId ? prisma.authSession.findFirst({ where: { employeeId: input.employeeId, ipHash: input.ipHash, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }) : null,
  ]);
  return decide({ pair: failuresSince(pair.map((r) => r.createdAt), lastSuccess?.createdAt ?? null), account: account.map((r) => r.createdAt), knownDevice, now });
}

/**
 * P2-B gate R2 — PIN-only sign-in (flag-gated, off in production) under the same SEC-09 rules. A wrong PIN identifies
 * no account (the candidate IS the identifier), so:
 *   · the progressive delay is per ADDRESS, over its PIN failures (the PIN_GLOBAL marker rows, one per failure, any
 *     candidate) since this address's last PIN sign-in — checked before the PIN lookup or any bcrypt work;
 *   · the account lock applies once the PIN has proved WHICH account (a correct PIN): the account's failures under its
 *     username (from any method) lock it, except on its known device — so the answer reveals nothing a correct PIN
 *     did not already prove;
 *   · a success clears nothing (the failures stay as evidence, as on the other two methods).
 */
export async function pinOnlyDelay(ipHash: string, now: Date = new Date()): Promise<ThrottleDecision> {
  const since = new Date(now.getTime() - THROTTLE.windowMin * 60_000);
  const [failures, lastSuccess] = await Promise.all([
    prisma.loginAttempt.findMany({ where: { ipHash, identifierHash: PIN_GLOBAL, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, select: { createdAt: true }, take: 50 }),
    prisma.authSession.findFirst({ where: { ipHash, method: "PIN", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  return decide({ pair: failuresSince(failures.map((r) => r.createdAt), lastSuccess?.createdAt ?? null), account: [], knownDevice: false, now });
}

/** PIN-only, after a correct PIN: the account's lock (its username's failures in the window), unless a known device. */
export async function pinOnlyAccountLock(input: { employeeId: string; normalizedUsername: string | null; deviceId: string | null; now?: Date }): Promise<ThrottleDecision> {
  if (!input.normalizedUsername) return { ok: true }; // an account without a username has no failures to count
  const now = input.now ?? new Date();
  const [account, knownDevice] = await Promise.all([
    prisma.loginAttempt.findMany({ where: { identifierHash: loginIdentifier(input.normalizedUsername), createdAt: { gte: new Date(now.getTime() - THROTTLE.windowMin * 60_000) } }, orderBy: { createdAt: "desc" }, select: { createdAt: true }, take: 50 }),
    isKnownDevice(input.employeeId, input.deviceId, now),
  ]);
  return decide({ pair: [], account: account.map((r) => r.createdAt), knownDevice, now });
}

/** After a recorded failure: the lock and the hourly threshold, each raised once (audited + the administrators told). */
export async function afterLoginFailure(input: { identifierHash: string; employeeId: string | null; username: string; request: Request; now?: Date }): Promise<void> {
  if (!input.employeeId) return; // no account: nothing to lock, nobody to warn about
  const now = input.now ?? new Date();
  const [inWindow, inHour] = await Promise.all([
    prisma.loginAttempt.count({ where: { identifierHash: input.identifierHash, createdAt: { gte: new Date(now.getTime() - THROTTLE.windowMin * 60_000) } } }),
    prisma.loginAttempt.count({ where: { identifierHash: input.identifierHash, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } }),
  ]);
  const { authAudit } = await import("@/lib/auth/sign-in");
  const { notify } = await import("@/lib/notifications/notify");
  const hour = now.toISOString().slice(0, 13);
  if (inWindow === THROTTLE.lockAfter) {
    await authAudit(input.request, { userId: input.employeeId, action: "ACCOUNT_LOCKED", result: "REFUSED", reasonCode: "TOO_MANY_FAILURES", identifier: "login:" + input.username });
    await notify(prisma, { event: "security.login_locked", dedupeKey: `${input.employeeId}:${now.toISOString().slice(0, 16)}`, facts: { employeeId: input.employeeId, username: input.username, kind: "LOCKED", minutes: THROTTLE.lockMin }, entity: { type: "Employee", id: input.employeeId } }).catch(() => undefined);
  }
  if (inHour === THROTTLE.alertPerHour + 1) {
    await authAudit(input.request, { userId: input.employeeId, action: "LOGIN_SUSPICIOUS", result: "REFUSED", reasonCode: "FAILURES_PER_HOUR", identifier: "login:" + input.username });
    await notify(prisma, { event: "security.login_locked", dedupeKey: `${input.employeeId}:hour:${hour}`, facts: { employeeId: input.employeeId, username: input.username, kind: "SUSPICIOUS", count: inHour }, entity: { type: "Employee", id: input.employeeId } }).catch(() => undefined);
  }
}

/** The lock state an administrator sees on the user page. */
export async function lockStatus(normalizedUsername: string, now = new Date()) {
  const identifierHash = loginIdentifier(normalizedUsername);
  const [account, lastHour] = await Promise.all([
    prisma.loginAttempt.findMany({ where: { identifierHash, createdAt: { gte: new Date(now.getTime() - THROTTLE.windowMin * 60_000) } }, orderBy: { createdAt: "desc" }, select: { createdAt: true }, take: 50 }),
    prisma.loginAttempt.count({ where: { identifierHash, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } }),
  ]);
  const d = decide({ pair: [], account: account.map((r) => r.createdAt), knownDevice: false, now });
  return {
    locked: !d.ok && d.kind === "LOCKED",
    lockedUntil: !d.ok && d.kind === "LOCKED" ? new Date(now.getTime() + d.retryAfterSec * 1000).toISOString() : null,
    failuresWindow: account.length,
    failuresLastHour: lastHour,
    suspicious: lastHour > THROTTLE.alertPerHour,
  };
}
