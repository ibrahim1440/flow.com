import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAuth, requireAdminAction, forbidden, privilegedGate } from "@/lib/auth-server";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { accessActor } from "@/lib/users/power";
import { handlePrismaError } from "@/lib/api-error";
import { recordEmployeeAudit, lockEmployeeForAdmin } from "@/lib/services/employee-audit";
import { auditContext, otherActiveAdmins, updateAccount } from "@/lib/users/account-update";
import { LAST_ADMIN, SELF_ACCESS, UsersError } from "@/lib/users/errors";

// PUT — change an account. The whole path (validation, the payroll-duty and second-person rules,
// the row lock, the audit) lives in src/lib/users/account-update.ts, shared with the users & roles
// screens; it also refuses self-elevation (UR-S08) and demoting the last administrator (UR-S09).
// Owner decision 19 Oct: the route admits an account editor (employees › edit) or a power user
// (employees › manage_access); a change of another account's ROLE or PERMISSIONS is made only by the
// administrator or a power user within its guardrails — employees › edit alone is refused
// (ACCESS_MANAGER_ONLY, in updateAccount), and a power user's change asks for a recent step-up.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const editor = hasModuleAccess(user.permissions, "employees") && hasSubPrivilege(user.permissions, "employees", "edit");
  if (!editor && accessActor(user) === null) return forbidden();
  // The central gate of the permission the caller acts with (as requireSub ran it): an account editor
  // (verified individual); otherwise the power user (verified individual and a recent step-up).
  const refused = editor ? await privilegedGate(user, "employees", "edit") : await privilegedGate(user, "employees", "manage_access");
  if (refused) return refused;

  const { id } = await params;
  return updateAccount(request, user, id, await request.json());
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  // Deleting an account is the admin role exercised: a verified individual, after a recent step-up.
  const refused = await requireAdminAction(user, "employees.delete", { stepUp: true, message: "Only admins can delete employees" });
  if (refused) return refused;

  const { id } = await params;

  try {
    // Both or neither. The audit is written first so that the metadata can describe an
    // employee that still exists; if the delete then fails — an operational foreign key,
    // a QC record, a cupping score — the whole transaction rolls back and no successful
    // deletion event survives to contradict an employee who is still there.
    await prisma.$transaction(async (tx) => {
      // The same lock the edit path takes, for the same reason: the audit must describe
      // the employee as they actually were at the moment they were deleted, not as they
      // were before an edit that committed while this transaction was reading.
      if (!(await lockEmployeeForAdmin(tx, id))) {
        throw { _appCode: 404, message: "Employee not found." };
      }

      const target = await tx.employee.findUniqueOrThrow({
        where: { id },
        select: { name: true, role: true, active: true },
      });
      // Nobody deletes their own account, and the last active administrator stays (UR-S09).
      if (id === user.id) throw SELF_ACCESS();
      if (target.role === "admin" && target.active && (await otherActiveAdmins(tx, id)) === 0) throw LAST_ADMIN(target.name);

      await recordEmployeeAudit(tx, auditContext(request, user.id), [{
        action: "EMPLOYEE_DELETED",
        targetEmployeeId: id,
        targetName: target.name,
        metadata: { role: target.role, activeAtDeletion: target.active },
      }]);

      await tx.employee.delete({ where: { id } });
    }, TX_OPTS);

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof UsersError) return err.response();
    // The transaction above throws the `{ _appCode }` shape the newer routes use.
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    const code = (err as { code?: string })?.code;
    if (code === "P2003" || code === "P2014") {
      return NextResponse.json(
        { error: "Cannot delete this employee because they have linked operational records. Please deactivate their account instead." },
        { status: 400 }
      );
    }
    return handlePrismaError(err);
  }
}
