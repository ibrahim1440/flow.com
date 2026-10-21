import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { validateMaintenance } from "@/lib/services/settings/roasters";
import { employeeNames, maintenanceAudit, maintenanceOut } from "@/lib/services/settings/roasters-db";
import { writeSettingsAudit } from "@/lib/services/settings/audit";
import { fieldErrors, notFound, readObject, RouteError, routeErrorResponse } from "@/lib/services/settings/http";

/**
 * POST /api/settings/production/maintenance — «جدولة صيانة» (RM4 393:1398): { roasterId, title, kind
 * ROUTINE | ONE_OFF, recurrenceWeeks? (ROUTINE, descriptive), startsAt, endsAt, requestedById?, notes? }.
 * A planned window is shown on the availability week; nothing schedules around it yet (no schedule
 * exists — RM6–RM8 are later work), so «الأثر على الجدولة» has nothing to move. The admin role,
 * after a step-up; appended to SettingsAuditLog.
 */
export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.production", { stepUp: true });
  if (refused) return refused;
  const { body, error: bodyErr } = await readObject(request);
  if (bodyErr) return bodyErr;
  const v = validateMaintenance({ ...body, status: "PLANNED" });
  if (!v.ok) return fieldErrors(v.errors);
  if (typeof body.roasterId !== "string" || !body.roasterId) return notFound("roaster");
  const roasterId = body.roasterId;
  try {
    const m = await prisma.$transaction(async (tx) => {
      const r = await tx.roaster.findUnique({ where: { id: roasterId }, select: { status: true } });
      if (!r || r.status === "RETIRED") throw new RouteError(notFound("roaster"));
      if (v.values.requestedById && !(await tx.employee.findUnique({ where: { id: v.values.requestedById }, select: { id: true } }))) {
        throw new RouteError(fieldErrors([{ field: "requestedById", ar: "اختر من القائمة.", en: "Choose from the list.", summaryAr: "صاحب الطلب غير صالح", summaryEn: "Requested by is not valid" }]));
      }
      const row = await tx.roasterMaintenance.create({ data: { roasterId, ...v.values, createdById: user.id } });
      const after = maintenanceAudit(row);
      await writeSettingsAudit(tx, { section: "production", action: "MAINTENANCE_CREATED", entityType: "RoasterMaintenance", entityId: row.id, changed: Object.keys(after), before: null, after, actor: { id: user.id, name: user.name } });
      return row;
    }, TX_OPTS);
    return NextResponse.json({ maintenance: maintenanceOut(m, await employeeNames(prisma, [m.requestedById])) }, { status: 201 });
  } catch (err) {
    return routeErrorResponse(err) ?? handleDomainError(err);
  }
}
