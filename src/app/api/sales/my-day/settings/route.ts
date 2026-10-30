import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAdminAction, requireAuth, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { changedKeys, pick, writeSettingsAudit } from "@/lib/services/settings/audit";
import { MY_DAY_SETTING_KEYS, parseSettingsPatch, settingsFrom } from "@/lib/services/sales/my-day/rules";
import { clearTierCache } from "@/lib/services/sales/my-day/tier";

const SELECT = Object.fromEntries(MY_DAY_SETTING_KEYS.map((k) => [k, true])) as Record<(typeof MY_DAY_SETTING_KEYS)[number], true>;

/** GET /api/sales/my-day/settings — the tier / growth / contact thresholds in force (any sales user: the day explains itself). */
export async function GET() {
  const { error } = await requireModule("sales");
  if (error) return error;
  try {
    const row = await prisma.systemConfig.findUnique({ where: { id: "singleton" }, select: SELECT });
    return NextResponse.json({ settings: settingsFrom(row as never) });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PUT /api/sales/my-day/settings — change the thresholds («إعدادات المبيعات › تصنيف العملاء»). ADMIN ONLY (owner
 * decision), through the admin-role gate with a step-up, audited before / after in the settings trail in the same
 * transaction. Body: any subset of the keys (MY_DAY_SETTING_KEYS).
 */
export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "sales.my_day_settings", { stepUp: true, message: "تعديل حدود التصنيف للمدير فقط." });
  if (refused) return refused;
  let body: Record<string, unknown>;
  try { body = (await request.json()) ?? {}; } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  try {
    const row = await prisma.systemConfig.findUnique({ where: { id: "singleton" }, select: SELECT });
    const before = settingsFrom(row as never);
    const parsed = parseSettingsPatch(before, body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error, errorEn: parsed.errorEn, field: parsed.field }, { status: 400 });
    const changed = changedKeys(before, parsed.next);
    if (changed.length) {
      await prisma.$transaction(async (tx) => {
        // Only the keys that changed are written (council fix round 1): an untouched NULL «contract notice» stays NULL
        // (= 45) instead of being silently stored as 45 behind the audit's back.
        const write = pick(parsed.next, changed) as Partial<typeof parsed.next>;
        await tx.systemConfig.upsert({ where: { id: "singleton" }, update: write, create: { id: "singleton", ...write } });
        // A NULL before-value is the built-in default: the trail says so («الافتراضي 45»), not a bare 45.
        const beforeShown: Record<string, unknown> = pick(before, changed);
        const rawRow = (row ?? {}) as Record<string, unknown>;
        for (const k of changed) if (rawRow[k] === null || rawRow[k] === undefined) beforeShown[k] = `الافتراضي ${before[k as keyof typeof before]}`;
        await writeSettingsAudit(tx, {
          section: "organisation", action: "SETTINGS_UPDATED", entityType: "SystemConfig", entityId: "singleton",
          changed, before: beforeShown, after: pick(parsed.next, changed), reason: "sales.my_day_settings", actor: { id: user.id, name: user.name },
        });
      });
    }
    // The search pill's cached books follow the new thresholds at once on this server (seat 6 r2).
    if (changed.length) clearTierCache();
    return NextResponse.json({ settings: parsed.next, changed });
  } catch (err) {
    return handleDomainError(err);
  }
}
