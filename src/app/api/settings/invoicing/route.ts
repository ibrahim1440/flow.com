import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { DEFAULT_VAT_PERCENT, invoicingFromRow, parseInvoicingPatch } from "@/lib/services/settings/sections";
import { changedKeys, writeSettingsAudit } from "@/lib/services/settings/audit";
import { readQuoteSettings } from "@/lib/services/sales/quote-settings";

/**
 * Settings › Invoicing & tax (migration 20261022110000_settings_sections), on the SystemConfig
 * singleton. Settings only: nothing here issues, signs or submits an invoice (ZATCA is a later batch).
 *   · «نسبة الضريبة الافتراضية» — defaultVatPercent, 0–100; "" / null = the built-in 15%. Read by
 *     the quotation editor for each NEW line; a line keeps its own rate, an issued document its own.
 *   · The VAT and CR numbers are shown (read-only) from the organisation's seller block, where they
 *     are edited (/api/settings/quotation), so they are not stored twice.
 *
 * GET: the admin role or the sales module (the quotation editor reads the default).
 * PUT: the admin role, by a verified individual after a recent step-up. Each change is appended to
 * SettingsAuditLog (before / after).
 */
const range = { min: 0, max: 100, default: DEFAULT_VAT_PERCENT };

export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin" && !hasModuleAccess(user.permissions, "sales")) return forbidden();
  try {
    const row = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
    const q = await readQuoteSettings(prisma);
    return NextResponse.json({
      ...invoicingFromRow(row),
      range,
      registration: { vatNumber: q.seller.sellerVatNumber, crNumber: q.seller.sellerCrNumber },
      can: { edit: user.role === "admin" },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.invoicing", { stepUp: true });
  if (refused) return refused;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  const parsed = parseInvoicingPatch(body as Record<string, unknown>);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errorAr, errorEn: parsed.error, code: "INVALID_SETTING", field: parsed.field }, { status: 400 });
  if (Object.keys(parsed.data).length === 0) return NextResponse.json({ error: "لا يوجد ما يُحفظ.", errorEn: "Nothing to change.", code: "EMPTY" }, { status: 400 });
  try {
    const saved = await prisma.$transaction(async (tx) => {
      await tx.systemConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
      await tx.$queryRaw`SELECT "id" FROM "SystemConfig" WHERE "id" = 'singleton' FOR UPDATE`;
      const before = invoicingFromRow(await tx.systemConfig.findUnique({ where: { id: "singleton" } }));
      const after = invoicingFromRow(await tx.systemConfig.update({ where: { id: "singleton" }, data: parsed.data }));
      const b = { defaultVatPercent: before.defaultVatPercent }, a = { defaultVatPercent: after.defaultVatPercent };
      const changed = changedKeys(b, a);
      if (changed.length) {
        await writeSettingsAudit(tx, { section: "invoicing", action: "SETTINGS_UPDATED", entityType: "SystemConfig", entityId: "singleton", changed, before: b, after: a, actor: { id: user.id, name: user.name } });
      }
      return after;
    }, TX_OPTS);
    const q = await readQuoteSettings(prisma);
    return NextResponse.json({ ...saved, range, registration: { vatNumber: q.seller.sellerVatNumber, crNumber: q.seller.sellerCrNumber }, can: { edit: true } });
  } catch (err) {
    return handleDomainError(err);
  }
}
