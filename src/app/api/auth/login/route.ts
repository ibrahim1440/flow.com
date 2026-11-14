import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import {
  extractIp, hashRateLimitKey, pruneExpired, isIpRateLimited, isPairRateLimited,
  recordFailedAttempt, recordPinFailure,
  isPinSpaceConstrained, isIpQuietForPin, isIpPinRateLimited,
} from "@/lib/rate-limit";
import { validatePin } from "@/lib/pin-policy";
import { pinLookup, pinVerifierInput, requirePinLookupSecret } from "@/lib/pin-lookup";
import { isPrivilegedStored, normalizeUsername } from "@/lib/auth/privileged";
import { isEnrolled, mfaConfigured } from "@/lib/auth/mfa";
import { authAudit, completeSignIn, signChallenge, INVALID, MFA_UNAVAILABLE, TOO_MANY, verifySecret } from "@/lib/auth/sign-in";
import type { SessionMethod } from "@/lib/auth/session";
import { pinLoginEnabled } from "@/lib/auth/pin-login";
import { afterLoginFailure, loginThrottle, pinOnlyAccountLock, pinOnlyDelay } from "@/lib/auth/login-throttle";
import { deviceIdFromCookieHeader } from "@/lib/auth/device";
import { arCount, AR_MINUTES, AR_SECONDS } from "@/lib/i18n/ar-count";

// W0 (security, Phase D batch; tightened by Workstations W0, owner decision D4): only "password" is
// open by default, and it is the default when `method` is omitted. "pin" and "username_pin" answer
// the SAME generic 401 a wrong credential gets — no code, nothing that says PIN sign-in exists or is
// switched off — unless the server sets AUTH_PIN_LOGIN_ENABLED (src/lib/auth/pin-login.ts). Their
// code below is unchanged, so a deployment that turns the flag on gets exactly the behaviour
// described next (the local test servers do; production does not).
//
// Owner security decision (16 Oct, Option A). Three ways in:
//   · "pin"           — a PIN alone, for OPERATIONAL accounts only. A PIN that resolves to a
//                       PRIVILEGED account (src/lib/auth/privileged.ts) is refused with exactly the
//                       answer a wrong PIN gets, counted as a PIN failure, and audited
//                       (PRIVILEGED_PIN_ONLY_REFUSED). There is no fallback.
//   · "username_pin"  — username + PIN: the strong method for privileged accounts.
//   · "password"      — username + password (equal or stronger). The username only: a display
//                       name never identifies a login.
// After the first factor, an account with MFA enrolled gets a 5-minute challenge and no session
// until POST /api/auth/mfa/login proves the second. Otherwise a server-side session opens.
//
// There is deliberately no pinHash helper and no raw-PIN bcrypt here: the credential is proved
// by bcrypt over pinVerifierInput(pin), and the legacy pinHash column is inert.

type Found = { id: string; role: string; permissions: string; active: boolean; pin: string };

/** One account by its username in normal form (the database index uses the same form). */
async function byUsername(username: string) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Employee" WHERE auth_norm_username("username") = auth_norm_username(${username}) AND active = true LIMIT 1`;
  if (!rows.length) return null;
  return prisma.employee.findUnique({ where: { id: rows[0].id }, select: { id: true, role: true, permissions: true, active: true, pin: true, password: true, passwordMustChange: true, passwordTempExpiresAt: true } });
}



/**
 * P2 SEC-09: the answer while an attempt must wait or the username is locked — the same for an existing and a missing
 * account (nothing to learn), with when to try again. The password / PIN was not checked.
 */
function throttled(g: { kind: "WAIT" | "LOCKED"; retryAfterSec: number }) {
  const ar = g.kind === "LOCKED"
    ? `محاولات دخول غلط كثيرة على هالحساب — انقفل مؤقتًا. جرّب بعد ${arCount(Math.ceil(g.retryAfterSec / 60), AR_MINUTES)}، أو اطلب من مسؤول النظام يفتح القفل.`
    : `انتظر ${arCount(g.retryAfterSec, AR_SECONDS)} وجرّب مرة ثانية.`;
  const en = g.kind === "LOCKED"
    ? `Too many wrong sign-ins on this account — it is locked for now. Try again in ${Math.ceil(g.retryAfterSec / 60)} minutes, or ask an administrator to unlock it.`
    : `Wait ${g.retryAfterSec} seconds and try again.`;
  const res = NextResponse.json({ error: en, errorAr: ar, errorEn: en, code: g.kind === "LOCKED" ? "LOGIN_LOCKED" : "LOGIN_WAIT", retryAfterSec: g.retryAfterSec }, { status: 429 });
  res.headers.set("Retry-After", String(g.retryAfterSec));
  return res;
}

