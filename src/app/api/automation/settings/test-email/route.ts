import { AUTOMATION_TAG } from "@/lib/notify/resend-webhook";
import { randomUUID } from "node:crypto";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";
import { SETTINGS_ID } from "@/lib/automation/settings";
import { cleanSubject, emailDomain, finalEmailGuard } from "@/lib/automation/email-mode";
import { appBaseUrl, testConfirmToken } from "@/lib/automation/email-links";
import { renderTextEmail, wrapHtml, wrapText } from "@/lib/automation/email-render";
import { loggableText } from "@/lib/automation/email-dispatch";
import { deliverEmail } from "@/lib/notify/email";
import { companyInfoFrom } from "@/lib/notify/templates/demo";
import { DEMO_SUBJECT_PREFIX } from "@/lib/notify/templates/shell";
import { sellerSnapshot } from "@/lib/services/invoicing/settings";
import { writeSettingsAudit } from "@/lib/services/settings/audit";

export const dynamic = "force-dynamic";

/**
 * POST — «أرسل لي إيميل تجربة» (batch 25): one e-mail, now, to the saved TEST ADDRESS only (whatever the e-mail mode;
 * the address is never taken from the request). It carries a signed «وصلتني» link: opening it (POST
 * /api/email/confirm) records that the test address really receives our e-mail — LIVE needs that within 30 days.
 * The Resend «delivered» webhook for this message records it too. automation › manage_connection; 5 per hour per user;
 * logged in the message log («رسالة تجربة») and audited (the address's domain only).
 */
export async function POST() {
  const { user, error } = await requireSub("automation", "manage_connection");
  if (error) return error;
  const s = await prisma.automationSettings.findUnique({ where: { id: SETTINGS_ID }, select: { testEmail: true } });
  const to = s?.testEmail ?? null;
  if (!to) return NextResponse.json({ error: "احفظ إيميل التجربة أول.", errorEn: "Save a test e-mail address first.", code: "TEST_EMAIL_REQUIRED" }, { status: 400 });
  const { limited } = await checkAndRecordRateLimit({ scope: "automation:email-test", key: user.id, limit: 5, windowMs: 60 * 60 * 1000 });
  if (limited) return NextResponse.json({ error: "وصلت الحد: 5 رسائل تجربة في الساعة.", errorEn: "Limit reached: 5 test e-mails an hour.", code: "RATE_LIMITED" }, { status: 429 });

  const sentAt = new Date();
  const base = appBaseUrl();
  const confirmUrl = base ? `${base}/email/confirm?t=${testConfirmToken(to, sentAt)}` : null;
  const company = companyInfoFrom(await sellerSnapshot(prisma));
  const intro = [
    "هذي رسالة تجربة من «رسائل العملاء التلقائية».",
    "إذا وصلتك، اضغط زر «وصلتني» اللي تحت العنوان مباشرة. هذا يثبت إن إيميل التجربة يستقبل رسائلنا.",
  ];
  // Fix round 2 (council b25 seat 5): the HTML shows the button only — the long signed link appears in the plain-text part
  // alone (a mail client without HTML needs it).
  const text = [...intro, confirmUrl ? `أو افتح هذا الرابط: ${confirmUrl}` : "الزر غير متاح: عنوان النظام غير مضبوط على الخادم. كلّم الدعم الفني."].join("\n");
  const htmlText = [...intro, ...(confirmUrl ? [] : ["الزر غير متاح: عنوان النظام غير مضبوط على الخادم. كلّم الدعم الفني."])].join("\n");
  const r = renderTextEmail({ subject: "رسالة تجربة — رسائل العملاء التلقائية", bodyText: text, company });
  const rHtml = renderTextEmail({ subject: "رسالة تجربة — رسائل العملاء التلقائية", bodyText: htmlText, company });
  const subject = cleanSubject(`${DEMO_SUBJECT_PREFIX} ${r.subject}`);
  const button = confirmUrl ? `<p style="margin:12px 0 0;text-align:center"><a href="${confirmUrl.replace(/"/g, "&quot;")}" style="display:inline-block;padding:10px 22px;border-radius:10px;background:#5c5c38;color:#ffffff;font-weight:700;text-decoration:none">وصلتني</a></p>` : "";
  // No unsubscribe footer and no «ردّ بكلمة إيقاف»: this goes to our own test address only.
  const html = wrapHtml(rHtml.html.replace(/(<\/h1>)/, `$1${button}`), { test: null, unsubscribeUrl: null });
  const message = { to: [to], subject, html, text: wrapText(r.text, { test: null, unsubscribeUrl: null }), idempotencyKey: `test-${randomUUID()}`, tags: [{ ...AUTOMATION_TAG }] };
  const refused = finalEmailGuard({ mode: "TEST", testEmail: to }, message);
  if (refused) return NextResponse.json({ error: "رُفض الإرسال.", errorEn: refused, code: "REFUSED" }, { status: 409 });

  const result = await deliverEmail(message);
  const ok = result.status === "SENT";
  await prisma.emailMessage.create({
    data: {
      dedupeKey: `email:test:${randomUUID()}`, recipientKind: "test", recipientName: user.name, toEmail: to, planMode: "TEST", subject, bodyText: loggableText(message.text),
      status: ok ? "SENT" : "FAILED", statusNote: ok ? "Test message." : result.error, sentAt: ok ? sentAt : null, attempts: 1,
      providerMessageId: result.providerMessageId, httpStatus: result.httpStatus, createdById: user.id,
    },
  });
  await writeSettingsAudit(prisma, {
    section: "automation", action: "SETTINGS_UPDATED", entityType: "EmailChannelTest", entityId: SETTINGS_ID, changed: [],
    after: { recipientDomain: emailDomain(to), status: result.status }, reason: "EMAIL_CHANNEL_TEST_SENT", actor: { id: user.id, name: user.name },
  });
  if (result.status === "NOT_CONFIGURED") return NextResponse.json({ error: "الإيميل غير مربوط على هذا الخادم. كلّم الدعم الفني.", errorEn: "No e-mail provider is configured.", code: "NOT_CONFIGURED" }, { status: 503 });
  if (!ok) return NextResponse.json({ error: "ما انرسلت رسالة التجربة. حاول بعد شوي.", errorEn: "The test e-mail was not sent.", code: "SEND_FAILED" }, { status: 502 });
  return NextResponse.json({ ok: true, sentAt, recipientDomain: emailDomain(to) });
}
