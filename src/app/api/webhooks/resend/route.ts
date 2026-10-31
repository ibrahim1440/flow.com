import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { classifyResendEvent, verifySvix } from "@/lib/notify/resend-webhook";
import { SETTINGS_ID } from "@/lib/automation/settings";
import { writeSettingsAudit } from "@/lib/services/settings/audit";
import { appendOptOutNote, SOURCE_TEXT_AR } from "@/lib/automation/email-consent";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/resend — Resend's delivery reports (batch 25). PUBLIC, but every request must carry a valid Svix
 * signature made with RESEND_WEBHOOK_SECRET (set by the owner in Vercel, from the Resend dashboard's webhook page):
 * missing / wrong / stale → 401, nothing read or written. Without the secret configured → 503 (not accepted).
 *
 * Idempotent: the svix-id is stored (EmailProviderEvent) in the same transaction as its effect, so a replay changes
 * nothing. Effects, on the message matched by Resend's id:
 *   email.delivered  → «وصل» (and, for a test e-mail to the current test address, the proof LIVE needs);
 *   email.bounced    → permanent: «ارتدّ» + the address is suppressed (never e-mailed again); transient: noted only;
 *   email.complained → the address is suppressed and the customer's «يستقبل إيميلات» is switched off.
 * Answers counts only; logs no address.
 */
export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured." }, { status: 503 });
  const raw = await request.text();
  if (raw.length > 256 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const h = { id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") };
  const v = verifySvix(secret, h, raw);
  if (!v.ok) return NextResponse.json({ error: "Invalid signature.", code: v.reason }, { status: 401 });
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const ev = classifyResendEvent(payload);

  // An event can arrive before our row holds Resend's id (the send's answer is saved a moment later). Such an event — when it
  // is one of ours (tagged) and under a day old — is NOT marked handled: we answer 409 and Svix retries it later. A bounce or complaint suppresses its addresses at once,
  // so the address is never e-mailed again even before the retry matches the message (fix round 1).
  const EARLY = Symbol("early");
  const EARLY_WINDOW_MS = 24 * 3600_000;
  const now0 = Date.now();
  let outcome: string;
  try {
    outcome = await prisma.$transaction(async (tx) => {
    const fresh = await tx.emailProviderEvent.createMany({ data: [{ id: h.id!, type: ev.type || "unknown", providerMessageId: ev.providerMessageId }], skipDuplicates: true });
    if (fresh.count === 0) return "replay";
    if (!ev.providerMessageId) return "ignored";
    const msg = await tx.emailMessage.findUnique({ where: { providerMessageId: ev.providerMessageId }, select: { id: true, status: true, toEmail: true, intendedEmail: true, customerId: true, recipientKind: true, planMode: true } });
    if (!msg) {
      // Only OUR e-mails (tagged hq=automation at send) are worth a retry, and only for a day: the alert / HR /
      // notification e-mails of the same Resend account report here too and must get 200, or Svix would retry them
      // forever and could disable the endpoint (fix round 2).
      const ageMs = now0 - (ev.createdAt?.getTime() ?? Number(h.timestamp) * 1000);
      if (ev.tagged && (ev.kind === "delivered" || ev.kind === "bounced_hard" || ev.kind === "complained") && !(ageMs > EARLY_WINDOW_MS)) throw EARLY;
      return "unknown_message";
    }
    const now = new Date();
    const suppress = async (reason: "HARD_BOUNCE" | "COMPLAINT") => {
      if (msg.toEmail) await tx.emailSuppression.createMany({ data: [{ email: msg.toEmail.toLowerCase(), reason, providerEventId: h.id! }], skipDuplicates: true });
    };
    if (ev.kind === "delivered") {
      await tx.emailMessage.updateMany({ where: { id: msg.id, status: "SENT" }, data: { status: "DELIVERED", deliveredAt: now } });
      if (msg.recipientKind === "test" && msg.toEmail) {
        const s = await tx.automationSettings.findUnique({ where: { id: SETTINGS_ID }, select: { testEmail: true } });
        if (s?.testEmail === msg.toEmail) {
          await tx.automationSettings.update({ where: { id: SETTINGS_ID }, data: { testEmailVerifiedAt: now } });
          await writeSettingsAudit(tx, {
            section: "automation", action: "SETTINGS_UPDATED", entityType: "AutomationSettings", entityId: SETTINGS_ID, changed: ["testEmailVerifiedAt"],
            after: { via: "resend_delivered" }, reason: "EMAIL_TEST_CONFIRMED", actor: { id: "resend-webhook", name: "Resend" },
          });
        }
      }
      return "delivered";
    }
    if (ev.kind === "bounced_hard") {
      await tx.emailMessage.updateMany({ where: { id: msg.id, status: { in: ["SENT", "DELIVERED"] } }, data: { status: "BOUNCED", bouncedAt: now, statusNote: "Bounced: the receiving server refused this address." } });
      await suppress("HARD_BOUNCE");
      return "bounced";
    }
    if (ev.kind === "complained") {
      await tx.emailMessage.updateMany({ where: { id: msg.id, status: { in: ["SENT", "DELIVERED", "BOUNCED"] } }, data: { status: "COMPLAINED", complainedAt: now, statusNote: "The recipient marked it as spam." } });
      await suppress("COMPLAINT");
      // Only a complaint by the REAL customer (a LIVE send that was not redirected to the test address) opts them out.
      if (msg.customerId && msg.planMode === "LIVE" && !msg.intendedEmail) {
        const c = await tx.customer.findUnique({ where: { id: msg.customerId }, select: { emailOptOut: true, emailOptOutNote: true } });
        if (c && !c.emailOptOut) {
          await tx.customer.update({ where: { id: msg.customerId }, data: { emailOptOut: true, emailOptOutAt: now, emailOptOutSource: "complaint", emailOptOutNote: appendOptOutNote(c.emailOptOutNote, now, SOURCE_TEXT_AR.complaint) } });
        }
      }
      return "complained";
    }
    if (ev.kind === "bounced_soft" || ev.kind === "delayed") {
      await tx.emailMessage.updateMany({ where: { id: msg.id, status: "SENT" }, data: { statusNote: ev.kind === "delayed" ? "Delivery delayed: the receiving server asked to try later." : "Soft bounce: the receiving server could not take it now." } });
      return ev.kind;
    }
    return "ignored";
    });
  } catch (e) {
    if (e !== EARLY) throw e;
    // Tagged only (EARLY is thrown for tagged events alone): a bounce on a staff alert never suppresses through this channel.
    if (ev.tagged && (ev.kind === "bounced_hard" || ev.kind === "complained") && ev.to.length) {
      await prisma.emailSuppression.createMany({ data: ev.to.map((email) => ({ email, reason: ev.kind === "complained" ? "COMPLAINT" : "HARD_BOUNCE", providerEventId: h.id! })), skipDuplicates: true });
    }
    return NextResponse.json({ ok: false, outcome: "not_yet_known", retry: true }, { status: 409 });
  }
  return NextResponse.json({ ok: true, outcome });
}