async function afterFirstFactor(request: Request, employeeId: string, method: SessionMethod) {
  if (await isEnrolled(employeeId)) {
    if (!mfaConfigured()) {
      await authAudit(request, { userId: employeeId, action: "SIGN_IN", result: "REFUSED", reasonCode: "MFA_NOT_CONFIGURED" });
      return MFA_UNAVAILABLE();
    }
    await authAudit(request, { userId: employeeId, action: "SIGN_IN_FIRST_FACTOR", result: "SUCCESS", reasonCode: method });
    return NextResponse.json({ mfaRequired: true, challenge: await signChallenge(employeeId, method, "login") });
  }
  return completeSignIn(request, employeeId, method, false);
}

export async function POST(request: Request) {
  const ip = extractIp(request);
  const ipHash = hashRateLimitKey(ip);
  const { method = "password", pin, username, password } = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  // Before any lookup, verifier or rate-limit bucket: a refused method learns nothing and costs nothing.
  if ((method === "pin" || method === "username_pin") && !pinLoginEnabled()) {
    return INVALID();
  }

  if (method === "pin") {
    // One PIN shape, checked here exactly as on every path that SETS one: a malformed candidate
    // never reaches the lookup, the verifier or the rate-limit identifier.
    const shape = validatePin(pin);
    if (!shape.ok) return NextResponse.json({ error: shape.message }, { status: 400 });
    const candidate = shape.pin;
    const identifierHash = hashRateLimitKey("pin:" + candidate);
    await pruneExpired();
    // P2-B gate R2: the SEC-09 progressive delay, per address (lib/auth/login-throttle.ts pinOnlyDelay) — first.
    const wait = await pinOnlyDelay(ipHash);
    if (!wait.ok) return throttled(wait);
    // Throttles before any bcrypt work: per address, per (address, candidate), and — because the
    // candidate IS the identifier — a system-wide bucket against a distributed walk of the space.
    if (await isIpRateLimited(ipHash, 30)) return TOO_MANY();
    if (await isPairRateLimited(ipHash, identifierHash, 10)) return TOO_MANY();
    if ((await isPinSpaceConstrained()) && (!(await isIpQuietForPin(ipHash)) || (await isIpPinRateLimited(ipHash, 3)))) return TOO_MANY();
    const secret = requirePinLookupSecret();
    const byLookup = await prisma.employee.findFirst({ where: { pinLookup: pinLookup(candidate, secret), active: true }, select: { id: true, role: true, permissions: true, active: true, pin: true, username: true } });
    // Finding the row is not authenticating the person: bcrypt over pinVerifierInput decides.
    if (!byLookup || !(await verifySecret(pinVerifierInput(candidate, secret), byLookup.pin))) {
      await recordPinFailure(ipHash, identifierHash);
      return INVALID();
    }
    const accountUsername = normalizeUsername(byLookup.username);
    if (isPrivilegedStored(byLookup.permissions as string, byLookup.role)) {
      // Same answer and the same counting as a wrong PIN, so a PIN-only attempt learns nothing.
      await recordPinFailure(ipHash, identifierHash);
      // Gate R2: the PIN proved the account, so the refusal is also evidence against it (the lock and the alerts).
      if (accountUsername) {
        await recordFailedAttempt(ipHash, hashRateLimitKey("login:" + accountUsername));
        await afterLoginFailure({ identifierHash: hashRateLimitKey("login:" + accountUsername), employeeId: byLookup.id, username: accountUsername, request });
      }
      await authAudit(request, { userId: byLookup.id, action: "PRIVILEGED_PIN_ONLY_REFUSED", result: "REFUSED", reasonCode: "USERNAME_REQUIRED" });
      return INVALID();
    }
    // Gate R2: the account lock (SEC-09) — the PIN has proved which account; its known device stays exempt.
    const lock = await pinOnlyAccountLock({ employeeId: byLookup.id, normalizedUsername: accountUsername, deviceId: deviceIdFromCookieHeader(request.headers.get("cookie")) });
    if (!lock.ok) {
      await authAudit(request, { userId: byLookup.id, action: "SIGN_IN", result: "REFUSED", reasonCode: "ACCOUNT_LOCKED" });
      return throttled(lock);
    }
    // Gate R2: a success no longer clears the PIN failures (evidence kept, as on the other methods); the per-address
    // delay restarts from this sign-in (pinOnlyDelay counts only the failures after it).
    return afterFirstFactor(request, byLookup.id, "PIN");
  }

  if (method === "username_pin") {
    const u = normalizeUsername(username);
    const shape = validatePin(pin);
    if (!u || !shape.ok) return NextResponse.json({ error: "Username and PIN required", errorAr: "اسم المستخدم والرمز مطلوبان." }, { status: 400 });
    // Re-test AUTH-F: one budget per username, shared by username + PIN and username + password.
    const identifierHash = hashRateLimitKey("login:" + u);
    await pruneExpired();
    if (await isIpRateLimited(ipHash, 30)) return TOO_MANY();
    const secret = requirePinLookupSecret();
    const found = (await byUsername(u)) as Found | null;
    // P2 SEC-09: the progressive delay and the temporary lock (lib/auth/login-throttle.ts) — before the PIN is checked.
    const gate = await loginThrottle({ ipHash, identifierHash, employeeId: found?.id ?? null, deviceId: deviceIdFromCookieHeader(request.headers.get("cookie")) });
    if (!gate.ok) return throttled(gate);
    const ok = await verifySecret(pinVerifierInput(shape.pin, secret), found?.pin);
    if (!found || !ok) {
      await recordFailedAttempt(ipHash, identifierHash);
      await afterLoginFailure({ identifierHash, employeeId: found?.id ?? null, username: u, request });
      await authAudit(request, { userId: found?.id ?? null, action: "SIGN_IN", result: "FAILURE", reasonCode: "USERNAME_PIN", identifier: "login:" + u });
      return INVALID();
    }
    // P2-B gate (Abu Fahd): a success no longer DELETES the failures — they stay as evidence for the account lock, the
    // per-address limit and the hourly alert (each already audited). The per-address delay starts again from this
    // sign-in instead (lib/auth/login-throttle.ts counts only the failures after this address's last success).
    return afterFirstFactor(request, found.id, "USERNAME_PIN");
  }

  if (method === "password") {
    const u = normalizeUsername(username);
    if (!u || typeof password !== "string" || !password) return NextResponse.json({ error: "Username and password required", errorAr: "اسم المستخدم وكلمة المرور مطلوبان." }, { status: 400 });
    const identifierHash = hashRateLimitKey("login:" + u);
    await pruneExpired();
    if (await isIpRateLimited(ipHash, 30)) return TOO_MANY();
    // Review item 3: the USERNAME only (unique, normal form). A display name never identifies a login.
    const found = await byUsername(u);
    // P2 SEC-09: the progressive delay and the temporary lock (lib/auth/login-throttle.ts) — before the password is checked.
    const gate = await loginThrottle({ ipHash, identifierHash, employeeId: found?.id ?? null, deviceId: deviceIdFromCookieHeader(request.headers.get("cookie")) });
    if (!gate.ok) return throttled(gate);
    const ok = await verifySecret(password, found?.password);
    if (!found || !found.password || !ok) {
      await recordFailedAttempt(ipHash, identifierHash);
      await afterLoginFailure({ identifierHash, employeeId: found?.id ?? null, username: u, request });
      await authAudit(request, { userId: found?.id ?? null, action: "SIGN_IN", result: "FAILURE", reasonCode: "PASSWORD", identifier: "login:" + u });
      return INVALID();
    }
    // A temporary password issued by an administrator (UR-03e / UR-04) works only until its expiry
    // («تنتهي صلاحيتها بعد 72 ساعة إن لم تُستخدم»); after that the administrator issues a new one.
    if (found.passwordMustChange && found.passwordTempExpiresAt && found.passwordTempExpiresAt.getTime() <= Date.now()) {
      await authAudit(request, { userId: found.id, action: "SIGN_IN", result: "REFUSED", reasonCode: "TEMP_PASSWORD_EXPIRED", identifier: "login:" + u });
      return NextResponse.json({ error: "Invalid credentials", errorAr: "انتهت صلاحية كلمة المرور المؤقتة. اطلب من مسؤول النظام كلمة جديدة.", code: "TEMP_PASSWORD_EXPIRED" }, { status: 401 });
    }
    // P2-B gate (Abu Fahd): the failures are kept as evidence (see the username + PIN branch above).
    return afterFirstFactor(request, found.id, "PASSWORD");
  }

  return NextResponse.json({ error: "Invalid login method" }, { status: 400 });
}
