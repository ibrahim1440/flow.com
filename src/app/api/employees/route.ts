import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashSync } from "bcryptjs";
import { createHash } from "crypto";
import { requireSub, requireAuth } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

const SELECT_FULL = {
  id: true, name: true, username: true, role: true, permissions: true,
  defaultRoute: true, active: true, createdAt: true,
} as const;

function sha256Pin(pin: string): string {
  return createHash("sha256").update(pin).digest("hex");
}

/** O(1) DB-level PIN uniqueness check via deterministic SHA-256 hash. */
async function isPinTaken(plainPin: string, excludeId?: string): Promise<boolean> {
  const existing = await prisma.employee.findFirst({
    where: {
      pinHash: sha256Pin(plainPin),
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  return existing !== null;
}

export async function GET() {
  const { error } = await requireAuth();
  if (error) return error;

  const employees = await prisma.employee.findMany({
    orderBy: { createdAt: "desc" },
    select: SELECT_FULL,
  });
  return NextResponse.json(employees);
}

export async function POST(request: Request) {
  const { error } = await requireSub("employees", "create");
  if (error) return error;

  const { name, username, pin, password, role, permissions, defaultRoute } = await request.json();

  if (!username) return NextResponse.json({ error: "Username is required" }, { status: 400 });
  if (!pin || pin.length < 4) return NextResponse.json({ error: "PIN must be at least 4 digits" }, { status: 400 });

  if (await isPinTaken(pin)) {
    return NextResponse.json({ error: "This PIN is already assigned to another employee. Please choose a unique PIN." }, { status: 409 });
  }

  try {
    const employee = await prisma.employee.create({
      data: {
        name,
        username,
        pin: hashSync(pin, 10),
        pinHash: sha256Pin(pin),
        role,
        permissions: typeof permissions === "string" ? permissions : JSON.stringify(permissions || {}),
        defaultRoute: defaultRoute || "/dashboard",
        ...(password ? { password: hashSync(password, 10) } : {}),
      },
      select: SELECT_FULL,
    });
    return NextResponse.json(employee, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
