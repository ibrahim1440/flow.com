import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { audit } from "@/lib/hr/core";
import { syncStatusCatalogue } from "@/lib/automation/status-rules/sync";
import { readStatusRules } from "@/lib/automation/status-rules/view";

/**
 * «إشعارات الحالات» — GET: every status in the system and its WhatsApp rule (admin role only).
 *
 * Opening the screen brings the list up to date first (the owner's request: «تحديث الحالات أول
 * بأول»). That sync only mirrors what already exists in the system into the catalogue; it never
 * switches anything on (new statuses arrive OFF) and never deletes (a gone status is marked
 * inactive), so it runs on read without a step-up. When it changed something it is audited
 * (WHATSAPP_STATUS_SYNC, by the admin who opened the screen). The explicit button is
 * POST /api/automation/status-rules/sync, which answers with the counts for its feedback.
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin") return forbidden("إشعارات الحالات متاحة لمدير النظام فقط.");
  try {
    const sync = await prisma.$transaction(async (tx) => {
      const r = await syncStatusCatalogue(tx);
      if (r.added || r.deactivated || r.reactivated || r.renamed) {
        await audit(tx, { action: "WHATSAPP_STATUS_SYNC", entityType: "WhatsAppStatusRule", entityId: "catalogue", actorId: user.id, after: { trigger: "open", ...r } });
      }
      return r;
    }, TX_OPTS);
    const view = await readStatusRules(prisma);
    return NextResponse.json({ ...view, sync });
  } catch (err) {
    return handleDomainError(err);
  }
}
