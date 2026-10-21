import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { roasterAudit, roasterOut, validateStatusChange } from "@/lib/services/settings/roasters";
import { employeeNames } from "@/lib/services/settings/roasters-db";
import { changedKeys, pick, writeSettingsAudit } from "@/lib/services/settings/audit";
import { fieldErrors, notFound, readObject, RouteError, routeErrorResponse } from "@/lib/services/settings/http";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/settings/production/roasters/[id]/status — «تغيير الحالة» (RM4b 395:1701).
 * Body: { status: AVAILABLE | MAINTENANCE | STOPPED, reason (required unless AVAILABLE), until? (ISO,
 * future; optional — «تعود "متاحة" يدويًا») }. Nothing returns the roaster to «متاحة» by itself: the
 * until-date is shown, not acted on. The schedule's planned slots are not touched — no schedule
 * exists yet (RM6–RM8 are later work). The admin role, after a step-up; appended to SettingsAuditLog
 * with the reason.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.production", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  const { body, error: bodyErr } = await readObject(request);
  if (bodyErr) return bodyErr;
  const v = validateStatusChange(body);
  if (!v.ok) return fieldErrors(v.errors);
  try {
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('settings.roasters'))`;
      const cur = await tx.roaster.findUnique({ where: { id } });
      if (!cur || cur.status === "RETIRED") throw new RouteError(notFound("roaster"));
      const statusChanged = v.status !== cur.status;
      const row = await tx.roaster.update({
        where: { id },
        data: { status: v.status, statusReason: v.reason, statusUntil: v.until, ...(statusChanged ? { statusSince: new Date() } : {}), updatedById: user.id },
      });
      const before = roasterAudit(cur), after = roasterAudit(row);
      const changed = changedKeys(before, after);
      if (changed.length) {
        await writeSettingsAudit(tx, { section: "production", action: "ROASTER_STATUS_CHANGED", entityType: "Roaster", entityId: id, changed, before: pick(before, changed), after: pick(after, changed), reason: v.reason, actor: { id: user.id, name: user.name } });
      }
      return row;
    }, TX_OPTS);
    const names = await employeeNames(prisma, [saved.defaultOperatorId]);
    return NextResponse.json({ roaster: roasterOut(saved, names) });
  } catch (err) {
    return routeErrorResponse(err) ?? handleDomainError(err);
  }
}
