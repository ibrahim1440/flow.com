import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAdminAction, requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { effectiveMode, liveAllowed, SETTINGS_ID, type SendMode } from "@/lib/automation/settings";
import { effectiveEmailMode, emailLiveAllowed, emailModeRefusal, parseEmailAddress, testEmailFresh, baseUrlIsProduction, linkSecretConfigured } from "@/lib/automation/email-mode";
import { emailProviderStatus } from "@/lib/notify/email";
import { appBaseUrl } from "@/lib/automation/email-links";
import { writeSettingsAudit } from "@/lib/services/settings/audit";

const MODES: SendMode[] = ["OFF", "TEST", "LIVE"];
type Channel = "whatsapp" | "email";


/**
 * «رسائل العملاء التلقائية › الإعدادات» — both channels on one card (batch 25).
 *
 * GET: the automation module. Each channel's stored mode, what this deployment actually does, its test target and
 * the last test message that went out / arrived.
 */
export async function GET() {
  const { user, error } = await requireModule("automation");
  if (error) return error;
  const [s, waTest, emailTest] = await Promise.all([
    prisma.automationSettings.findUnique({ where: { id: SETTINGS_ID } }),
    prisma.whatsAppMessage.findFirst({ where: { recipientKind: "test", status: "SENT" }, orderBy: { sentAt: "desc" }, select: { sentAt: true } }),
    prisma.emailMessage.findFirst({ where: { recipientKind: "test", status: { in: ["SENT", "DELIVERED"] } }, orderBy: { sentAt: "desc" }, select: { sentAt: true, deliveredAt: true, status: true } }),
  ]);
  const wa = effectiveMode({ sendMode: (s?.sendMode ?? "OFF") as SendMode, testPhone: s?.testPhone ?? null });
  const emailSettings = { emailSendMode: (s?.emailSendMode ?? "OFF") as SendMode, testEmail: s?.testEmail ?? null, testEmailVerifiedAt: s?.testEmailVerifiedAt ?? null };
  const em = effectiveEmailMode(emailSettings);
  const provider = emailProviderStatus();
  return NextResponse.json({
    whatsapp: {
      sendMode: s?.sendMode ?? "OFF", testPhone: s?.testPhone ?? null, liveAllowed: liveAllowed(),
      effectiveMode: wa.mode, effectiveNote: wa.mode === "OFF" ? wa.note : null, lastTestSentAt: waTest?.sentAt ?? null,
    },
    email: {
      sendMode: emailSettings.emailSendMode, testEmail: emailSettings.testEmail, testEmailVerifiedAt: emailSettings.testEmailVerifiedAt,
      verifiedFresh: testEmailFresh(emailSettings.testEmailVerifiedAt), liveAllowed: emailLiveAllowed(),
      effectiveMode: em.mode, effectiveNote: em.mode === "OFF" ? em.note : null,
      providerConfigured: !!provider.provider, lastTestSentAt: emailTest?.sentAt ?? null,
      // Fix round 1: what is missing on this server, in plain words on the card (never a secret, only whether it is set).
      webhookConfigured: !!process.env.RESEND_WEBHOOK_SECRET?.trim(), baseUrlConfigured: !!appBaseUrl(),
      // Batch 25b: LIVE also needs the link key and the production domain — only whether each holds, never a value.
      linkSecretConfigured: linkSecretConfigured(), baseUrlProduction: baseUrlIsProduction(),
      replyToEmail: s?.replyToEmail ?? null,
    },
    can: { manage: hasSubPrivilege(user.permissions, "automation", "manage_connection"), live: user.role === "admin" },
  });
}

