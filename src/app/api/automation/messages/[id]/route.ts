import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { actOnMessage } from "@/lib/automation/rule-service";
import { actOnEmail } from "@/lib/automation/email-dispatch";
import { requestAutomationDispatch } from "@/lib/automation/emit";
import { gateMessage } from "@/lib/automation/message-access";
import { resendAutomationMessage, reviewAutomationMessage } from "@/lib/automation/message-review";

type Params = { params: Promise<{ id: string }> };
const ACTIONS = ["retry", "cancel", "review", "resend"] as const;

/**
 * { action: "retry" | "cancel" | "review" | "resend", channel?: "whatsapp" | "email", outcome?, note?, confirm? }
 * R1-e (owner decisions 0–6): processing a row needs automation › manage_messages AND the row's department permission
 * AND its record in the viewer's scope (message-access.ts). A row the viewer may not read answers 404 — the same as a
 * missing one, so an id never confirms another department's message; a row they may read but not process answers 403.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const action = body.action as (typeof ACTIONS)[number];
  if (!(ACTIONS as readonly unknown[]).includes(action)) {
    return NextResponse.json({ error: "الإجراء غير معروف: إعادة المحاولة أو الإلغاء أو المراجعة أو الإعادة.", errorEn: "action must be retry, cancel, review or resend." }, { status: 400 });
  }
  const channel = body.channel === "email" ? "email" : "whatsapp";

  const actor = { id: user.id, name: user.name };
  const refusedGate = (status: 403 | 404) => status === 404
    ? NextResponse.json({ error: "الرسالة غير موجودة.", errorEn: "Message not found.", code: "NOT_FOUND" }, { status: 404 })
    : NextResponse.json({ error: "ما عندك صلاحية معالجة هذه الرسالة.", errorEn: "You may not process this message.", code: "FORBIDDEN" }, { status: 403 });
  try {
    // Owner (17 Nov 06:10): the permission and the record are checked again AT EXECUTION — in the action's own
    // transaction, the row locked (SELECT … FOR UPDATE) first, so two clicks / two people produce one outcome.
    const out = await prisma.$transaction(async (tx) => {
      if (channel === "email") await tx.$queryRaw`SELECT id FROM "EmailMessage" WHERE id = ${id} FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM "WhatsAppMessage" WHERE id = ${id} FOR UPDATE`;
      const gate = await gateMessage(user, channel, id, tx);
      if (!gate.ok) return { gate: gate.status } as const;
      if (action === "review") return { message: await reviewAutomationMessage(tx, channel, id, body, actor) } as const;
      if (action === "resend") return { resend: await resendAutomationMessage(tx, channel, id, body, actor) } as const;
      await (channel === "email" ? actOnEmail(tx, id, action, user.name) : actOnMessage(tx, id, action, user.name));
      return { done: true } as const;
    });
    if ("gate" in out && out.gate) return refusedGate(out.gate);
    if (action === "retry" || action === "resend") requestAutomationDispatch();
    return NextResponse.json({ ok: true, ...("message" in out ? { message: out.message } : "resend" in out ? { resend: out.resend } : {}) });
  } catch (err) {
    return handleDomainError(err);
  }
}
