import { canViewQuotes } from "@/lib/services/sales/quote-access";
import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { parseSettingsPatch, readQuoteSettings, settingsFromRow, SELLER_FIELDS } from "@/lib/services/sales/quote-settings";
import { DISCOUNT_APPROVAL_THRESHOLD, DISCOUNT_MAX } from "@/lib/services/sales/discount-limits";

/**
 * Quotation settings (migration 20261021090000_sales_quotes), on the SystemConfig singleton:
 *   · «حد الخصم الذي يحتاج اعتماد» — discountApprovalPercent, 0–60, "" / null = the built-in 10%;
 *   · the seller block of the quotation document — sellerLegalNameAr / En, sellerAddressAr / En,
 *     sellerVatNumber (15 digits 3…3), sellerCrNumber (10 digits), sellerPhone, and the bank
 *     transfer details printed on the document — sellerBankName, sellerBankAccountName, sellerIban
 *     (SA + 22 digits; spaces allowed on input, stored without).
 *
 * GET: the admin role or the sales module (the quotation screens state the threshold).
 * PUT: the admin role, by a verified individual after a recent step-up — a policy change, gated
 * exactly as the cupping close policy (/api/settings/cupping). Partial: an absent key is unchanged.
 * Every change is appended to SalesQuoteAudit (QUOTE_SETTINGS_UPDATED, before / after).
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  // BATCH22 WP-E: the quotation's seller block is read by whoever may read quotations (sales or accounting — canViewQuotes).
  if (user.role !== "admin" && !canViewQuotes(user.permissions)) return forbidden();
  try {
    const s = await readQuoteSettings(prisma);
    return NextResponse.json({
      ...s,
      range: { min: 0, max: DISCOUNT_MAX, default: DISCOUNT_APPROVAL_THRESHOLD },
      can: { edit: user.role === "admin" },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "sales.quote_settings", { stepUp: true });
  if (refused) return refused;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  }
  const parsed = parseSettingsPatch((body ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errorAr, errorEn: parsed.error, code: "INVALID_SETTING" }, { status: 400 });
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Nothing to change.", code: "EMPTY" }, { status: 400 });
  }

  try {
    const saved = await prisma.$transaction(async (tx) => {
      // The singleton may not exist yet (it is created lazily, as for the logo).
      await tx.systemConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
      await tx.$queryRaw`SELECT "id" FROM "SystemConfig" WHERE "id" = 'singleton' FOR UPDATE`;
      const before = settingsFromRow(await tx.systemConfig.findUnique({ where: { id: "singleton" } }));
      const row = await tx.systemConfig.update({ where: { id: "singleton" }, data: parsed.data });
      const after = settingsFromRow(row);
      const changed = (["discountApprovalPercent"] as const).filter((k) => before[k] !== after[k]) as string[];
      for (const k of SELLER_FIELDS) if (before.seller[k] !== after.seller[k]) changed.push(k);
      if (changed.length) {
        const actor = await tx.employee.findUnique({ where: { id: user.id }, select: { name: true } });
        await tx.salesQuoteAudit.create({
          data: {
            action: "QUOTE_SETTINGS_UPDATED",
            actorId: user.id,
            actorName: actor?.name ?? null,
            details: {
              changed,
              before: { discountApprovalPercent: before.discountApprovalPercent, ...before.seller },
              after: { discountApprovalPercent: after.discountApprovalPercent, ...after.seller },
            },
          },
        });
      }
      return after;
    }, TX_OPTS);
    return NextResponse.json({ ...saved, range: { min: 0, max: DISCOUNT_MAX, default: DISCOUNT_APPROVAL_THRESHOLD }, can: { edit: true } });
  } catch (err) {
    return handleDomainError(err);
  }
}
