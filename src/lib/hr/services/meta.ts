// Native HR — what the UI needs to render: the caller's duties and the reference lists.
// Never returns anything sensitive; each list is gated by the duty that uses it.
import { prisma } from "@/lib/db";
import { MODULE_SUB_PRIVILEGES } from "@/lib/auth-shared";
import { type HrActor, can, type HrSub, resolveScope, scopeWhere } from "../core";
import { listPolicies } from "./policy";

export async function meta(actor: HrActor) {
  const caps = Object.fromEntries(MODULE_SUB_PRIVILEGES.hr.map((s) => [s.key, can(actor, s.key as HrSub)])) as Record<HrSub, boolean>;
  const scope = await resolveScope(actor);
  const [departments, branches, leaveTypes, shifts, people, policies] = await Promise.all([
    prisma.hrDepartment.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.finBranch.findMany({ where: scope.all ? { active: true } : { active: true, id: { in: scope.branchIds } }, select: { id: true, code: true, nameAr: true, nameEn: true }, orderBy: { code: "asc" } }),
    prisma.hrLeaveType.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.hrShift.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    caps.directory || caps.leave_manage || caps.leave_approve || caps.attendance_manage || caps.attendance_approve || caps.advances_manage || caps.payroll_prepare || caps.assets_manage || caps.recruit ? prisma.hrEmployee.findMany({ where: { AND: [scopeWhere(scope), { status: { not: "SEPARATED" } }] }, select: { id: true, employeeNo: true, fullNameAr: true, jobTitle: true, branchId: true }, orderBy: { employeeNo: "asc" } }) : Promise.resolve([]),
    listPolicies(),
  ]);
  const active = policies.find((p) => p.status === "ACTIVE") ?? null;
  return {
    caps,
    actorId: actor.id,
    allBranches: scope.all,
    selfEmployeeId: scope.selfEmployeeId,
    departments,
    branches,
    leaveTypes: leaveTypes.map((t) => ({ id: t.id, code: t.code, nameAr: t.nameAr, paid: t.paid, tracksBalance: t.tracksBalance, isProposal: t.isProposal, accrualDaysPerYear: t.accrualDaysPerYear?.toString() ?? null })),
    shifts,
    people,
    policy: active ? { version: active.version, dayBasis: active.dayBasis, timezone: active.timezone, isProposal: active.isProposal, weekendDays: active.weekendDays } : null,
  };
}
