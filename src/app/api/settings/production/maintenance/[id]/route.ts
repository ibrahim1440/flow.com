import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { validateMaintenance } from "@/lib/services/settings/roasters";
import { employeeNames, maintenanceAudit, maintenanceOut } from "@/lib/services/settings/roasters-db";
import { changedKeys, pick, writeSettingsAudit } from "@/lib/services/settings/audit";
import { fieldErrors, notFound, readObject, RouteError, routeErrorResponse } from "@/lib/services/settings/http";

type Params = { params: Promise<{ id: string }> };

const EDITABLE = ["title", "kind", "recurrenceWeeks", "startsAt", "endsAt", "status", "requestedById", "notes"] as const;

/**
 * PATCH /api/settings/production/maintenance/[id] — «تعديل» a maintenance window (RM4): any of title,
 * kind, recurrenceWeeks, startsAt, endsAt, status (PLANNED | IN_PROGRESS | DONE | CANCELLED),
 * requestedById, notes. A window that is DONE or CANCELLED is history and is not edited (409 CLOSED).
 * The admin role, after a step-up; appended to SettingsAuditLog with before / after.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.production", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  const { body, error: bodyErr } = await readObject(request);
  if (bodyErr) return bodyErr;
  try {
    const saved = await prisma.$transaction(async (tx) => {
      const cur = await tx.roasterMaintenance.findUnique({ where: { id } });
      if (!cur) throw new RouteError(notFound("maintenance"));
      if (cur.status === "DONE" || cur.status === "CANCELLED") {
        throw new RouteError(NextResponse.json({ error: "هذا الموعد مكتمل أو ملغى، ولا يُعدَّل.", errorEn: "This window is done or cancelled and is not edited.", code: "CLOSED" }, { status: 409 }));
      }
      const merged: Record<string, unknown> = {
        title: cur.title, kind: cur.kind, recurrenceWeeks: cur.recurrenceWeeks, startsAt: cur.startsAt.toISOString(),
        endsAt: cur.endsAt.toISOString(), status: cur.status, requestedById: cur.requestedById, notes: cur.notes ?? "",
      };
      for (const k of EDITABLE) if (k in body) merged[k] = body[k];
      const v = validateMaintenance(merged);
      if (!v.ok) throw new RouteError(fieldErrors(v.errors));
      if (v.values.requestedById && v.values.requestedById !== cur.requestedById && !(await tx.employee.findUnique({ where: { id: v.values.requestedById }, select: { id: true } }))) {
        throw new RouteError(fieldErrors([{ field: "requestedById", ar: "اختر من القائمة.", en: "Choose from the list.", summaryAr: "صاحب الطلب غير صالح", summaryEn: "Requested by is not valid" }]));
      }
      const row = await tx.roasterMaintenance.update({ where: { id }, data: v.values });
      const before = maintenanceAudit(cur), after = maintenanceAudit(row);
      const changed = changedKeys(before, after);
      if (changed.length) {
        await writeSettingsAudit(tx, { section: "production", action: "MAINTENANCE_UPDATED", entityType: "RoasterMaintenance", entityId: id, changed, before: { roasterId: cur.roasterId, ...pick(before, changed) }, after: { roasterId: cur.roasterId, ...pick(after, changed) }, actor: { id: user.id, name: user.name } });
      }
      return row;
    }, TX_OPTS);
    return NextResponse.json({ maintenance: maintenanceOut(saved, await employeeNames(prisma, [saved.requestedById])) });
  } catch (err) {
    return routeErrorResponse(err) ?? handleDomainError(err);
  }
}
