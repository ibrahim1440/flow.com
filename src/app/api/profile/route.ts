import { NextResponse } from "@/lib/api-response";
import { hash } from "bcryptjs";
import { verifySecret } from "@/lib/auth/sign-in";
import { prisma } from "@/lib/db";
import { requireAuth, requireFreshAuth, credentialVersion } from "@/lib/auth-server";
import { isEnrolled } from "@/lib/auth/mfa";
import { signToken, parsePermissions, buildDefaultPermissions } from "@/lib/auth";
import { handlePrismaError } from "@/lib/api-error";
import { extractIp, hashRateLimitKey, pruneExpired, isIpRateLimited, isPairRateLimited, recordFailedAttempt, clearAttempts } from "@/lib/rate-limit";
import { validatePin } from "@/lib/pin-policy";
import { pinLookup, pinVerifierInput, requirePinLookupSecret } from "@/lib/pin-lookup";
import { pinSetThrottle, pinUnavailable, isPinLookupConflict } from "@/lib/pin-set-guard";
import { refreshSessionCookie, setFreshSession } from "@/lib/session-cookie";

// GET — fetch current user's profile details (phone, language)
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;

  const employee = await prisma.employee.findUnique({
    where: { id: user.id },
    select: { phoneNumber: true, preferredLanguage: true },
  });
  if (!employee) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ phoneNumber: employee.phoneNumber ?? "", preferredLanguage: employee.preferredLanguage });
}

// PATCH — update phone number and/or language preference
export async function PATCH(request: Request) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await request.json();
    const { phoneNumber, preferredLanguage } = body;

    const update: Record<string, unknown> = {};
    if (phoneNumber !== undefined) update.phoneNumber = phoneNumber || null;
    if (preferredLanguage === "ar" || preferredLanguage === "en") {
      update.preferredLanguage = preferredLanguage;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const updated = await prisma.employee.update({
      where: { id: user.id },
      data: update,
      select: { id: true, name: true, role: true, permissions: true, preferredLanguage: true },
    });

    // Re-sign the CURRENT session's token so the language takes effect on the next page load
    // (same session row and deadlines; the token carries the language).
    const lang = (updated.preferredLanguage === "en" ? "en" : "ar") as "ar" | "en";
    const response = await refreshSessionCookie(NextResponse.json({ success: true, preferredLanguage: lang }), updated.id, user.sessionId);
    return response;
  } catch (err) {
    console.error("[PATCH /api/profile] error:", err);
    return handlePrismaError(err);
  }
}

// PUT — change PIN (requires current PIN verification)
export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  // Re-test AUTH-A: for a privileged or MFA-enrolled account, changing its own PIN needs a recent
  // step-up (username + secret + verification code) — the current PIN alone is not enough.
  if (user.privileged || (await isEnrolled(user.id))) {
    const stale = requireFreshAuth(user);
    if (stale) return stale;
  }

  const { currentPin, newPin } = await request.json();
  // UR-04 «إعادة تعيين رمز المحطة»: an administrator cleared the PIN, so there is no current one to
  // give. The person sets a new PIN after confirming their identity: a recent step-up made with the
  // PASSWORD (the cleared PIN cannot be the factor).
  const resetPending = (await prisma.employee.findUnique({ where: { id: user.id }, select: { pinResetRequired: true } }))?.pinResetRequired === true;
  if (resetPending) {
    const stale = requireFreshAuth(user);
    if (stale) return stale;
    if (user.authFactor !== "PASSWORD") return NextResponse.json({ error: "أكّد هويتك بكلمة المرور أولًا لتعيين رمز جديد.", errorEn: "Confirm your identity with your password first to set a new PIN.", code: "REAUTH_REQUIRED" }, { status: 401 });
  }
  if ((!currentPin && !resetPending) || !newPin) {
    return NextResponse.json({ error: "Current PIN and new PIN are required" }, { status: 400 });
  }
  // The shape the whole application now agrees on. currentPin is deliberately NOT
  // shape-checked: bcrypt decides whether it is the right credential, and refusing a
  // legacy-shaped PIN here would lock its owner out of ever changing it.
  const pinShape = validatePin(newPin);
  if (!pinShape.ok) {
    return NextResponse.json({ error: pinShape.message }, { status: 400 });
  }
  const nextPin = pinShape.pin;
  const secret = requirePinLookupSecret();
  const nextLookup = pinLookup(nextPin, secret);

  const ip = extractIp(request);
  const ipHash = hashRateLimitKey(ip);
  const identifierHash = hashRateLimitKey("profile-pin:" + user.id);
  await pruneExpired();
  if (await isIpRateLimited(ipHash, 10)) {
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }
  if (await isPairRateLimited(ipHash, identifierHash, 5)) {
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }

  const employee = await prisma.employee.findUnique({ where: { id: user.id } });
  if (!employee) return NextResponse.json({ error: "Employee not found" }, { status: 404 });

  // Verify the current PIN the same way login does: over pinVerifierInput, never the raw
  // PIN. currentPin is not shape-checked — bcrypt decides whether it is the right
  // credential — but it IS run through the verifier derivation, because the stored hash is
  // bcrypt(pinVerifierInput(pin)) and a raw-PIN compare would reject the owner's own PIN.
  if (!resetPending && !(await verifySecret(pinVerifierInput(String(currentPin), secret), employee.pin))) {
    await recordFailedAttempt(ipHash, identifierHash);
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  await clearAttempts(ipHash, identifierHash);

  // Review item 1: throttled like every PIN-setting path, one generic refusal, and the verifier
  // derived before the uniqueness lookup (same cost whether the PIN is taken or free).
  const limited = await pinSetThrottle(request, user.id);
  if (limited) return limited;
  const nextVerifier = await hash(pinVerifierInput(nextPin, secret), 10);
  const taken = await prisma.employee.findFirst({
    where: { pinLookup: nextLookup, id: { not: user.id } },
    select: { id: true },
  });
  if (taken) return pinUnavailable(request, user.id, user.id, "PROFILE");

  try {
    await prisma.employee.update({
      where: { id: user.id },
      // Version B writes the two live credential columns together:
      //   pin       bcrypt(pinVerifierInput(pin)) — the proof, over the keyed derivation and
      //             never the raw PIN, so a stolen row cannot be attacked offline
      //   pinLookup keyed HMAC selector — what login actually searches on
      // The legacy pinHash column is deliberately NOT written: it is inert under Version B
      // (read by nothing, written by nothing) and migration #19 removes it. Refreshing it
      // here would keep a precomputable selector alive alongside the keyed one.
      data: {
        pin: nextVerifier,
        pinLookup: nextLookup,
        pinResetRequired: false,
      },
    });
    await prisma.hrAuditLog.create({ data: { action: "PIN_CHANGED_SELF", entityType: "Employee", entityId: user.id, after: { route: "PROFILE", afterAdminReset: resetPending }, actorId: user.id } }).catch(() => undefined);
    // Review item 2: the new PIN changes the credential digest; the caller gets a fresh token
    // in this response instead of being signed out. AUTH-A: it is not a re-authentication —
    // authTime, MFA state and the absolute deadline are inherited.
    return await setFreshSession(NextResponse.json({ success: true }), user.id, user);
  } catch (err) {
    if (isPinLookupConflict(err)) return pinUnavailable(request, user.id, user.id, "PROFILE");
    return handlePrismaError(err);
  }
}
