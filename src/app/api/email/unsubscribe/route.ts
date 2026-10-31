import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";
import { readUnsubscribeToken } from "@/lib/automation/email-links";
import { writeSettingsAudit } from "@/lib/services/settings/audit";
import { appendOptOutNote } from "@/lib/automation/email-consent";

export const dynamic = "force-dynamic";

/**
 * POST /api/email/unsubscribe?t=<signed token> — PUBLIC (no sign-in): the customer's own «إيقاف الإيميلات».
 * Called by the confirmation page (/email/unsubscribe) and by mail clients' one-click unsubscribe
 * (List-Unsubscribe-Post: List-Unsubscribe=One-Click, RFC 8058). The token is an HMAC over the customer's opaque link id: a
 * tampered or invented one is refused (400) and changes nothing. Idempotent. Answers no customer data at all.
 * There is no GET that unsubscribes: link scanners open links, they do not post.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  let t: unknown = url.searchParams.get("t");
  if (!t) {
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) t = ((await request.json().catch(() => ({}))) as { t?: unknown }).t;
  }
  // Fix round 2 (seat 6 N9): a valid link is limited per LINK, not per address — one-click unsubscribes from a mail provider
  // all arrive from its shared servers and must never be refused for each other. Only invalid links are limited per IP.
  const linkId = readUnsubscribeToken(t);
  const tooMany = NextResponse.json({ error: "طلبات كثيرة. حاول بعد دقائق.", errorEn: "Too many requests.", code: "RATE_LIMITED" }, { status: 429 });
  if (!linkId) {
    const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const { limited } = await checkAndRecordRateLimit({ scope: "email:unsubscribe:bad", key: ip, limit: 30, windowMs: 10 * 60 * 1000 });
    if (limited) return tooMany;
    return NextResponse.json({ error: "الرابط غير صالح.", errorEn: "This link is not valid.", code: "INVALID_LINK" }, { status: 400 });
  }
  const { limited } = await checkAndRecordRateLimit({ scope: "email:unsubscribe", key: linkId, limit: 10, windowMs: 10 * 60 * 1000 });
  if (limited) return tooMany;
  await prisma.$transaction(async (tx) => {
    const c = await tx.customer.findUnique({ where: { emailLinkId: linkId }, select: { id: true, emailOptOut: true, emailOptOutNote: true } });
    if (!c) return;
    const customerId = c.id;
    if (!c.emailOptOut) {
      const now = new Date();
      await tx.customer.update({ where: { id: customerId }, data: { emailOptOut: true, emailOptOutAt: now, emailOptOutSource: "customer_link", emailOptOutNote: appendOptOutNote(c.emailOptOutNote, now, "أوقفها العميل بنفسه من رابط الإيميل") } });
      await writeSettingsAudit(tx, {
        section: "organisation", action: "SETTINGS_UPDATED", entityType: "Customer", entityId: customerId, changed: ["emailOptOut"],
        before: { emailOptOut: false }, after: { emailOptOut: true, emailOptOutSource: "customer_link" }, reason: "EMAIL_UNSUBSCRIBE_LINK",
        actor: { id: "customer-link", name: "رابط الإيقاف في الإيميل" },
      });
    }
  });
  // A customer deleted since: the same answer (nothing to stop, nothing revealed).
  return NextResponse.json({ ok: true });
}
