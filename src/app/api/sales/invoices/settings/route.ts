import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { canEdit, hasModuleAccess } from "@/lib/auth-shared";
import { jsonBody } from "@/lib/accounting/http";
import { changedKeys, writeSettingsAudit } from "@/lib/services/settings/audit";
import { canViewInvoices } from "@/lib/services/invoicing/access";
import { parseSettingsPatch, readInvoiceSettings, sellerSnapshot, sellerReady } from "@/lib/services/invoicing/settings";
import { invError, refuseInv } from "@/lib/services/invoicing/refusals";

/**
 * Settings › Invoicing & tax › «الفواتير الضريبية» (A2): the series prefixes, the invoicing point (manual / on
 * delivery), the default payment terms and the seller's structured national address (ZATCA BR-KSA-09).
 * GET: invoices viewers or the settings module. PUT: the admin role, verified individual + step-up, audited
 * (SettingsAuditLog, section invoicing).
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canViewInvoices(user.permissions) && !hasModuleAccess(user.permissions, "settings")) return forbidden();
  try {
    const s = await readInvoiceSettings(prisma);
    const seller = await sellerSnapshot(prisma);
    return NextResponse.json({ ...s, seller, sellerReady: sellerReady(seller), can: { edit: canEdit(user.permissions, "settings") } });
  } catch (err) {
    return invError(err);
  }
}

export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.invoicing_documents", { stepUp: true });
  if (refused) return refused;
  try {
    const body = await jsonBody(request);
    const parsed = parseSettingsPatch(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.ar, errorEn: parsed.en, code: "INVALID_SETTING", field: parsed.field }, { status: 400 });
    if (Object.keys(parsed.data).length === 0) throw refuseInv("BAD_INPUT", "Nothing to change.", "لا يوجد ما يُحفظ.");
    await prisma.$transaction(async (tx) => {
      await tx.systemConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
      await tx.$queryRaw`SELECT "id" FROM "SystemConfig" WHERE "id" = 'singleton' FOR UPDATE`;
      const before = (await readInvoiceSettings(tx)).stored as Record<string, unknown>;
      const beforeAddr = (await readInvoiceSettings(tx)).address as Record<string, unknown>;
      await tx.systemConfig.update({ where: { id: "singleton" }, data: parsed.data });
      const after = await readInvoiceSettings(tx);
      const b = { ...before, ...beforeAddr }, a = { ...(after.stored as Record<string, unknown>), ...(after.address as Record<string, unknown>) };
      const changed = changedKeys(b, a);
      if (changed.length) await writeSettingsAudit(tx, { section: "invoicing", action: "SETTINGS_UPDATED", entityType: "SystemConfig", entityId: "singleton", changed, before: b, after: a, actor: { id: user.id, name: user.name } });
    }, TX_OPTS);
    const s = await readInvoiceSettings(prisma);
    const seller = await sellerSnapshot(prisma);
    return NextResponse.json({ ...s, seller, sellerReady: sellerReady(seller), can: { edit: true } });
  } catch (err) {
    return invError(err);
  }
}
