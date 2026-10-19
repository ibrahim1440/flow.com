import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { inventoryFromRow, LOW_STOCK_GREEN_KG_DEFAULT, LOW_STOCK_GREEN_KG_MAX, parseInventoryPatch } from "@/lib/services/settings/sections";
import { changedKeys, writeSettingsAudit } from "@/lib/services/settings/audit";

/**
 * Settings › Inventory (migration 20261022110000_settings_sections), on the SystemConfig singleton:
 *   · «حد المخزون المنخفض للبن الأخضر» — lowStockGreenKg, > 0 and ≤ 100000 kg; "" / null = the
 *     built-in 20 kg. Read by the inventory screen's green-coffee tab («أصناف أقل من … كغ»).
 *
 * GET: the admin role or the inventory module (the inventory screen states the line).
 * PUT: the admin role, by a verified individual after a recent step-up — the same gate as the
 * organisation and quotation settings. Each change is appended to SettingsAuditLog (before / after).
 */
const range = { min: 0, max: LOW_STOCK_GREEN_KG_MAX, default: LOW_STOCK_GREEN_KG_DEFAULT };

export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin" && !hasModuleAccess(user.permissions, "inventory")) return forbidden();
  try {
    const row = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
    return NextResponse.json({ ...inventoryFromRow(row), range, can: { edit: user.role === "admin" } });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.inventory", { stepUp: true });
  if (refused) return refused;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  const parsed = parseInventoryPatch(body as Record<string, unknown>);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errorAr, errorEn: parsed.error, code: "INVALID_SETTING", field: parsed.field }, { status: 400 });
  if (Object.keys(parsed.data).length === 0) return NextResponse.json({ error: "لا يوجد ما يُحفظ.", errorEn: "Nothing to change.", code: "EMPTY" }, { status: 400 });
  try {
    const saved = await prisma.$transaction(async (tx) => {
      await tx.systemConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
      await tx.$queryRaw`SELECT "id" FROM "SystemConfig" WHERE "id" = 'singleton' FOR UPDATE`;
      const before = inventoryFromRow(await tx.systemConfig.findUnique({ where: { id: "singleton" } }));
      const after = inventoryFromRow(await tx.systemConfig.update({ where: { id: "singleton" }, data: parsed.data }));
      const b = { lowStockGreenKg: before.lowStockGreenKg }, a = { lowStockGreenKg: after.lowStockGreenKg };
      const changed = changedKeys(b, a);
      if (changed.length) {
        await writeSettingsAudit(tx, { section: "inventory", action: "SETTINGS_UPDATED", entityType: "SystemConfig", entityId: "singleton", changed, before: b, after: a, actor: { id: user.id, name: user.name } });
      }
      return after;
    }, TX_OPTS);
    return NextResponse.json({ ...saved, range, can: { edit: true } });
  } catch (err) {
    return handleDomainError(err);
  }
}
