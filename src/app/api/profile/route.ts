import { NextResponse } from "next/server";
import { compare, hash } from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { signToken, parsePermissions, buildDefaultPermissions } from "@/lib/auth";
import { handlePrismaError } from "@/lib/api-error";
import { extractIp, hashRateLimitKey, pruneExpired, isIpRateLimited, isPairRateLimited, recordFailedAttempt, clearAttempts } from "@/lib/rate-limit";
import { validatePin } from "@/lib/pin-policy";
import { pinLookup, pinVerifierInput, requirePinLookupSecret } from "@/lib/pin-lookup";

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

    // Re-issue JWT so language preference takes effect on next page load
    const rawPerms = parsePermissions(updated.permissions as string);
    const permissions = rawPerms && Object.keys(rawPerms).length > 0
      ? rawPerms
      : buildDefaultPermissions(updated.role);

    const lang = (updated.preferredLanguage === "en" ? "en" : "ar") as "ar" | "en";

    const token = await signToken({
      id: updated.id,
      name: updated.name,
      role: updated.role,
      permissions,
      preferredLanguage: lang,
    });

    const response = NextResponse.json({ success: true, preferredLanguage: lang });
    response.cookies.set("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 8,
      path: "/",
    });
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

  const { currentPin, newPin } = await request.json();
  if (!currentPin || !newPin) {
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
  if (!(await compare(pinVerifierInput(String(currentPin), secret), employee.pin))) {
    await recordFailedAttempt(ipHash, identifierHash);
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  await clearAttempts(ipHash, identifierHash);

  const taken = await prisma.employee.findFirst({
    where: { pinLookup: nextLookup, id: { not: user.id } },
    select: { id: true },
  });
  if (taken) {
    return NextResponse.json({ error: "This PIN is already in use by another employee" }, { status: 409 });
  }

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
        pin: await hash(pinVerifierInput(nextPin, secret), 10),
        pinLookup: nextLookup,
      },
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
