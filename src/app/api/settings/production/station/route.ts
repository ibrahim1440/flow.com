import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { parseStationPatch, stationFromRow } from "@/lib/services/settings/sections";
import { changedKeys, writeSettingsAudit } from "@/lib/services/settings/audit";

/**
 * Settings › Production & roasting › Roasting station (migration 20261116090000_station_lot_scan), on the SystemConfig
 * singleton:
 *   · «تأكيد الكيس بالمسح في محطة التحميص» — lotScanRequired, default false. Off: the station shows no scan (the server
 *     picks the lot and the station says where to draw from). On: the scan is offered as an override only.
 *
 * GET: the admin role or the production module. PUT: the admin role, by a verified individual after a recent step-up
 * (the gate of the other settings sections). Each change is appended to SettingsAuditLog (section "production").
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin" && !hasModuleAccess(user.permissions, "production")) return forbidden();
  try {
    const row = await prisma.systemConfig.findUnique({ where: { id: "singleton" }, select: { stationLotScanRequired: true } });
    return NextResponse.json({ ...stationFromRow(row), can: { edit: user.role === "admin" } });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.production_station", { stepUp: true });
  if (refused) return refused;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  const parsed = parseStationPatch(body as Record<string, unknown>);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errorAr, errorEn: parsed.error, code: "INVALID_SETTING", field: parsed.field }, { status: 400 });
  if (Object.keys(parsed.data).length === 0) return NextResponse.json({ error: "لا يوجد ما يُحفظ.", errorEn: "Nothing to change.", code: "EMPTY" }, { status: 400 });
  try {
    const saved = await prisma.$transaction(async (tx) => {
      await tx.systemConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
      await tx.$queryRaw`SELECT "id" FROM "SystemConfig" WHERE "id" = 'singleton' FOR UPDATE`;
      const before = stationFromRow(await tx.systemConfig.findUnique({ where: { id: "singleton" }, select: { stationLotScanRequired: true } }));
      const after = stationFromRow(await tx.systemConfig.update({ where: { id: "singleton" }, data: parsed.data, select: { stationLotScanRequired: true } }));
      const b = { stationLotScanRequired: before.lotScanRequired }, a = { stationLotScanRequired: after.lotScanRequired };
      const changed = changedKeys(b, a);
      if (changed.length) {
        await writeSettingsAudit(tx, { section: "production", action: "SETTINGS_UPDATED", entityType: "SystemConfig", entityId: "singleton", changed, before: b, after: a, actor: { id: user.id, name: user.name } });
      }
      return after;
    }, TX_OPTS);
    return NextResponse.json({ ...saved, can: { edit: true } });
  } catch (err) {
    return handleDomainError(err);
  }
}
