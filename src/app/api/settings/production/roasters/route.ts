import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { roasterAudit, roasterOut, validateRoaster, type FieldError } from "@/lib/services/settings/roasters";
import { employeeNames, isAuthorizedOperator } from "@/lib/services/settings/roasters-db";
import { writeSettingsAudit } from "@/lib/services/settings/audit";
import { fieldErrors, isUniqueViolation, readObject, RouteError, routeErrorResponse } from "@/lib/services/settings/http";

/**
 * POST /api/settings/production/roasters — «إضافة حمّاصة» (Figma RM2 389:640; ROASTERS.md §4, §7).
 *
 * The admin role, by a verified individual after a recent step-up (the organisation settings' gate).
 * Validated here, again by the database CHECKs: name required and unique (any case); type; the
 * weights 0 < min ≤ target ≤ max ≤ nominal; cycle 1–1440 minutes; a reason for «في الصيانة» /
 * «متوقفة»; a default operator must hold production › start_batch (and is assigned to the roaster).
 * The first roaster of a type becomes its default. Making another the default moves it from the
 * current one only when the request confirms it (`confirmMoveDefault`); otherwise 409
 * DEFAULT_EXISTS names the current default. Appended to SettingsAuditLog.
 */
export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.production", { stepUp: true });
  if (refused) return refused;
  const { body, error: bodyErr } = await readObject(request);
  if (bodyErr) return bodyErr;
  const v = validateRoaster(body);
  if (!v.ok) return fieldErrors(v.errors);
  const values = v.values;

  try {
    const created = await prisma.$transaction(async (tx) => {
      // One roaster write at a time: the name check and the default move see a stable table.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('settings.roasters'))`;
      const errs: FieldError[] = [];
      const dup = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Roaster" WHERE lower(btrim("name")) = lower(${values.name}) LIMIT 1`;
      if (dup.length) errs.push({ field: "name", ar: "توجد حمّاصة بهذا الاسم.", en: "A roaster with this name exists.", summaryAr: "اسم الحمّاصة مستخدم", summaryEn: "Roaster name is taken" });
      if (values.defaultOperatorId && !(await isAuthorizedOperator(tx, values.defaultOperatorId))) {
        errs.push({ field: "defaultOperatorId", ar: "هذا المستخدم غير مخوّل بالتحميص، فلا يمكن إسناده.", en: "This user is not authorized to roast and cannot be assigned.", summaryAr: "المشغّل الافتراضي غير مخوّل", summaryEn: "Default operator is not authorized" });
      }
      if (errs.length) throw new RouteError(fieldErrors(errs));

      const current = await tx.roaster.findFirst({ where: { type: values.type, isDefault: true }, select: { id: true, name: true, isDefault: true } });
      const anyOfType = await tx.roaster.count({ where: { type: values.type, status: { not: "RETIRED" } } });
      const isDefault = values.isDefault || anyOfType === 0;
      if (isDefault && current) {
        if (body.confirmMoveDefault !== true) {
          throw new RouteError(NextResponse.json({
            error: `«${current.name}» هي الافتراضية لهذا النوع. أكّد نقل الافتراضية.`,
            errorEn: `«${current.name}» is the default of this type. Confirm moving the default.`,
            code: "DEFAULT_EXISTS", currentDefault: current,
          }, { status: 409 }));
        }
        await tx.roaster.update({ where: { id: current.id }, data: { isDefault: false, updatedById: user.id } });
        await writeSettingsAudit(tx, { section: "production", action: "ROASTER_UPDATED", entityType: "Roaster", entityId: current.id, changed: ["isDefault"], before: { isDefault: true }, after: { isDefault: false }, actor: { id: user.id, name: user.name } });
      }
      const r = await tx.roaster.create({
        data: {
          name: values.name, manufacturerModel: values.manufacturerModel, type: values.type,
          nominalCapacityKg: values.nominalCapacityKg, defaultTargetKg: values.defaultTargetKg,
          minBatchKg: values.minBatchKg, maxBatchKg: values.maxBatchKg, cycleMinutes: values.cycleMinutes,
          defaultOperatorId: values.defaultOperatorId, status: values.status, statusReason: values.statusReason,
          ...(values.workingHours ? { workingHours: values.workingHours } : {}),
          isDefault, createdById: user.id, updatedById: user.id,
        },
      });
      if (values.defaultOperatorId) {
        await tx.roasterOperator.create({ data: { roasterId: r.id, employeeId: values.defaultOperatorId, createdById: user.id } });
      }
      const after = roasterAudit(r);
      await writeSettingsAudit(tx, { section: "production", action: "ROASTER_CREATED", entityType: "Roaster", entityId: r.id, changed: Object.keys(after), before: null, after, actor: { id: user.id, name: user.name } });
      return r;
    }, TX_OPTS);
    const names = await employeeNames(prisma, [created.defaultOperatorId]);
    return NextResponse.json({ roaster: roasterOut(created, names) }, { status: 201 });
  } catch (err) {
    const r = routeErrorResponse(err);
    if (r) return r;
    if (isUniqueViolation(err, ["Roaster_name_norm_key", "name"])) {
      return fieldErrors([{ field: "name", ar: "توجد حمّاصة بهذا الاسم.", en: "A roaster with this name exists.", summaryAr: "اسم الحمّاصة مستخدم", summaryEn: "Roaster name is taken" }]);
    }
    return handleDomainError(err);
  }
}
