import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { compare } from "bcryptjs";
import { createHash } from "crypto";
import { signToken, parsePermissions, buildDefaultPermissions, hasModuleAccess, ALL_MODULES } from "@/lib/auth";
import { extractIp, hashRateLimitKey, pruneExpired, isIpRateLimited, isPairRateLimited, recordFailedAttempt, clearAttempts } from "@/lib/rate-limit";

const sha256Pin = (p: string) => createHash("sha256").update(p).digest("hex");

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
  const ip = extractIp(request);
  const { method = "pin", pin, username, password } = await request.json();

  type LoginEmployee = { id: string; name: string; role: string; permissions: string; defaultRoute: string | null; active: boolean; preferredLanguage: string };
  let employee: LoginEmployee | null = null;

  if (method === "pin") {
    if (!pin) {
      return NextResponse.json({ error: "PIN required" }, { status: 400 });
    }
    const ipHash = hashRateLimitKey(ip);
    const identifierHash = hashRateLimitKey("pin:" + String(pin).trim());
    await pruneExpired();
    if (await isIpRateLimited(ipHash, 30)) {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }
    if (await isPairRateLimited(ipHash, identifierHash, 10)) {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }
    const pinHashValue = sha256Pin(pin);

    const byHash = await prisma.employee.findFirst({
      where: { pinHash: pinHashValue, active: true },
      select: { id: true, name: true, role: true, permissions: true, defaultRoute: true, active: true, pin: true, preferredLanguage: true },
    });

    if (byHash) {
      // pinHash is only a lookup key, not the credential proof — always bcrypt verify
      if (!(await compare(pin, byHash.pin))) {
        await recordFailedAttempt(ipHash, identifierHash);
        return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
      }
      await clearAttempts(ipHash, identifierHash);
      employee = byHash;
    } else {
      // Fallback: scan only active employees whose pinHash is not yet populated
      const candidates = await prisma.employee.findMany({
        where: { pinHash: null, active: true },
        select: { id: true, name: true, role: true, permissions: true, defaultRoute: true, active: true, pin: true, preferredLanguage: true },
      });
      let matched: typeof candidates[0] | null = null;
      for (const e of candidates) {
        if (await compare(pin, e.pin)) { matched = e; break; }
      }
      if (!matched) {
        await recordFailedAttempt(ipHash, identifierHash);
        return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
      }
      // Opportunistic backfill: next login hits fast path.
      // P2002 means two employees share the same PIN (transition edge case) — admin must resolve.
      try {
        await prisma.employee.update({
          where: { id: matched.id },
          data: { pinHash: pinHashValue },
        });
      } catch (err) {
        console.error("[login] pinHash backfill failed for employee:", matched.id, err);
      }
      await clearAttempts(ipHash, identifierHash);
      employee = matched;
    }

  } else if (method === "password") {
    if (!username || !password) {
      return NextResponse.json({ error: "Username and password required" }, { status: 400 });
    }
    const normalizedUsername = String(username).trim().toLowerCase();
    const ipHash = hashRateLimitKey(ip);
    const identifierHash = hashRateLimitKey("pwd:" + normalizedUsername);
    await pruneExpired();
    if (await isIpRateLimited(ipHash, 30)) {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }
    if (await isPairRateLimited(ipHash, identifierHash, 10)) {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }
    const matched = await prisma.employee.findFirst({
      where: { OR: [{ username }, { name: username }] },
      select: { id: true, name: true, role: true, permissions: true, defaultRoute: true, active: true, preferredLanguage: true, password: true },
    });
    if (!matched || !matched.active || !matched.password || !(await compare(password, matched.password))) {
      await recordFailedAttempt(ipHash, identifierHash);
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }
    await clearAttempts(ipHash, identifierHash);
    const { password: _pw, ...matchedEmployee } = matched;
    employee = matchedEmployee;
  } else {
    return NextResponse.json({ error: "Invalid login method" }, { status: 400 });
  }

  if (!employee) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
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
