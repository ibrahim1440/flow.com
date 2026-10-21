import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { audit } from "@/lib/hr/core";
import { syncStatusCatalogue } from "@/lib/automation/status-rules/sync";
import { syncMessage } from "@/lib/automation/status-rules/rules";
import { readStatusRules } from "@/lib/automation/status-rules/view";

/**
 * POST — «تحديث الحالات»: pull every status in the system into the catalogue now, and say what
 * changed («أُضيفت 2 حالات جديدة»). Admin role, verified individual, recent step-up; audited with
 * the counts and the keys added (WHATSAPP_STATUS_SYNC). Idempotent: a second press adds nothing.
 */
export async function POST() {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "automation.status_rules", { stepUp: true, message: "إشعارات الحالات متاحة لمدير النظام فقط." });
  if (refused) return refused;
  try {
    const sync = await prisma.$transaction(async (tx) => {
      const r = await syncStatusCatalogue(tx);
      await audit(tx, { action: "WHATSAPP_STATUS_SYNC", entityType: "WhatsAppStatusRule", entityId: "catalogue", actorId: user.id, after: { trigger: "button", ...r } });
      return r;
    }, TX_OPTS);
    const view = await readStatusRules(prisma);
    return NextResponse.json({ ...view, sync, message: syncMessage(sync, "ar"), messageEn: syncMessage(sync, "en") });
  } catch (err) {
    return handleDomainError(err);
  }
}
