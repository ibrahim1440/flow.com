import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { roasterAudit, roasterOut, validateRoaster, type FieldError } from "@/lib/services/settings/roasters";
import { employeeNames, isAuthorizedOperator, roasterHistory } from "@/lib/services/settings/roasters-db";
import { changedKeys, pick, writeSettingsAudit } from "@/lib/services/settings/audit";
import { fieldErrors, isUniqueViolation, notFound, readObject, RouteError, routeErrorResponse } from "@/lib/services/settings/http";
import { parseFiniteDecimal } from "@/lib/services/commissions/engine";
import { normaliseNumberText } from "@/lib/services/settings/sections";
import { cancelSlotsForRoasterStatus } from "@/lib/services/schedule/schedule-db";
import { Prisma } from "@/generated/prisma/client";
import { roasterEffectiveSite } from "@/lib/services/stock-locations";

type Params = { params: Promise<{ id: string }> };

/** The value sent equals the stored one (the form sends the locked nominal back unchanged). */
function sameDecimal(v: unknown, stored: string): boolean {
  const d = (typeof v === "string" || typeof v === "number") ? parseFiniteDecimal(normaliseNumberText(String(v))) : null;
  return !!d && d.equals(stored);
}

const EDITABLE = ["name", "manufacturerModel", "type", "defaultTargetKg", "minBatchKg", "maxBatchKg", "cycleMinutes", "defaultOperatorId", "status", "statusReason", "isDefault", "workingHours"] as const;

