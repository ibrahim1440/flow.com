import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { compareSync } from "bcryptjs";
import { signToken, parsePermissions, buildDefaultPermissions, hasModuleAccess, ALL_MODULES } from "@/lib/auth";

const ROUTE_MODULE_MAP: Record<string, string> = {
  "/dashboard": "dashboard",
  "/dashboard/inventory": "inventory",
  "/dashboard/orders": "orders",
  "/dashboard/production": "production",
  "/dashboard/qc": "qc",
  "/dashboard/packaging": "packaging",
  "/dashboard/dispatch": "dispatch",
  "/dashboard/history": "history",
  "/dashboard/analytics": "analytics",
  "/dashboard/labels": "labels",
  "/dashboard/employees": "employees",
};

function resolveRoute(defaultRoute: string, permissions: ReturnType<typeof parsePermissions>): string {
  const mod = ROUTE_MODULE_MAP[defaultRoute];
  if (!mod || mod === "dashboard") return "/dashboard";
  if (hasModuleAccess(permissions, mod)) return defaultRoute;
  for (const m of ALL_MODULES) {
    if (m !== "dashboard" && hasModuleAccess(permissions, m)) return `/dashboard/${m}`;
  }
  return "/dashboard";
}

export async function POST(request: Request) {
  const { method = "pin", pin, username, password } = await request.json();

  let employee: Awaited<ReturnType<typeof prisma.employee.findFirst>> = null;

  if (method === "pin") {
    if (!pin) {
      return NextResponse.json({ error: "PIN required" }, { status: 400 });
    }
    // Scan all active employees and bcrypt-compare — O(n) but fine for a small team
    const all = await prisma.employee.findMany({ where: { active: true } });
    employee = all.find((e) => compareSync(pin, e.pin)) ?? null;

  } else if (method === "password") {
    if (!username || !password) {
      return NextResponse.json({ error: "Username and password required" }, { status: 400 });
    }
    employee = await prisma.employee.findFirst({
      where: { active: true, OR: [{ username }, { name: username }] },
    });
    if (!employee || !employee.password || !compareSync(password, employee.password)) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }
  } else {
    return NextResponse.json({ error: "Invalid login method" }, { status: 400 });
  }

  if (!employee) {
    return NextResponse.json({ error: "Invalid PIN" }, { status: 401 });
  }

  let permissions = parsePermissions(employee.permissions as string);
  if (!permissions || Object.keys(permissions).length === 0) {
    permissions = buildDefaultPermissions(employee.role);
  }

  const token = await signToken({
    id: employee.id,
    name: employee.name,
    role: employee.role,
    permissions,
    preferredLanguage: (employee.preferredLanguage as "ar" | "en") ?? "ar",
  });

  const redirectTo = resolveRoute(employee.defaultRoute || "/dashboard", permissions);

  const response = NextResponse.json({
    user: { id: employee.id, name: employee.name, role: employee.role, permissions },
    redirectTo,
  });

  response.cookies.set("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 8,
    path: "/",
  });

  return response;
}
