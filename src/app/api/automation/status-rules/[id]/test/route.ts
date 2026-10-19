import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";
import { audit } from "@/lib/hr/core";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { readSettings } from "@/lib/automation/settings";
import { renderTemplate, unknownPlaceholders } from "@/lib/automation/template";
import { getStatusSource, sourceEventDef } from "@/lib/automation/status-rules/sources";
import { sampleContext } from "@/lib/automation/catalog";
import { getConnectionState, sendText, whatsappConfig } from "@/lib/whatsapp/evolution";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST { template? } — «إرسال تجربة»: send this status's message, filled with sample values, to
 * the TEST NUMBER only (AutomationSettings.testPhone) — never to a customer, whatever the sending
 * mode. An unsaved template may be passed to try it before saving. Admin role, step-up,
 * rate-limited with the connection's test sends (10 / 10 min), logged as a test message
 * (WhatsAppMessage + WhatsAppSendAttempt) and audited (WHATSAPP_STATUS_TEST_SENT).
 */
export async function POST(request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "automation.status_rules", { stepUp: true, message: "إشعارات الحالات متاحة لمدير النظام فقط." });
  if (refused) return refused;
  const { id } = await params;

  let body: Record<string, unknown> = {};
  try {
    body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    const rule = await prisma.whatsAppStatusRule.findUnique({ where: { id } });
    if (!rule) return NextResponse.json({ error: "الحالة غير موجودة.", errorEn: "Status not found." }, { status: 404 });
    const source = getStatusSource(rule.source);
    if (!source) return NextResponse.json({ error: "مصدر الحالة غير معروف.", errorEn: "Unknown status source." }, { status: 409 });
    const def = sourceEventDef(source);
    const template = (typeof body.template === "string" ? body.template : rule.template).trim() || source.defaultTemplate;
    const unknown = unknownPlaceholders(def, template);
    if (unknown.length) {
      return NextResponse.json({ error: `متغير غير معروف: ${unknown.join(", ")}`, errorEn: `Unknown variable: ${unknown.join(", ")}` }, { status: 400 });
    }

    const settings = await readSettings();
    const target = normalizePhoneForWhatsApp(settings.testPhone);
    if (!target.ok) {
      return NextResponse.json({ error: "حدد رقم التجربة في «ربط الواتساب» أولًا.", errorEn: "Set the test number in WhatsApp connection first.", code: "NO_TEST_PHONE" }, { status: 409 });
    }
    const cfg = whatsappConfig();
    if (!cfg.ok) return NextResponse.json({ error: "الواتساب غير مُعدّ على الخادم.", errorEn: cfg.reason, code: "NOT_CONFIGURED" }, { status: 503 });

    const { limited } = await checkAndRecordRateLimit({ scope: "automation:test", key: user.id, limit: 10, windowMs: 10 * 60 * 1000 });
    if (limited) return NextResponse.json({ error: "طلبات كثيرة. انتظر بضع دقائق.", errorEn: "Too many requests. Wait a few minutes." }, { status: 429 });

    const state = await getConnectionState();
    if (!state.ok) return NextResponse.json({ error: "تعذر الوصول لخادم الواتساب.", errorEn: state.error }, { status: 502 });
    if (state.state !== "open") return NextResponse.json({ error: "الواتساب غير متصل.", errorEn: `WhatsApp is not connected (state: ${state.state}).` }, { status: 409 });

    const text = renderTemplate(def, template, { ...sampleContext(def), "status.name": rule.labelAr }, "ar");
    const started = Date.now();
    const result = await sendText(target.phone, text);
    await prisma.$transaction(async (tx) => {
      await tx.whatsAppMessage.create({
        data: {
          dedupeKey: `test:${randomUUID()}`,
          ruleName: `تجربة · إشعار الحالة: ${rule.labelAr}`,
          recipientKind: "test",
          recipientName: user.name,
          phone: target.phone,
          body: text,
          status: result.ok ? "SENT" : "FAILED",
          statusNote: result.ok ? "Test message." : result.error,
          attempts: 1,
          sentAt: result.ok ? new Date() : null,
          providerMessageId: result.ok ? result.messageId : null,
          createdById: user.id,
          sendAttempts: { create: { attemptNo: 1, ok: result.ok, httpStatus: result.ok ? 200 : result.status, error: result.ok ? null : result.error, durationMs: Date.now() - started } },
        },
      });
      await audit(tx, { action: "WHATSAPP_STATUS_TEST_SENT", entityType: "WhatsAppStatusRule", entityId: rule.id, actorId: user.id, after: { source: rule.source, statusKey: rule.statusKey, ok: result.ok } });
    });
    if (!result.ok) return NextResponse.json({ error: "فشل الإرسال.", errorEn: result.error }, { status: 502 });
    return NextResponse.json({ ok: true, phone: target.phone, body: text });
  } catch (err) {
    return handleDomainError(err);
  }
}
