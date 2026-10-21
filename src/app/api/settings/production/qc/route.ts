import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { parseQcPatch, qcFromRow, QC_MIN_EVALUATORS_DEFAULT, QC_MIN_EVALUATORS_MAX } from "@/lib/services/settings/sections";
import { changedKeys, writeSettingsAudit } from "@/lib/services/settings/audit";

/**
 * Settings › Production & roasting › QC (migration 20261023090000_production_qc_simplify), on the
 * SystemConfig singleton:
 *   · «الحد الأدنى للمقيّمين» — minEvaluators, a whole number 1–10; "" / null = the built-in 2
 *     (owner decision D1). Enforced by POST /api/qc/[batchId]/finalize and
 *     /api/qc-records/bulk-finalize; fewer is an exceptional approval (qc › finalize_override, D2).
 *
 * GET: the admin role or the production / qc module (the QC screen states the minimum).
 * PUT: the admin role, by a verified individual after a recent step-up — the gate of the other
 * settings sections. Each change is appended to SettingsAuditLog (section "production").
 */
const range = { min: 1, max: QC_MIN_EVALUATORS_MAX, default: QC_MIN_EVALUATORS_DEFAULT };

export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin" && !hasModuleAccess(user.permissions, "production") && !hasModuleAccess(user.permissions, "qc")) return forbidden();
  try {
    const row = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
    return NextResponse.json({ ...qcFromRow(row), range, can: { edit: user.role === "admin" } });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.production_qc", { stepUp: true });
  if (refused) return refused;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  const parsed = parseQcPatch(body as Record<string, unknown>);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errorAr, errorEn: parsed.error, code: "INVALID_SETTING", field: parsed.field }, { status: 400 });
  if (Object.keys(parsed.data).length === 0) return NextResponse.json({ error: "لا يوجد ما يُحفظ.", errorEn: "Nothing to change.", code: "EMPTY" }, { status: 400 });
  try {
    const saved = await prisma.$transaction(async (tx) => {
      await tx.systemConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
      await tx.$queryRaw`SELECT "id" FROM "SystemConfig" WHERE "id" = 'singleton' FOR UPDATE`;
      const before = qcFromRow(await tx.systemConfig.findUnique({ where: { id: "singleton" } }));
      const after = qcFromRow(await tx.systemConfig.update({ where: { id: "singleton" }, data: parsed.data }));
      const b = { qcMinEvaluators: before.minEvaluators }, a = { qcMinEvaluators: after.minEvaluators };
      const changed = changedKeys(b, a);
      if (changed.length) {
        await writeSettingsAudit(tx, { section: "production", action: "SETTINGS_UPDATED", entityType: "SystemConfig", entityId: "singleton", changed, before: b, after: a, actor: { id: user.id, name: user.name } });
      }
      return after;
    }, TX_OPTS);
    return NextResponse.json({ ...saved, range, can: { edit: true } });
  } catch (err) {
    return handleDomainError(err);
  }
}
