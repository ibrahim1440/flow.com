import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";
import { readTestConfirmToken } from "@/lib/automation/email-links";
import { SETTINGS_ID } from "@/lib/automation/settings";
import { emailDomain } from "@/lib/automation/email-mode";
import { writeSettingsAudit } from "@/lib/services/settings/audit";

export const dynamic = "force-dynamic";

/**
 * POST /api/email/confirm { t } — PUBLIC: «وصلتني», from the test e-mail. The signed token names the test address and
 * when the test was sent (valid 7 days). Accepted only while that is still the saved test address: then
 * testEmailVerifiedAt = now — the proof LIVE needs (within 30 days). Audited (domain only). Changes nothing else.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { t?: unknown };
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const { limited } = await checkAndRecordRateLimit({ scope: "email:confirm", key: ip, limit: 20, windowMs: 10 * 60 * 1000 });
  if (limited) return NextResponse.json({ error: "طلبات كثيرة. حاول بعد دقائق.", errorEn: "Too many requests.", code: "RATE_LIMITED" }, { status: 429 });
  const tok = readTestConfirmToken(body.t);
  if (!tok) return NextResponse.json({ error: "الرابط غير صالح أو انتهى. أرسل رسالة تجربة جديدة.", errorEn: "This link is not valid or has expired.", code: "INVALID_LINK" }, { status: 400 });
  const ok = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AutomationSettings" WHERE "id" = ${SETTINGS_ID} FOR UPDATE`;
    const s = await tx.automationSettings.findUnique({ where: { id: SETTINGS_ID }, select: { testEmail: true } });
    if (!s?.testEmail || s.testEmail !== tok.email) return false;
    await tx.automationSettings.update({ where: { id: SETTINGS_ID }, data: { testEmailVerifiedAt: new Date() } });
    await writeSettingsAudit(tx, {
      section: "automation", action: "SETTINGS_UPDATED", entityType: "AutomationSettings", entityId: SETTINGS_ID, changed: ["testEmailVerifiedAt"],
      after: { testEmailDomain: emailDomain(s.testEmail), via: "confirm_link" }, reason: "EMAIL_TEST_CONFIRMED", actor: { id: "test-email-link", name: "رابط «وصلتني»" },
    });
    return true;
  });
  if (!ok) return NextResponse.json({ error: "إيميل التجربة تغيّر بعد هذه الرسالة. أرسل رسالة تجربة جديدة.", errorEn: "The test address changed since this e-mail.", code: "STALE_LINK" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
