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

async function isPinTaken(plainPin: string, excludeId: string): Promise<boolean> {
  const existing = await prisma.employee.findFirst({
    where: { pinHash: sha256Pin(plainPin), id: { not: excludeId } },
    select: { id: true },
  });
  return existing !== null;
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireSub("employees", "edit");
  if (error) return error;

  const { id } = await params;
  const { name, username, role, permissions, pin, password, defaultRoute, active } = await request.json();

  if (pin) {
    if (pin.length < 4) return NextResponse.json({ error: "PIN must be at least 4 digits" }, { status: 400 });
    if (await isPinTaken(pin, id)) {
      return NextResponse.json({ error: "This PIN is already assigned to another employee. Please choose a unique PIN." }, { status: 409 });
    }
  }

  const data: Record<string, unknown> = { name, role };
  if (username !== undefined) data.username = username;
  data.permissions = typeof permissions === "string" ? permissions : JSON.stringify(permissions || {});
  if (defaultRoute !== undefined) data.defaultRoute = defaultRoute;
  if (pin) { data.pin = hashSync(pin, 10); data.pinHash = sha256Pin(pin); }
  if (password) data.password = hashSync(password, 10);
  if (active !== undefined) data.active = active;

  try {
    const employee = await prisma.employee.update({ where: { id }, data, select: SELECT_FULL });
    return NextResponse.json(employee);
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Only admins can delete employees" }, { status: 403 });
  }

  const { id } = await params;

  try {
    await prisma.employee.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "P2003" || code === "P2014") {
      return NextResponse.json(
        { error: "Cannot delete this employee because they have linked operational records. Please deactivate their account instead." },
        { status: 400 }
      );
    }
    throw err;
  }
}
