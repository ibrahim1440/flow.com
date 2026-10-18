import { hrHandler } from "@/lib/hr/http";
import { HrError, can } from "@/lib/hr/core";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { prisma } from "@/lib/db";
import { payrollReadiness } from "@/lib/hr/readiness";

// Decision C GAP-9: the pre-activation readiness check of live payroll (read only): conflicting
// effective permissions (role defaults included), unverified / nameless privileged accounts, one
// person combining conflicting duties across logins, account-editor conditions and P1–P6 coverage.
// Account editors and policy managers may read it. No pay, credentials or personal data.
export const GET = hrHandler(async ({ actor }) => {
  const editor = hasModuleAccess(actor.permissions, "employees") && hasSubPrivilege(actor.permissions, "employees", "edit");
  if (!editor && !can(actor, "policy_manage")) throw new HrError("Insufficient permissions", 403, "FORBIDDEN");
  return payrollReadiness(prisma);
});
