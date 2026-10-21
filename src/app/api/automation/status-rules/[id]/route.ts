import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { audit } from "@/lib/hr/core";
import { invalidateAutomationCache } from "@/lib/automation/emit";
import { parseRecipients, validateStatusRuleInput } from "@/lib/automation/status-rules/rules";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PUT { enabled?, recipients?, template?, renotify? } — what WhatsApp does when a record enters this
 * status. Admin role, verified individual, recent step-up; the row is locked, validated against
 * its source (validateStatusRuleInput), saved, marked reviewed (the «جديدة» chip goes) and
 * audited with before / after (WHATSAPP_STATUS_RULE_UPDATED). The status itself (source, key,
 * label, active) belongs to the sync and cannot be changed here.
 */
export async function PUT(request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "automation.status_rules", { stepUp: true, message: "إشعارات الحالات متاحة لمدير النظام فقط." });
  if (refused) return refused;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  }

  try {
    const saved = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "WhatsAppStatusRule" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) throw { _appCode: 404, message: "الحالة غير موجودة.", errorEn: "Status not found." };
      const row = await tx.whatsAppStatusRule.findUniqueOrThrow({ where: { id } });
      const before = { enabled: row.enabled, recipients: parseRecipients(row.recipients), template: row.template, renotify: row.renotify };
      const v = validateStatusRuleInput(row, before, body);
      if (!v.ok) throw { _appCode: v.status, message: v.error, errorEn: v.errorEn, code: "INVALID_RULE" };
      const updated = await tx.whatsAppStatusRule.update({
        where: { id },
        data: { enabled: v.value.enabled, recipients: v.value.recipients, template: v.value.template, renotify: v.value.renotify, reviewedAt: new Date(), updatedById: user.id },
      });
      await audit(tx, {
        action: "WHATSAPP_STATUS_RULE_UPDATED",
        entityType: "WhatsAppStatusRule",
        entityId: id,
        actorId: user.id,
        before: { source: row.source, statusKey: row.statusKey, ...before },
        after: { source: row.source, statusKey: row.statusKey, ...v.value },
      });
      return updated;
    }, TX_OPTS);
    invalidateAutomationCache();
    return NextResponse.json({
      rule: { id: saved.id, enabled: saved.enabled, recipients: parseRecipients(saved.recipients), template: saved.template, renotify: saved.renotify, isNew: false, updatedAt: saved.updatedAt },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
