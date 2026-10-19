import { NextResponse } from "next/server";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { exportAudit, parseFilters } from "@/lib/users/audit";
import { recordUsersAudit } from "@/lib/users/server";
import { auditContext } from "@/lib/users/account-update";
import { body, usersErrorResponse } from "@/lib/users/http";
import { prisma } from "@/lib/db";

// POST — «تصدير حساس» (Figma UR-12; owner decision O-6): the filtered log as CSV. A sensitive action:
// the administrator role, after a recent step-up; every export is itself audited (AUDIT_EXPORTED,
// with the filters and the row count) before the file is returned.
export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "users.audit_export", { stepUp: true, message: "Only the administrator exports the log." });
  if (refused) return refused;
  try {
    const filters = parseFilters(await body(request));
    const { csv, rows } = await exportAudit(filters);
    await recordUsersAudit(prisma, auditContext(request, user.id), "AUDIT_EXPORTED", { filters: { q: filters.q, cat: filters.cat, days: filters.days, source: filters.source }, rows });
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="permissions-audit-${stamp}.csv"`, "Cache-Control": "no-store" } });
  } catch (e) {
    return usersErrorResponse(e);
  }
}
