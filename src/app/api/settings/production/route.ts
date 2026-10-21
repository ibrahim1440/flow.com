import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { productionOverview } from "@/lib/services/settings/roasters-db";

/**
 * Settings › Production & roasting › Roasters (Figma 377:2 RM1 / RM4; ROASTERS.md §4): every roaster
 * still in service, the maintenance windows (planned and in progress, and the last 120 days) and the
 * next planned one.
 *
 * GET: the admin role or the production module (ROASTERS.md §6: the production module sees roasters,
 * availability and operators read-only). Every change is made by the admin role, after a step-up,
 * through the routes beside this one, and is appended to SettingsAuditLog.
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin" && !hasModuleAccess(user.permissions, "production")) return forbidden();
  try {
    return NextResponse.json({ ...(await productionOverview(prisma)), can: { edit: user.role === "admin" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