/**
 * GET /api/settings/production/roasters/[id] — one roaster (RM3) with its change history.
 * The admin role or the production module.
 */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin" && !hasModuleAccess(user.permissions, "production")) return forbidden();
  const { id } = await params;
  try {
    const r = await prisma.roaster.findUnique({ where: { id } });
    if (!r) return notFound("roaster");
    const names = await employeeNames(prisma, [r.defaultOperatorId]);
    return NextResponse.json({ roaster: { ...roasterOut(r, names), effectiveSite: await roasterEffectiveSite(prisma, id) }, history: await roasterHistory(prisma, id), can: { edit: user.role === "admin" } });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PATCH /api/settings/production/roasters/[id] — «حفظ التغييرات» (RM3 391:1012).
 *
 * Partial: a key absent from the body is unchanged; the merged result is validated as a whole (the
 * RM2 rules). The nominal capacity is a verified specification (D5) and is refused here (400
 * NOMINAL_LOCKED): changing it is a separate, verified request that this batch does not build.
 * `expectedUpdatedAt` (the version the form was opened on) turns a concurrent save into 409 CONFLICT
 * instead of overwriting it. A status change here needs its reason, as in the status dialog. The
 * admin role, after a step-up. Appended to SettingsAuditLog with the changed fields, before / after.
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('settings.roasters'))`;
      const cur = await tx.roaster.findUnique({ where: { id } });
      if (!cur || cur.status === "RETIRED") throw new RouteError(notFound("roaster"));
      if (typeof body.expectedUpdatedAt === "string" && new Date(body.expectedUpdatedAt).getTime() !== cur.updatedAt.getTime()) {
        throw new RouteError(NextResponse.json({
          error: "حُفظت تغييرات أخرى على هذه الحمّاصة بعد فتحك النموذج. أعد التحميل للمقارنة؛ مدخلاتك باقية.",
          errorEn: "Someone else saved changes to this roaster after you opened the form. Reload to compare; your inputs are kept.",
          code: "CONFLICT",
        }, { status: 409 }));
      }
      if ("nominalCapacityKg" in body && !sameDecimal(body.nominalCapacityKg, cur.nominalCapacityKg.toString())) {
        throw new RouteError(NextResponse.json({
          error: "سعة الحمّاصة (حسب الشركة المصنّعة) مواصفة معتمدة. تغييرها طلب منفصل بمستند يُراجَع ويُسجَّل.",
          errorEn: "The roaster capacity (manufacturer rating) is a verified specification. Changing it is a separate request with a document that is reviewed and recorded.",
          code: "NOMINAL_LOCKED", field: "nominalCapacityKg",
        }, { status: 400 }));
      }
      const merged: Record<string, unknown> = {
        name: cur.name, manufacturerModel: cur.manufacturerModel, type: cur.type,
        nominalCapacityKg: cur.nominalCapacityKg.toString(), defaultTargetKg: cur.defaultTargetKg.toString(),
        minBatchKg: cur.minBatchKg.toString(), maxBatchKg: cur.maxBatchKg.toString(), cycleMinutes: cur.cycleMinutes,
        defaultOperatorId: cur.defaultOperatorId, status: cur.status, statusReason: cur.statusReason, isDefault: cur.isDefault,
        workingHours: cur.workingHours,
      };
      for (const k of EDITABLE) if (k in body) merged[k] = body[k];
      const v = validateRoaster(merged);
      if (!v.ok) throw new RouteError(fieldErrors(v.errors));
      const values = v.values;

      const errs: FieldError[] = [];
      if (values.name.toLowerCase() !== cur.name.trim().toLowerCase()) {
        const dup = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Roaster" WHERE lower(btrim("name")) = lower(${values.name}) AND "id" <> ${id} LIMIT 1`;
        if (dup.length) errs.push({ field: "name", ar: "توجد حمّاصة بهذا الاسم.", en: "A roaster with this name exists.", summaryAr: "اسم الحمّاصة مستخدم", summaryEn: "Roaster name is taken" });
      }
      if (values.defaultOperatorId && values.defaultOperatorId !== cur.defaultOperatorId && !(await isAuthorizedOperator(tx, values.defaultOperatorId))) {
        errs.push({ field: "defaultOperatorId", ar: "هذا المستخدم غير مخوّل بالتحميص، فلا يمكن إسناده.", en: "This user is not authorized to roast and cannot be assigned.", summaryAr: "المشغّل الافتراضي غير مخوّل", summaryEn: "Default operator is not authorized" });
      }
      if (errs.length) throw new RouteError(fieldErrors(errs));

      // The default of the (possibly new) type.
      let isDefault = values.isDefault;
      const other = await tx.roaster.findFirst({ where: { type: values.type, isDefault: true, id: { not: id } }, select: { id: true, name: true } });
      const othersOfType = await tx.roaster.count({ where: { type: values.type, status: { not: "RETIRED" }, id: { not: id } } });
      if (othersOfType === 0) isDefault = true;
      if (isDefault && other) {
        if (body.confirmMoveDefault !== true) {
          throw new RouteError(NextResponse.json({
            error: `«${other.name}» هي الافتراضية لهذا النوع. أكّد نقل الافتراضية.`,
            errorEn: `«${other.name}» is the default of this type. Confirm moving the default.`,
            code: "DEFAULT_EXISTS", currentDefault: other,
          }, { status: 409 }));
        }
        await tx.roaster.update({ where: { id: other.id }, data: { isDefault: false, updatedById: user.id } });
        await writeSettingsAudit(tx, { section: "production", action: "ROASTER_UPDATED", entityType: "Roaster", entityId: other.id, changed: ["isDefault"], before: { isDefault: true }, after: { isDefault: false }, actor: { id: user.id, name: user.name } });
      }

      // «موقع الحمّاصة» (20261117090000, owner decision 5): where it draws green; null = the production site.
      let locationId = cur.locationId;
      if ("locationId" in body) {
        if (body.locationId === null || body.locationId === "") locationId = null;
        else {
          const l = typeof body.locationId === "string" ? await tx.stockLocation.findUnique({ where: { id: body.locationId }, select: { id: true, isActive: true, type: true } }) : null;
          if (!l || !l.isActive || l.type === "TRANSIT") throw new RouteError(fieldErrors([{ field: "locationId", ar: "اختر موقعًا نشطًا.", en: "Choose an active location.", summaryAr: "موقع الحمّاصة غير صالح", summaryEn: "Roaster location is not valid" }]));
          locationId = l.id;
        }
      }
      const statusChanged = values.status !== cur.status;
      const row = await tx.roaster.update({
        where: { id },
        data: {
          name: values.name, manufacturerModel: values.manufacturerModel, type: values.type,
          defaultTargetKg: values.defaultTargetKg, minBatchKg: values.minBatchKg, maxBatchKg: values.maxBatchKg,
          cycleMinutes: values.cycleMinutes, defaultOperatorId: values.defaultOperatorId,
          status: values.status, statusReason: values.statusReason,
          ...(statusChanged ? { statusSince: new Date(), statusUntil: null } : {}),
          isDefault, updatedById: user.id, locationId,
          workingHours: values.workingHours ?? Prisma.DbNull,
        },
      });
      // ROASTERS.md §5.10: to maintenance / stopped → the coming planned slots return to the work queue.
      if (statusChanged) await cancelSlotsForRoasterStatus(tx, id, values.status, values.statusReason, { id: user.id, name: user.name });
      // A default operator is an assigned one (ROASTERS.md §4).
      if (values.defaultOperatorId) {
        await tx.roasterOperator.upsert({
          where: { roasterId_employeeId: { roasterId: id, employeeId: values.defaultOperatorId } },
          create: { roasterId: id, employeeId: values.defaultOperatorId, createdById: user.id },
          update: {},
        });
      }
      const before = roasterAudit(cur), after = roasterAudit(row);
      const changed = changedKeys(before, after);
      if (changed.length) {
        await writeSettingsAudit(tx, {
          section: "production", action: statusChanged && changed.every((k) => ["status", "statusReason", "statusUntil"].includes(k)) ? "ROASTER_STATUS_CHANGED" : "ROASTER_UPDATED",
          entityType: "Roaster", entityId: id, changed, before: pick(before, changed), after: pick(after, changed),
          reason: statusChanged ? values.statusReason : null, actor: { id: user.id, name: user.name },
        });
      }
      return row;
    }, TX_OPTS);
    const names = await employeeNames(prisma, [saved.defaultOperatorId]);
    return NextResponse.json({ roaster: { ...roasterOut(saved, names), effectiveSite: await roasterEffectiveSite(prisma, id) }, history: await roasterHistory(prisma, id) });
  } catch (err) {
    const r = routeErrorResponse(err);
    if (r) return r;
    if (isUniqueViolation(err, ["Roaster_name_norm_key", "name"])) {
      return fieldErrors([{ field: "name", ar: "توجد حمّاصة بهذا الاسم.", en: "A roaster with this name exists.", summaryAr: "اسم الحمّاصة مستخدم", summaryEn: "Roaster name is taken" }]);
    }
    return handleDomainError(err);
  }
}
