import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { inventoryFromRow, LOW_STOCK_GREEN_KG_DEFAULT, LOW_STOCK_GREEN_KG_MAX, parseInventoryPatch } from "@/lib/services/settings/sections";
import { changedKeys, writeSettingsAudit } from "@/lib/services/settings/audit";
import { SHORTFALL_PERCENT_DEFAULT, SHORTFALL_ROLLING_MULTIPLE_DEFAULT, SHORTFALL_VALUE_SAR_DEFAULT, SHORTFALL_ZERO_DEFAULT, highLimits, shortfallLimitsFromRow } from "@/lib/inventory/shortfall-threshold";

/**
 * Settings › Inventory (migration 20261022110000_settings_sections), on the SystemConfig singleton:
 *   · «حد المخزون المنخفض للبن الأخضر» — lowStockGreenKg, > 0 and ≤ 100000 kg; "" / null = the
 *     built-in 20 kg. Read by the inventory screen's green-coffee tab («أصناف أقل من … كغ»).
 *   · «حد النقص عند الاستلام» (20261118090000_shortfall_threshold) — shortfallPercent (0–100, default 2),
 *     shortfallValueSar (≥ 0, default 500), shortfallZeroNeedsAdjust (default on): above any of them a receiver's
 *     shortfall needs inventory › adjust and the stock-change gate; shortfallRollingMultiple (0–1000, default 2): a
 *     receiver whose 30 days pass this many times the value limit needs a supervisor. "" / null = back to the default.
 *     A warning (shortfall.high) when percent ≥ 50, value ≥ 10,000 or the zero rule is off — never a block.
 *
 * GET: the admin role or the inventory module (the inventory screen states the line).
 * PUT: the admin role, by a verified individual after a recent step-up — the same gate as the
 * organisation and quotation settings. Each change is appended to SettingsAuditLog (before / after).
 */
const range = { min: 0, max: LOW_STOCK_GREEN_KG_MAX, default: LOW_STOCK_GREEN_KG_DEFAULT };
const shortfallDefaults = { percent: SHORTFALL_PERCENT_DEFAULT, valueSar: SHORTFALL_VALUE_SAR_DEFAULT, zeroNeedsAdjust: SHORTFALL_ZERO_DEFAULT, rollingMultiple: SHORTFALL_ROLLING_MULTIPLE_DEFAULT };
type Row = Parameters<typeof inventoryFromRow>[0] & Parameters<typeof shortfallLimitsFromRow>[0];
/** The section as the screen reads it: the low-stock line and the shortfall threshold (stored values and those in force). */
function view(row: Row) {
  const s = shortfallLimitsFromRow(row);
  const effective = { percent: s.percent, valueSar: s.valueSar, zeroNeedsAdjust: s.zeroNeedsAdjust, rollingMultiple: s.rollingMultiple };
  // Council F3: a warning (never a block) when a limit lets a large shortfall pass without a supervisor.
  return { ...inventoryFromRow(row), shortfall: { stored: s.stored, effective, defaults: shortfallDefaults, high: highLimits(effective) } };
}
/** The audited facts of the section (stored values; null = the default). */
const facts = (v: ReturnType<typeof view>) => ({ lowStockGreenKg: v.lowStockGreenKg, shortfallPercent: v.shortfall.stored.percent, shortfallValueSar: v.shortfall.stored.valueSar, shortfallZeroNeedsAdjust: v.shortfall.stored.zeroNeedsAdjust, shortfallRollingMultiple: v.shortfall.stored.rollingMultiple });

export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin" && !hasModuleAccess(user.permissions, "inventory")) return forbidden();
  try {
    const row = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
    return NextResponse.json({ ...view(row as Row), range, can: { edit: user.role === "admin" } });
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
      const before = view((await tx.systemConfig.findUnique({ where: { id: "singleton" } })) as Row);
      const after = view((await tx.systemConfig.update({ where: { id: "singleton" }, data: parsed.data })) as Row);
      const b = facts(before), a = facts(after);
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
