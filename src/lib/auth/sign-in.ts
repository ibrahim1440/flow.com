// Shared by the sign-in, second-factor and step-up routes: the audit row of an authentication
// event, the short-lived second-factor challenge, and completing a sign-in into a session.
import { readSessionEmployee } from "./session-employee";
import { OPEN_LANDING_ROUTES, isSalesPersona, landingFor } from "@/lib/workspace/landing";
import { seesTeamReports } from "@/lib/services/sales/scope";
import { NextResponse } from "@/lib/api-response";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "@/lib/db";
import { parsePermissions, buildDefaultPermissions, hasModuleAccess, ALL_MODULES } from "@/lib/auth";
import { extractIp, hashRateLimitKey } from "@/lib/rate-limit";
import { startSession, type SessionMethod } from "./session";
import { simpleModePermissions } from "@/lib/simple-mode";
export { verifySecret } from "./secret";

/** One authentication event (never a credential): AuthAuditLog. */
export async function authAudit(request: Request, e: { userId?: string | null; action: string; result: "SUCCESS" | "FAILURE" | "REFUSED"; reasonCode?: string; identifier?: string; metadata?: Record<string, unknown> }) {
  await prisma.authAuditLog.create({
    data: { userId: e.userId ?? null, action: e.action, result: e.result, reasonCode: e.reasonCode ?? null, identifierHash: e.identifier ? hashRateLimitKey(e.identifier) : null, ipHash: hashRateLimitKey(extractIp(request)), userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null, metadata: (e.metadata ?? undefined) as never },
  }).catch(() => undefined);
}

const challengeKey = () => new TextEncoder().encode(`${process.env.JWT_SECRET}:mfa-challenge:v1`);

/** A 5-minute, single-purpose proof that the first factor passed; no session until the second. */
export async function signChallenge(employeeId: string, method: SessionMethod, purpose: "login") {
  return new SignJWT({ sub: employeeId, method, purpose }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(challengeKey());
}

export async function readChallenge(token: string, purpose: "login"): Promise<{ employeeId: string; method: SessionMethod } | null> {
  try {
    const { payload } = await jwtVerify(token, challengeKey());
    if (payload.purpose !== purpose || typeof payload.sub !== "string") return null;
    return { employeeId: payload.sub, method: payload.method as SessionMethod };
  } catch {
    return null;
  }
}

const ROUTE_MODULE_MAP: Record<string, string> = {
  "/dashboard": "dashboard", "/dashboard/inventory": "inventory", "/dashboard/orders": "orders", "/dashboard/production": "production", "/dashboard/qc": "qc",
  "/dashboard/packaging": "packaging", "/dashboard/dispatch": "dispatch", "/dashboard/history": "history", "/dashboard/analytics": "analytics",
  "/dashboard/labels": "labels", "/dashboard/employees": "employees",
};
function resolveRoute(defaultRoute: string, permissions: ReturnType<typeof parsePermissions>): string {
  // «مساحة عملي» needs no module: everything in it is scoped to the person by its API.
  if (OPEN_LANDING_ROUTES.has(defaultRoute)) return defaultRoute;
  // «يومي» (batch 24 WP-B): chosen by `landingFor` only for a holder of the sales module.
  if (defaultRoute === "/dashboard/my-day" && hasModuleAccess(permissions, "sales")) return defaultRoute;
  if (defaultRoute === "/dashboard/sales/team" && seesTeamReports(permissions, null)) return defaultRoute;
  const mod = ROUTE_MODULE_MAP[defaultRoute];
  if (!mod || mod === "dashboard") return "/dashboard";
  if (hasModuleAccess(permissions, mod)) return defaultRoute;
  for (const m of ALL_MODULES) if (m !== "dashboard" && hasModuleAccess(permissions, m)) return `/dashboard/${m}`;
  return "/dashboard";
}

/** The account passed every factor it needs: open a session and answer as sign-in always has. */
export async function completeSignIn(request: Request, employeeId: string, method: SessionMethod, mfa: boolean) {
  // The home preference column may be missing if the code ever runs before migration 3 (council fix round 3, MED-2):
  // sign-in goes on with «يومي» (readSessionEmployee), never a 500.
  const e = await readSessionEmployee<{ id: string; name: string; role: string; permissions: unknown; defaultRoute: string }>(prisma as never, employeeId,
    { id: true, name: true, role: true, permissions: true, defaultRoute: true });
  if (!e) throw new Error(`completeSignIn: employee ${employeeId} not found`);
  let permissions = parsePermissions(e.permissions as string);
  if (!permissions || Object.keys(permissions).length === 0) permissions = buildDefaultPermissions(e.role);
  // SIMPLE MODE: the admin role holds every module (same rule as the session).
  permissions = simpleModePermissions(permissions, e.role);
  // A team-view manager with no book of their own lands on «متابعة الفريق» (council fix round 1, P0-15).
  const teamViewWithoutBook = isSalesPersona({ role: e.role, permissions }) && seesTeamReports(permissions, e.role)
    && (await prisma.customer.count({ where: { accountOwnerId: e.id } })) === 0;
  const response = NextResponse.json({ user: { id: e.id, name: e.name, role: e.role, permissions }, redirectTo: resolveRoute(landingFor(e.defaultRoute || "/dashboard", { role: e.role, permissions }, { teamViewWithoutBook, homePreference: e.homePreference }), permissions) });
  await startSession(response, e.id, method, mfa, request);
  await authAudit(request, { userId: e.id, action: "SIGN_IN", result: "SUCCESS", reasonCode: method, metadata: { mfa } });
  return response;
}

/** Re-test AUTH-B: an enrolled account whose second factor cannot be checked (no AUTH_MFA_KEY here) fails closed — never 401, never a counted failure. */
export const MFA_UNAVAILABLE = () => NextResponse.json({ error: "Two-step verification is not configured on this server.", errorAr: "التحقق بخطوتين غير مهيأ على هذا الخادم.", code: "MFA_NOT_CONFIGURED" }, { status: 503 });

export const INVALID = () => NextResponse.json({ error: "Invalid credentials", errorAr: "بيانات الدخول غير صحيحة." }, { status: 401 });
export const TOO_MANY = () => NextResponse.json({ error: "Too many requests. Try again later.", errorAr: "محاولات كثيرة. حاول لاحقًا." }, { status: 429 });
