import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { DEFAULT_LOGIN_TAGLINE, LOGIN_TAGLINE_MAX, parseTaglinePatch, taglineFromRow } from "@/lib/login-tagline";
import { changedKeys, writeSettingsAudit } from "@/lib/services/settings/audit";

/**
 * Settings › Organisation › «شعار صفحة الدخول» (owner language decision 1; migration
 * 20261110090000_i18n_preferences), on the SystemConfig singleton:
 *   · taglineAr / taglineEn — the line under the brand on the sign-in screen, per language, 1–120
 *     characters; "" / null = the built-in line (src/lib/login-tagline.ts).
 *
 * GET: the admin role (the Organisation page is admin-only). The sign-in screen does NOT call this:
 * its server layout reads the two columns alone (src/app/login/layout.tsx), so nothing else of the
 * configuration row is ever exposed to a signed-out visitor.
 * PUT: the admin role, by a verified individual after a recent step-up — the same gate as the other
 * Organisation and settings sections. Each change is appended to SettingsAuditLog (section
 * «organisation», before / after).
 */
const limits = { max: LOGIN_TAGLINE_MAX, defaults: DEFAULT_LOGIN_TAGLINE };
const SELECT = { loginTaglineAr: true, loginTaglineEn: true } as const;

export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin") return forbidden();
  try {
    const row = await prisma.systemConfig.findUnique({ where: { id: "singleton" }, select: SELECT });
    return NextResponse.json({ ...taglineFromRow(row), limits, can: { edit: true } });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.login_tagline", { stepUp: true });
  if (refused) return refused;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  const parsed = parseTaglinePatch(body as Record<string, unknown>);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errorAr, errorEn: parsed.error, code: "INVALID_SETTING", field: parsed.field }, { status: 400 });
  if (Object.keys(parsed.data).length === 0) return NextResponse.json({ error: "لا يوجد ما يُحفظ.", errorEn: "Nothing to change.", code: "EMPTY" }, { status: 400 });
  try {
    const saved = await prisma.$transaction(async (tx) => {
      await tx.systemConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
      await tx.$queryRaw`SELECT "id" FROM "SystemConfig" WHERE "id" = 'singleton' FOR UPDATE`;
      const before = taglineFromRow(await tx.systemConfig.findUnique({ where: { id: "singleton" }, select: SELECT }));
      const after = taglineFromRow(await tx.systemConfig.update({ where: { id: "singleton" }, data: parsed.data, select: SELECT }));
      const b = { taglineAr: before.ar, taglineEn: before.en }, a = { taglineAr: after.ar, taglineEn: after.en };
      const changed = changedKeys(b, a);
      if (changed.length) {
        await writeSettingsAudit(tx, { section: "organisation", action: "SETTINGS_UPDATED", entityType: "SystemConfig", entityId: "singleton", changed, before: b, after: a, actor: { id: user.id, name: user.name } });
      }
      return after;
    }, TX_OPTS);
    return NextResponse.json({ ...saved, limits, can: { edit: true } });
  } catch (err) {
    return handleDomainError(err);
  }
}