/**
 * PUT { channel?: "whatsapp" | "email" (default whatsapp), sendMode: "OFF" | "TEST" | "LIVE", testPhone? | testEmail? }
 *
 *   - automation › manage_connection for any change;
 *   - switching a channel to LIVE (or saving it while LIVE): the admin role AND a recent step-up (401 REAUTH_REQUIRED →
 *     the dashboard's step-up dialog retries), then this deployment's gate — WhatsApp: WHATSAPP_LIVE_ENABLED; e-mail:
 *     EMAIL_LIVE_ENABLED on a production deployment AND a test e-mail that arrived in the last 30 days;
 *   - TEST → OFF (or any change that does not end in LIVE) needs no step-up;
 *   - changing a TEST TARGET (the test number or the test address) — where every customer's message goes in TEST — and
 *     the company «بريد الردود»: the admin role AND a recent step-up (fix round 1);
 *   - every mode change, and every change of a test target or the reply address, writes one SettingsAuditLog row
 *     (section «automation»: from → to in full, who, when — these are staff addresses, kept whole for any inquiry).
 */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("automation", "manage_connection");
  if (error) return error;

  let body: { channel?: unknown; sendMode?: unknown; testPhone?: unknown; testEmail?: unknown; replyToEmail?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  }
  const channel: Channel | null = body.channel === undefined || body.channel === "whatsapp" ? "whatsapp" : body.channel === "email" ? "email" : null;
  if (!channel) return NextResponse.json({ error: "القناة إما واتساب أو إيميل.", errorEn: "channel must be whatsapp or email.", code: "INVALID_CHANNEL" }, { status: 400 });
  // «بريد الردود» alone (no mode): admin + step-up, audited.
  if (channel === "email" && body.sendMode === undefined && body.replyToEmail !== undefined) {
    const refused = await requireAdminAction(user, "automation.email_reply_to", { stepUp: true, message: "بريد الردود يضبطه المدير فقط." });
    if (refused) return refused;
    const next = body.replyToEmail === null || (typeof body.replyToEmail === "string" && !body.replyToEmail.trim()) ? null : parseEmailAddress(body.replyToEmail);
    if (body.replyToEmail && !next) return NextResponse.json({ error: "اكتب إيميل ردود واحد صحيح.", errorEn: "Enter one valid reply address.", code: "INVALID_REPLY_TO", field: "replyToEmail" }, { status: 400 });
    try {
      const saved = await prisma.$transaction(async (tx) => {
        await tx.automationSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID }, update: {} });
        await tx.$queryRaw`SELECT "id" FROM "AutomationSettings" WHERE "id" = ${SETTINGS_ID} FOR UPDATE`;
        const before = (await tx.automationSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID }, select: { replyToEmail: true } })).replyToEmail;
        const row = await tx.automationSettings.update({ where: { id: SETTINGS_ID }, data: { replyToEmail: next, emailUpdatedById: user.id, emailUpdatedAt: new Date() } });
        if (before !== next) {
          await writeSettingsAudit(tx, {
            section: "automation", action: "SETTINGS_UPDATED", entityType: "AutomationSettings", entityId: SETTINGS_ID, changed: ["replyToEmail"],
            before: { replyToEmail: before }, after: { replyToEmail: next }, reason: "EMAIL_REPLY_TO", actor: { id: user.id, name: user.name },
          });
        }
        return row;
      }, TX_OPTS);
      return NextResponse.json({ channel, replyToEmail: saved.replyToEmail });
    } catch (err) {
      return handleDomainError(err);
    }
  }
  const sendMode = body.sendMode as SendMode;
  if (!MODES.includes(sendMode)) return NextResponse.json({ error: "اختر وضع الإرسال.", errorEn: "sendMode must be OFF, TEST or LIVE.", code: "INVALID_MODE" }, { status: 400 });

  // LIVE is the one-way door: admin role + step-up before anything else is looked at.
  if (sendMode === "LIVE") {
    const refused = await requireAdminAction(user, `automation.${channel}_live`, { stepUp: true, message: "التشغيل الفعلي للمدير فقط." });
    if (refused) return refused;
  }

  try {
    if (channel === "whatsapp") {
      let testPhone: string | null = null;
      if (typeof body.testPhone === "string" && body.testPhone.trim()) {
        const p = normalizePhoneForWhatsApp(body.testPhone);
        if (!p.ok) return NextResponse.json({ error: `رقم التجربة: ${p.reason}`, errorEn: `Test number: ${p.reason}`, code: "INVALID_TEST_PHONE" }, { status: 400 });
        testPhone = p.phone;
      }
      if (sendMode === "TEST" && !testPhone) return NextResponse.json({ error: "وضع التجربة يحتاج رقم تجربة.", errorEn: "Test mode needs a test number.", code: "TEST_PHONE_REQUIRED" }, { status: 400 });
      // A new test number = where every customer's message goes in TEST: the admin, after a step-up.
      const current = (await prisma.automationSettings.findUnique({ where: { id: SETTINGS_ID }, select: { testPhone: true } }))?.testPhone ?? null;
      if (testPhone !== current && testPhone !== null) {
        const refused = await requireAdminAction(user, "automation.test_target", { stepUp: true, message: "تغيير رقم التجربة للمدير فقط." });
        if (refused) return refused;
      }
      if (sendMode === "LIVE" && !liveAllowed()) {
        return NextResponse.json({ error: "الإرسال الفعلي للواتساب مقفل على هذا الخادم.", errorEn: "Live sending is not enabled on this deployment. Set WHATSAPP_LIVE_ENABLED=true on the server first.", code: "WHATSAPP_LIVE_DISABLED" }, { status: 409 });
      }
      const row = await prisma.$transaction(async (tx) => {
        await tx.automationSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID }, update: {} });
        await tx.$queryRaw`SELECT "id" FROM "AutomationSettings" WHERE "id" = ${SETTINGS_ID} FOR UPDATE`;
        const before = await tx.automationSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID }, select: { sendMode: true, testPhone: true } });
        const saved = await tx.automationSettings.update({ where: { id: SETTINGS_ID }, data: { sendMode, testPhone, updatedById: user.id } });
        const changed = [...(before.sendMode !== sendMode ? ["sendMode"] : []), ...(before.testPhone !== testPhone ? ["testPhone"] : [])];
        if (changed.length) {
          await writeSettingsAudit(tx, {
            section: "automation", action: "SETTINGS_UPDATED", entityType: "AutomationSettings", entityId: SETTINGS_ID, changed,
            before: { channel: "whatsapp", sendMode: before.sendMode, testPhone: before.testPhone },
            after: { channel: "whatsapp", sendMode, testPhone },
            reason: before.sendMode !== sendMode ? `WHATSAPP_MODE ${before.sendMode} → ${sendMode}` : "WHATSAPP_TEST_TARGET",
            actor: { id: user.id, name: user.name },
          });
        }
        return saved;
      }, TX_OPTS);
      return NextResponse.json({ channel, sendMode: row.sendMode, testPhone: row.testPhone });
    }

    // ── e-mail ──
    let testEmail: string | null | undefined;
    if (body.testEmail !== undefined) {
      if (body.testEmail === null || (typeof body.testEmail === "string" && !body.testEmail.trim())) testEmail = null;
      else {
        testEmail = parseEmailAddress(body.testEmail);
        if (!testEmail) return NextResponse.json({ error: "اكتب إيميل تجربة واحد صحيح.", errorEn: "Enter one valid test e-mail address.", code: "INVALID_TEST_EMAIL", field: "testEmail" }, { status: 400 });
      }
    }
    if (testEmail) {
      const current = (await prisma.automationSettings.findUnique({ where: { id: SETTINGS_ID }, select: { testEmail: true } }))?.testEmail ?? null;
      if (testEmail !== current) {
        const refused = await requireAdminAction(user, "automation.test_target", { stepUp: true, message: "تغيير إيميل التجربة للمدير فقط." });
        if (refused) return refused;
      }
    }
    const row = await prisma.$transaction(async (tx) => {
      await tx.automationSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID }, update: {} });
      await tx.$queryRaw`SELECT "id" FROM "AutomationSettings" WHERE "id" = ${SETTINGS_ID} FOR UPDATE`;
      const before = await tx.automationSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID }, select: { emailSendMode: true, testEmail: true, testEmailVerifiedAt: true } });
      const nextEmail = testEmail === undefined ? before.testEmail : testEmail;
      // A new test address has not received anything yet: the proof belongs to the old one.
      const verifiedAt = nextEmail === before.testEmail ? before.testEmailVerifiedAt : null;
      const refusal = emailModeRefusal(sendMode, { testEmail: nextEmail, testEmailVerifiedAt: verifiedAt });
      if (refusal) throw { _appCode: refusal.status, message: refusal.error, errorEn: refusal.errorEn, code: refusal.code };
      const saved = await tx.automationSettings.update({
        where: { id: SETTINGS_ID },
        data: { emailSendMode: sendMode, testEmail: nextEmail, testEmailVerifiedAt: verifiedAt, emailUpdatedById: user.id, emailUpdatedAt: new Date() },
      });
      const changed = [...(before.emailSendMode !== sendMode ? ["emailSendMode"] : []), ...(before.testEmail !== nextEmail ? ["testEmail"] : [])];
      if (changed.length) {
        await writeSettingsAudit(tx, {
          section: "automation", action: "SETTINGS_UPDATED", entityType: "AutomationSettings", entityId: SETTINGS_ID, changed,
          before: { channel: "email", emailSendMode: before.emailSendMode, testEmail: before.testEmail },
          after: { channel: "email", emailSendMode: sendMode, testEmail: nextEmail },
          reason: before.emailSendMode !== sendMode ? `EMAIL_MODE ${before.emailSendMode} → ${sendMode}` : "EMAIL_TEST_TARGET",
          actor: { id: user.id, name: user.name },
        });
      }
      return saved;
    }, TX_OPTS);
    return NextResponse.json({ channel, sendMode: row.emailSendMode, testEmail: row.testEmail, testEmailVerifiedAt: row.testEmailVerifiedAt });
  } catch (err) {
    return handleDomainError(err);
  }
}
