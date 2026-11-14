// P2 SEC-09: the sign-in throttle's pure rule (no database) — lib/auth/login-throttle.ts applies it.
export const THROTTLE = { delayAfter: 5, maxDelaySec: 30, lockAfter: 10, windowMin: 15, lockMin: 15, alertPerHour: 20, knownDeviceDays: 90 } as const;

/**
 * P2-B gate B3: the session revocations that withdraw a device's trust — an administrator ending its sessions
 * («إلغاء الثقة» and the other admin ends), the account's access/credentials reset by an administrator, and (gate R2)
 * the owner ending a session from «أجهزتي» (ENDED_BY_OWNER — a lost or stolen phone) and the HR-approved MFA reset
 * (MFA_RESET — it revokes every session because the second factor is no longer trusted). The user's plain sign-out,
 * the idle timeout, a self password change etc. leave the device trusted.
 */
export const DISTRUSTING_REVOCATIONS: ReadonlySet<string> = new Set([
  "SESSION_ENDED_ADMIN", "DEVICE_SESSIONS_ENDED_ADMIN", "SESSIONS_ENDED_ADMIN",
  "ACCESS_REVOKED", "PASSWORD_RESET_ADMIN", "PIN_RESET_ADMIN",
  "ENDED_BY_OWNER", "MFA_RESET",
]);

export type DeviceSession = { createdAt: Date; revokedAt: Date | null; revokedReason: string | null };

/**
 * Pure (gate B3): a device is KNOWN to an account when it signed in successfully within the last 90 days, in a session
 * that was not ended by an administrator, and after the latest such administrator revocation of that device. So
 * «إلغاء الثقة» takes the exemption away at once; the device earns it back only by signing in again.
 */
export function knownDeviceFrom(sessions: DeviceSession[], now: Date): boolean {
  const since = now.getTime() - THROTTLE.knownDeviceDays * 86_400_000;
  const distrusted = (s: DeviceSession) => !!s.revokedAt && !!s.revokedReason && DISTRUSTING_REVOCATIONS.has(s.revokedReason);
  const lastDistrust = Math.max(0, ...sessions.filter(distrusted).map((s) => s.revokedAt!.getTime()));
  return sessions.some((s) => !distrusted(s) && s.createdAt.getTime() >= since && s.createdAt.getTime() > lastDistrust);
}

/**
 * Pure (Abu Fahd note): the failures that drive the per-address delay — those AFTER this address's last successful
 * sign-in to the account. A success no longer deletes anything: the failures stay as evidence for the account lock, the
 * per-address limit and the hourly alert.
 */
export function failuresSince(failures: Date[], lastSuccess: Date | null): Date[] {
  return lastSuccess ? failures.filter((d) => d.getTime() > lastSuccess.getTime()) : failures;
}

export type ThrottleDecision = { ok: true } | { ok: false; kind: "WAIT" | "LOCKED"; retryAfterSec: number };

/** The wait owed after `n` failures of this address on this username (0 below the threshold): 2, 4, 8, 16, 30, 30 … */
export function delayFor(n: number): number {
  if (n < THROTTLE.delayAfter) return 0;
  return Math.min(THROTTLE.maxDelaySec, 2 ** (n - THROTTLE.delayAfter + 1));
}

/** Pure: the decision from the failure times (newest first) — testable without a database. */
export function decide(input: { pair: Date[]; account: Date[]; knownDevice: boolean; now: Date }): ThrottleDecision {
  const now = input.now.getTime();
  const windowMs = THROTTLE.windowMin * 60_000;
  const pair = input.pair.filter((d) => now - d.getTime() < windowMs);
  const account = input.account.filter((d) => now - d.getTime() < windowMs);
  if (!input.knownDevice && account.length >= THROTTLE.lockAfter) {
    // Locked from the failure that reached the threshold, for lockMin.
    const reached = account[THROTTLE.lockAfter - 1]; // the 10th most recent
    const until = reached.getTime() + THROTTLE.lockMin * 60_000;
    if (until > now) return { ok: false, kind: "LOCKED", retryAfterSec: Math.ceil((until - now) / 1000) };
  }
  const wait = delayFor(pair.length);
  if (wait > 0 && pair.length) {
    const ready = pair[0].getTime() + wait * 1000;
    if (ready > now) return { ok: false, kind: "WAIT", retryAfterSec: Math.ceil((ready - now) / 1000) };
  }
  return { ok: true };
}

