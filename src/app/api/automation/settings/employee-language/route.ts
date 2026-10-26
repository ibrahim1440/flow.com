import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { asMsgLang } from "@/lib/automation/employee-lang";
import { SETTINGS_ID } from "@/lib/automation/settings";
import { writeSettingsAudit } from "@/lib/services/settings/audit";

/**
 * «لغة رسائل الموظفين» (owner language decision 3; migration 20261110090000_i18n_preferences): the
 * language automation WhatsApp messages to EMPLOYEES are written in when the employee has not chosen
 * one on their profile. NULL = Arabic (as before). Customers, typed numbers and marketing messages
 * are not affected.
 *
 * GET: the automation module. PUT { employeeMessageLang: "ar" | "en" | null }: automation ›
 * manage_rules (whoever writes the rules' texts), audited in SettingsAuditLog (section «automation»,
 * before / after). Sending mode and the WHATSAPP_LIVE_ENABLED gate are untouched.
 */
export async function GET() {
  const { user, error } = await requireModule("automation");
  if (error) return error;
  const row = await prisma.automationSettings.findUnique({ where: { id: SETTINGS_ID }, select: { employeeMessageLang: true } });
  const stored = asMsgLang(row?.employeeMessageLang);
  return NextResponse.json({ employeeMessageLang: stored, effective: stored ?? "ar", can: { edit: hasSubPrivilege(user.permissions, "automation", "manage_rules") } });
}

export async function PUT(request: Request) {
  const { user, error } = await requireSub("automation", "manage_rules");
  if (error) return error;
  let body: { employeeMessageLang?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  }
  const raw = body?.employeeMessageLang;
  if (raw === undefined) return NextResponse.json({ error: "لا يوجد ما يُحفظ.", errorEn: "Nothing to change.", code: "EMPTY" }, { status: 400 });
  const next = raw === null || raw === "" ? null : asMsgLang(raw);
  if (raw !== null && raw !== "" && !next) {
    return NextResponse.json({ error: "اللغة إما العربية أو الإنجليزية.", errorEn: "employeeMessageLang must be ar, en or null.", code: "INVALID_SETTING" }, { status: 400 });
  }
  try {
    const saved = await prisma.$transaction(async (tx) => {
      await tx.automationSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID }, update: {} });
      await tx.$queryRaw`SELECT "id" FROM "AutomationSettings" WHERE "id" = ${SETTINGS_ID} FOR UPDATE`;
      const before = asMsgLang((await tx.automationSettings.findUnique({ where: { id: SETTINGS_ID }, select: { employeeMessageLang: true } }))?.employeeMessageLang);
      const row = await tx.automationSettings.update({ where: { id: SETTINGS_ID }, data: { employeeMessageLang: next, updatedById: user.id }, select: { employeeMessageLang: true } });
      const after = asMsgLang(row.employeeMessageLang);
      if (before !== after) {
        await writeSettingsAudit(tx, {
          section: "automation", action: "SETTINGS_UPDATED", entityType: "AutomationSettings", entityId: SETTINGS_ID,
          changed: ["employeeMessageLang"], before: { employeeMessageLang: before }, after: { employeeMessageLang: after }, actor: { id: user.id, name: user.name },
        });
      }
      return after;
    }, TX_OPTS);
    return NextResponse.json({ employeeMessageLang: saved, effective: saved ?? "ar", can: { edit: true } });
  } catch (err) {
    return handleDomainError(err);
  }
}
