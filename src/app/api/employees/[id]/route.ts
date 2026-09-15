import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { hash } from "bcryptjs";
import { createHash } from "crypto";
import { requireSub, requireAuth } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import {
  recordEmployeeAudit, diffEmployeeChange, lockEmployeeForAdmin,
} from "@/lib/services/employee-audit";
import { extractIp, hashRateLimitKey } from "@/lib/rate-limit";

/** Actor plus a hashed address — the same treatment login attempts already give one. */
function auditContext(request: Request, actorId: string) {
  return {
    actorId,
    ipHash: hashRateLimitKey(extractIp(request)),
    userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
  };
}

const SELECT_FULL = {
  id: true, name: true, username: true, role: true, permissions: true,
  defaultRoute: true, active: true, createdAt: true,
} as const;

const ALLOWED_DEFAULT_ROUTES = new Set([
  "/dashboard",
  "/dashboard/inventory",
  "/dashboard/orders",
  "/dashboard/production",
  "/dashboard/qc",
  "/dashboard/packaging",
  "/dashboard/dispatch",
  "/dashboard/history",
  "/dashboard/analytics",
  "/dashboard/labels",
  "/dashboard/employees",
  "/dashboard/customers",
  "/dashboard/purchases",
  "/dashboard/settings",
  "/dashboard/profile",
]);

function sha256Pin(pin: string): string {
  return createHash("sha256").update(pin).digest("hex");
}

async function isPinTaken(plainPin: string, excludeId: string): Promise<boolean> {
  const existing = await prisma.employee.findFirst({
    where: { pinHash: sha256Pin(plainPin), id: { not: excludeId } },
    select: { id: true },
  });
  return existing !== null;
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireSub("employees", "edit");
  if (error) return error;

  const { id } = await params;
  const { name, username, role, permissions, pin, password, defaultRoute, active } = await request.json();

  if (pin) {
    if (pin.length < 4) return NextResponse.json({ error: "PIN must be at least 4 digits" }, { status: 400 });
    if (await isPinTaken(pin, id)) {
      return NextResponse.json({ error: "This PIN is already assigned to another employee. Please choose a unique PIN." }, { status: 409 });
    }
  }

  const data: Record<string, unknown> = { name, role };
  if (username !== undefined) data.username = username;
  // Only when the request actually supplies them.
  //
  // This line used to run unconditionally, so `JSON.stringify(undefined || {})` wrote "{}"
  // whenever the field was absent: a PUT that changed nothing but the role — or the name,
  // or the default route — silently erased the employee's entire permission grant, leaving
  // an account that could still log in and could do nothing. Nothing reported it, because
  // until this wave nothing recorded permission changes at all; it surfaced the moment the
  // audit started describing the exact diff, as an unexplained revocation of every module.
  if (permissions !== undefined) {
    data.permissions =
      typeof permissions === "string" ? permissions : JSON.stringify(permissions || {});
  }
  if (defaultRoute !== undefined) {
    if (!ALLOWED_DEFAULT_ROUTES.has(defaultRoute))
      return NextResponse.json({ error: "Invalid defaultRoute." }, { status: 400 });
    data.defaultRoute = defaultRoute;
  }
  if (pin) { data.pin = await hash(pin, 10); data.pinHash = sha256Pin(pin); }
  if (password) data.password = await hash(password, 10);
  if (active !== undefined) data.active = active;

  try {
    // The change and the record of it commit together — and both are derived from a row
    // this transaction has LOCKED.
    //
    // Being inside a transaction is not enough, and an earlier version of this comment
    // claimed otherwise. A plain findUnique takes no lock, so under READ COMMITTED another
    // administrator could change the same employee between the read and the write: the
    // update would land on the newer row while the diff still described the older one, so
    // the audit recorded a transition out of a state that no longer existed. Worse,
    // `permissions` is one document — two administrators editing at once write whole blobs,
    // and the later write silently discards the earlier grant.
    const employee = await prisma.$transaction(async (tx) => {
      // First statement: everything below reads the row this lock protects.
      if (!(await lockEmployeeForAdmin(tx, id))) {
        throw { _appCode: 404, message: "Employee not found." };
      }

      const before = await tx.employee.findUniqueOrThrow({
        where: { id },
        select: { role: true, active: true, permissions: true },
      });

      const updated = await tx.employee.update({ where: { id }, data, select: SELECT_FULL });

      const events = diffEmployeeChange(
        before,
        {
          role: updated.role,
          active: updated.active,
          permissions: updated.permissions as string,
        },
        { pin: Boolean(pin), password: Boolean(password) },
      );
      await recordEmployeeAudit(
        tx,
        auditContext(request, user.id),
        events.map((e) => ({
          action: e.action,
          targetEmployeeId: id,
          targetName: updated.name,
          metadata: e.metadata,
        })),
      );

      return updated;
    }, TX_OPTS);

    return NextResponse.json(employee);
  } catch (err) {
    // The transaction above throws the `{ _appCode }` shape the newer routes use.
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Only admins can delete employees" }, { status: 403 });
  }

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
