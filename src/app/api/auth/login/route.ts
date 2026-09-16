import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { compare } from "bcryptjs";
import { signToken, parsePermissions, buildDefaultPermissions, hasModuleAccess, ALL_MODULES } from "@/lib/auth";
import {
  extractIp, hashRateLimitKey, pruneExpired, isIpRateLimited, isPairRateLimited,
  recordFailedAttempt, clearAttempts, recordPinFailure, clearPinAttempts,
  isPinSpaceConstrained, isIpQuietForPin, isIpPinRateLimited,
} from "@/lib/rate-limit";
import { validatePin } from "@/lib/pin-policy";
import { pinLookup, pinVerifierInput, requirePinLookupSecret } from "@/lib/pin-lookup";

// There is deliberately no pinHash helper here any more, and no raw-PIN bcrypt either. The
// legacy pinHash column is neither read nor written under Version B — it is inert until
// migration #19 drops it — so an employee carrying a valid pinHash and no pinLookup cannot
// log in. The credential is proved by bcrypt over pinVerifierInput(pin), never over the raw
// PIN: keeping a raw-PIN comparison around would be an invitation to reintroduce the offline
// verifier this design exists to retire.

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
    // One PIN shape, checked here exactly as it is checked on every path that SETS one.
    // An invalid shape is refused before anything is hashed, so a malformed candidate
    // never reaches the lookup, the verifier or the rate-limit identifier.
    const shape = validatePin(pin);
    if (!shape.ok) {
      return NextResponse.json({ error: shape.message }, { status: 400 });
    }
    const candidate = shape.pin;

    const ipHash = hashRateLimitKey(ip);
    const identifierHash = hashRateLimitKey("pin:" + candidate);
    await pruneExpired();

    // ── Throttles, before any bcrypt work ─────────────────────────────────
    // The first two are unchanged. The third is new and exists because neither of them
    // bounds a DISTRIBUTED walk of the PIN space: the candidate is the identifier, so an
    // attacker trying 000000, 000001, … produces a different identifierHash every time
    // and no per-identifier threshold ever accumulates.
    if (await isIpRateLimited(ipHash, 30)) {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }
    if (await isPairRateLimited(ipHash, identifierHash, 10)) {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }
    if (await isPinSpaceConstrained()) {
      // Under a system-wide burst, admit only addresses that have not just failed. An
      // operator typing the right PIN has no recent failures and is unaffected; every
      // enumerating address disqualifies itself on its first miss and gets roughly one
      // attempt a minute. A staff mistype during an attack costs a bounded wait, never a
      // lockout an attacker can hold open.
      if (!(await isIpQuietForPin(ipHash)) || (await isIpPinRateLimited(ipHash, 3))) {
        return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
      }
    }

    // ── Lookup, then proof ────────────────────────────────────────────────
    // Both derivations are keyed by the same secret the database does not contain. pinHash is
    // NOT consulted: an employee holding a valid legacy pinHash and no pinLookup cannot
    // authenticate, which is what makes the old recoverable column inert from today.
    const secret = requirePinLookupSecret();
    const lookup = pinLookup(candidate, secret);

    const byLookup = await prisma.employee.findFirst({
      where: { pinLookup: lookup, active: true },
      select: { id: true, name: true, role: true, permissions: true, defaultRoute: true, active: true, pin: true, preferredLanguage: true },
    });

    // Finding the row is not authenticating the person: bcrypt still decides. It decides over
    // pinVerifierInput(candidate), never over the raw candidate — the stored hash is
    // bcrypt(pinVerifierInput(pin)), so a raw-PIN compare would authenticate no one. Two
    // independent failures would be needed to admit the wrong operator.
    if (!byLookup || !(await compare(pinVerifierInput(candidate, secret), byLookup.pin))) {
      await recordPinFailure(ipHash, identifierHash);
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    await clearPinAttempts(ipHash, identifierHash);
    employee = byLookup;

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
