import { NextResponse } from "next/server";
import { compareSync, hashSync } from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { signToken, parsePermissions, buildDefaultPermissions } from "@/lib/auth";

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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
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
  if (newPin.length < 4 || newPin.length > 8 || !/^\d+$/.test(newPin)) {
    return NextResponse.json({ error: "PIN must be 4–8 digits" }, { status: 400 });
  }

  const employee = await prisma.employee.findUnique({ where: { id: user.id } });
  if (!employee) return NextResponse.json({ error: "Employee not found" }, { status: 404 });

  // Verify current PIN
  if (!compareSync(currentPin, employee.pin)) {
    return NextResponse.json({ error: "Current PIN is incorrect" }, { status: 401 });
  }

  // Ensure new PIN isn't already assigned to someone else
  const all = await prisma.employee.findMany({
    where: { id: { not: user.id }, active: true },
    select: { pin: true },
  });
  const taken = all.some((e) => compareSync(newPin, e.pin));
  if (taken) {
    return NextResponse.json({ error: "This PIN is already in use by another employee" }, { status: 409 });
  }

  await prisma.employee.update({
    where: { id: user.id },
    data: { pin: hashSync(newPin, 10) },
  });

  return NextResponse.json({ success: true });
}
