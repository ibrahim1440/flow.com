import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { isAuthorizedOperator, operatorsFor } from "@/lib/services/settings/roasters-db";
import { writeSettingsAudit } from "@/lib/services/settings/audit";
import { notFound, readObject, RouteError, routeErrorResponse } from "@/lib/services/settings/http";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/settings/production/roasters/[id]/operators — «المشغّلون» (RM5 397:2052): every active login
 * that can open production, and anybody assigned, with the authorization (production › start_batch,
 * read now — not stored here) and the assignment to this roaster. The admin role or the production module.
 */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin" && !hasModuleAccess(user.permissions, "production")) return forbidden();
  const { id } = await params;
  try {
    const out = await operatorsFor(prisma, id);
    if (!out) return notFound("roaster");
    return NextResponse.json({ ...out, can: { edit: user.role === "admin" } });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PUT /api/settings/production/roasters/[id]/operators — assign or unassign one login: { employeeId,
 * assigned }. «لا يُسند مستخدم غير مخوّل» — assigning somebody without production › start_batch is
 * refused (400 NOT_AUTHORIZED). The roaster's default operator cannot be unassigned (409
 * DEFAULT_OPERATOR) — choose another default first. The admin role, after a step-up; appended to
 * SettingsAuditLog.
 */
export async function PUT(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.production", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  const { body, error: bodyErr } = await readObject(request);
  if (bodyErr) return bodyErr;
  const employeeId = body.employeeId;
  if (typeof employeeId !== "string" || !employeeId || typeof body.assigned !== "boolean") {
    return NextResponse.json({ error: "حدّد المستخدم والإسناد.", errorEn: "Give employeeId and assigned (true / false).", code: "INVALID_BODY" }, { status: 400 });
  }
  const assigned = body.assigned;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('settings.roasters'))`;
      const r = await tx.roaster.findUnique({ where: { id }, include: { operators: { where: { employeeId } } } });
      if (!r || r.status === "RETIRED") throw new RouteError(notFound("roaster"));
      const isAssigned = r.operators.length > 0;
      if (assigned === isAssigned) return;
      if (assigned) {
        if (!(await isAuthorizedOperator(tx, employeeId))) {
          throw new RouteError(NextResponse.json({
            error: "لا يمكن إسناده: لا يملك صلاحية بدء التحميص (production.start_batch).",
            errorEn: "Cannot be assigned: no permission to start roasting (production.start_batch).",
            code: "NOT_AUTHORIZED",
          }, { status: 400 }));
        }
        await tx.roasterOperator.create({ data: { roasterId: id, employeeId, createdById: user.id } });
      } else {
        if (r.defaultOperatorId === employeeId) {
          throw new RouteError(NextResponse.json({
            error: "هذا هو المشغّل الافتراضي للمحمصة. اختر مشغّلًا افتراضيًا آخر أولًا.",
            errorEn: "This is the roaster's default operator. Choose another default operator first.",
            code: "DEFAULT_OPERATOR",
          }, { status: 409 }));
        }
        await tx.roasterOperator.deleteMany({ where: { roasterId: id, employeeId } });
      }
      const name = (await tx.employee.findUnique({ where: { id: employeeId }, select: { name: true } }))?.name ?? null;
      await writeSettingsAudit(tx, {
        section: "production", action: assigned ? "OPERATOR_ASSIGNED" : "OPERATOR_UNASSIGNED",
        entityType: "RoasterOperator", entityId: id, changed: ["assigned"],
        before: { employeeId, employeeName: name, assigned: !assigned }, after: { employeeId, employeeName: name, assigned },
        actor: { id: user.id, name: user.name },
      });
    }, TX_OPTS);
    return NextResponse.json(await operatorsFor(prisma, id));
  } catch (err) {
    return routeErrorResponse(err) ?? handleDomainError(err);
  }
}
