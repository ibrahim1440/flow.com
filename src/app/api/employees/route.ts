import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { hash } from "bcryptjs";
import { createHash } from "crypto";
import { requireSub, requireAuth } from "@/lib/auth-server";
import { recordEmployeeAudit } from "@/lib/services/employee-audit";
import { extractIp, hashRateLimitKey } from "@/lib/rate-limit";
import { handlePrismaError } from "@/lib/api-error";

/** Actor plus a hashed address — the same treatment login attempts already give one. */
function auditContext(request: Request, actorId: string) {
  return {
    actorId,
    ipHash: hashRateLimitKey(extractIp(request)),
    userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
  };
}

const SELECT_FULL = {
  id: true, name: true, username: true, role: true, permissions: true,
  defaultRoute: true, active: true, createdAt: true,
} as const;

const SELECT_ROSTER = {
  id: true, name: true, role: true, active: true,
} as const;

const ALLOWED_DEFAULT_ROUTES = new Set([
  "/dashboard",
  "/dashboard/inventory",
  "/dashboard/orders",
  "/dashboard/production",
  "/dashboard/qc",
  "/dashboard/packaging",
  "/dashboard/dispatch",
  "/dashboard/history",
  "/dashboard/analytics",
  "/dashboard/labels",
  "/dashboard/employees",
  "/dashboard/customers",
  "/dashboard/purchases",
  "/dashboard/settings",
  "/dashboard/profile",
]);

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
  const { user, error } = await requireAuth();
  if (error) return error;

  const isAdmin = user.role === "admin";
  const employees = await prisma.employee.findMany({
    orderBy: { createdAt: "desc" },
    select: isAdmin ? SELECT_FULL : SELECT_ROSTER,
  });
  return NextResponse.json(employees);
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("employees", "create");
  if (error) return error;

  const { name, username, pin, password, role, permissions, defaultRoute } = await request.json();

  if (!username) return NextResponse.json({ error: "Username is required" }, { status: 400 });
  if (!pin || pin.length < 4) return NextResponse.json({ error: "PIN must be at least 4 digits" }, { status: 400 });
  if (defaultRoute !== undefined && defaultRoute !== null && defaultRoute !== "") {
    if (!ALLOWED_DEFAULT_ROUTES.has(defaultRoute))
      return NextResponse.json({ error: "Invalid defaultRoute." }, { status: 400 });
  }

  if (await isPinTaken(pin)) {
    return NextResponse.json({ error: "This PIN is already assigned to another employee. Please choose a unique PIN." }, { status: 409 });
  }

  try {
    // Hashing is slow and has no business inside a transaction holding a connection open.
    const hashedPin = await hash(pin, 10);
    const hashedPassword = password ? await hash(password, 10) : null;

    // The account and the record of its creation commit together. An account that exists
    // with no record of who created it, or with what authority, is the gap this closes.
    const employee = await prisma.$transaction(async (tx) => {
      const created = await tx.employee.create({
        data: {
          name,
          username,
          pin: hashedPin,
          pinHash: sha256Pin(pin),
          role,
          permissions: typeof permissions === "string" ? permissions : JSON.stringify(permissions || {}),
          defaultRoute: defaultRoute || "/dashboard",
          ...(hashedPassword ? { password: hashedPassword } : {}),
        },
        select: SELECT_FULL,
      });

      // The credential the account was created WITH is never recorded — only that one
      // was set, and which kind.
      await recordEmployeeAudit(tx, auditContext(request, user.id), [{
        action: "EMPLOYEE_CREATED",
        targetEmployeeId: created.id,
        targetName: created.name,
        metadata: {
          role: created.role,
          active: created.active,
          credentials: [ "pin", ...(hashedPassword ? ["password"] : []) ],
        },
      }]);

      return created;
    }, TX_OPTS);

    return NextResponse.json(employee, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
