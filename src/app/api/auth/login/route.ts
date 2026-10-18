import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  extractIp, hashRateLimitKey, pruneExpired, isIpRateLimited, isPairRateLimited, isIdentifierRateLimited,
  recordFailedAttempt, clearAttempts, recordPinFailure, clearPinAttempts,
  isPinSpaceConstrained, isIpQuietForPin, isIpPinRateLimited,
} from "@/lib/rate-limit";
import { validatePin } from "@/lib/pin-policy";
import { pinLookup, pinVerifierInput, requirePinLookupSecret } from "@/lib/pin-lookup";
import { isPrivilegedStored, normalizeUsername } from "@/lib/auth/privileged";
import { isEnrolled, mfaConfigured } from "@/lib/auth/mfa";
import { authAudit, completeSignIn, signChallenge, INVALID, MFA_UNAVAILABLE, TOO_MANY, verifySecret } from "@/lib/auth/sign-in";
import type { SessionMethod } from "@/lib/auth/session";

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
  return prisma.employee.findUnique({ where: { id: rows[0].id }, select: { id: true, role: true, permissions: true, active: true, pin: true, password: true } });
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
  const { method = "pin", pin, username, password } = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (method === "pin") {
    // One PIN shape, checked here exactly as on every path that SETS one: a malformed candidate
    // never reaches the lookup, the verifier or the rate-limit identifier.
    const shape = validatePin(pin);
    if (!shape.ok) return NextResponse.json({ error: shape.message }, { status: 400 });
    const candidate = shape.pin;
    const identifierHash = hashRateLimitKey("pin:" + candidate);
    await pruneExpired();
    // Throttles before any bcrypt work: per address, per (address, candidate), and — because the
    // candidate IS the identifier — a system-wide bucket against a distributed walk of the space.
    if (await isIpRateLimited(ipHash, 30)) return TOO_MANY();
    if (await isPairRateLimited(ipHash, identifierHash, 10)) return TOO_MANY();
    if ((await isPinSpaceConstrained()) && (!(await isIpQuietForPin(ipHash)) || (await isIpPinRateLimited(ipHash, 3)))) return TOO_MANY();
    const secret = requirePinLookupSecret();
    const byLookup = await prisma.employee.findFirst({ where: { pinLookup: pinLookup(candidate, secret), active: true }, select: { id: true, role: true, permissions: true, active: true, pin: true } });
    // Finding the row is not authenticating the person: bcrypt over pinVerifierInput decides.
    if (!byLookup || !(await verifySecret(pinVerifierInput(candidate, secret), byLookup.pin))) {
      await recordPinFailure(ipHash, identifierHash);
      return INVALID();
    }
    if (isPrivilegedStored(byLookup.permissions as string, byLookup.role)) {
      // Same answer and the same counting as a wrong PIN, so a PIN-only attempt learns nothing.
      await recordPinFailure(ipHash, identifierHash);
      await authAudit(request, { userId: byLookup.id, action: "PRIVILEGED_PIN_ONLY_REFUSED", result: "REFUSED", reasonCode: "USERNAME_REQUIRED" });
      return INVALID();
    }
    await clearPinAttempts(ipHash, identifierHash);
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
    if (await isPairRateLimited(ipHash, identifierHash, 10)) return TOO_MANY();
    if (await isIdentifierRateLimited(identifierHash, 20)) return TOO_MANY();
    const secret = requirePinLookupSecret();
    const found = (await byUsername(u)) as Found | null;
    const ok = await verifySecret(pinVerifierInput(shape.pin, secret), found?.pin);
    if (!found || !ok) {
      await recordFailedAttempt(ipHash, identifierHash);
      await authAudit(request, { userId: found?.id ?? null, action: "SIGN_IN", result: "FAILURE", reasonCode: "USERNAME_PIN", identifier: "login:" + u });
      return INVALID();
    }
    await clearAttempts(ipHash, identifierHash);
    return afterFirstFactor(request, found.id, "USERNAME_PIN");
  }

  if (method === "password") {
    const u = normalizeUsername(username);
    if (!u || typeof password !== "string" || !password) return NextResponse.json({ error: "Username and password required", errorAr: "اسم المستخدم وكلمة المرور مطلوبان." }, { status: 400 });
    const identifierHash = hashRateLimitKey("login:" + u);
    await pruneExpired();
    if (await isIpRateLimited(ipHash, 30)) return TOO_MANY();
    if (await isPairRateLimited(ipHash, identifierHash, 10)) return TOO_MANY();
    if (await isIdentifierRateLimited(identifierHash, 20)) return TOO_MANY();
    // Review item 3: the USERNAME only (unique, normal form). A display name never identifies a login.
    const found = await byUsername(u);
    const ok = await verifySecret(password, found?.password);
    if (!found || !found.password || !ok) {
      await recordFailedAttempt(ipHash, identifierHash);
      await authAudit(request, { userId: found?.id ?? null, action: "SIGN_IN", result: "FAILURE", reasonCode: "PASSWORD", identifier: "login:" + u });
      return INVALID();
    }
    await clearAttempts(ipHash, identifierHash);
    return afterFirstFactor(request, found.id, "PASSWORD");
  }

  return NextResponse.json({ error: "Invalid login method" }, { status: 400 });
}
