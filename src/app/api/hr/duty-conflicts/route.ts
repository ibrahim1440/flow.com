import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { effectivePermissions, payrollDutyConflicts, payrollDuties } from "@/lib/hr/sod";
import { identityOfMany } from "@/lib/hr/identity";

/**
 * P-3 / Q-3 / owner decision 1: what an account editor must review. Existing assignments are
 * not revoked automatically. Names, roles and duty keys only — no credentials, pay or personal data.
 *   conflicts            accounts holding conflicting duty pairs;
 *   identityNotVerified  accounts holding any segregated duty (payroll execution or
 *                        administration) or the admin role whose login is not linked to a VERIFIED
 *                        person (Option A): they keep the duties but are blocked from payroll
 *                        actions until verified — «هوية غير موثّقة» / «محظور من إجراءات الرواتب حتى التوثيق»;
 *   pendingReviews       immediate revocations not yet acknowledged by another person.
 */
export async function GET() {
  const { error } = await requireSub("employees", "edit");
  if (error) return error;
  const [rows, reviews] = await Promise.all([
    // Inactive accounts too (QA2 P3): a reactivation would bring their duties back — flagged.
    prisma.employee.findMany({ select: { id: true, name: true, role: true, permissions: true, active: true }, orderBy: { name: "asc" } }),
    prisma.hrConfigChange.findMany({ where: { kind: "PERMISSION_REVIEW", status: "PENDING" }, orderBy: { requestedAt: "asc" }, select: { id: true, payload: true, requestedAt: true } }),
  ]);
  const identity = await identityOfMany(prisma, rows.map((r) => r.id));
  const enriched = rows.map((r) => {
    const stored = typeof r.permissions === "string" ? r.permissions : JSON.stringify(r.permissions ?? {});
    const eff = effectivePermissions(stored, r.role);
    return { id: r.id, name: r.name, role: r.role, inactive: !r.active, usesRoleDefaults: !stored || stored === "{}" || stored === "null", conflicts: payrollDutyConflicts(eff), duties: payrollDuties(eff) };
  });
  const conflicts = enriched.filter((r) => r.conflicts.length > 0).map((r) => ({ id: r.id, name: r.name, role: r.role, inactive: r.inactive, usesRoleDefaults: r.usesRoleDefaults, conflicts: r.conflicts }));
  const identityNotVerified = enriched
    .filter((r) => !identity.get(r.id)?.verified && (r.duties.length > 0 || r.role === "admin"))
    .map((r) => {
      const s = identity.get(r.id)!;
      return { id: r.id, name: r.name, role: r.role, inactive: r.inactive, duties: r.duties, linked: !!s.person, personType: s.person?.type ?? null, personName: s.person?.name ?? null, status: s.person ? "NOT_VERIFIED" : "NOT_LINKED", blocked: true, label: "هوية غير موثّقة", blockedLabel: "محظور من إجراءات الرواتب حتى التوثيق" };
    });
  const pendingReviews = reviews.map((v) => {
    const p = v.payload as { accountId: string; accountName: string; revoked: string[]; fromAdmin: boolean };
    return { id: v.id, accountId: p.accountId, accountName: p.accountName, revoked: p.revoked, fromAdmin: p.fromAdmin, at: v.requestedAt };
  });
  return NextResponse.json({ conflicts, identityNotVerified, pendingReviews });
}
