import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashSync, compareSync } from "bcryptjs";
import { requireSub, requireAuth } from "@/lib/auth-server";

const SELECT_FULL = {
  id: true, name: true, username: true, role: true, permissions: true,
  defaultRoute: true, active: true, createdAt: true,
} as const;

/** Check if any OTHER employee already uses this plaintext PIN. */
async function isPinTaken(plainPin: string, excludeId?: string): Promise<boolean> {
  const all = await prisma.employee.findMany({
    where: excludeId ? { id: { not: excludeId } } : undefined,
    select: { pin: true },
  });
  return all.some((e) => compareSync(plainPin, e.pin));
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

  const employee = await prisma.employee.create({
    data: {
      name,
      username,
      pin: hashSync(pin, 10),
      role,
      permissions: typeof permissions === "string" ? permissions : JSON.stringify(permissions || {}),
      defaultRoute: defaultRoute || "/dashboard",
      ...(password ? { password: hashSync(password, 10) } : {}),
    },
    select: SELECT_FULL,
  });
  return NextResponse.json(employee, { status: 201 });
}
