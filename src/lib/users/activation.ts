import "server-only";

// «رابط تفعيل الحساب» (owner decision, 1 Nov 2026): instead of handing a temporary password over by hand, the system
// sends the person a one-time link by WhatsApp; they open it and choose their own password.
//
//   · The token is 32 random bytes; only its SHA-256 is stored (AccountActivation.tokenHash). The link is built once,
//     sent once, and written nowhere: the WhatsApp log row says «a link was sent», never the link.
//   · Valid 72 hours, single use; a new link for the same person revokes the previous one; redeeming ends every session.
//   · Owner decision: the account message goes to the EMPLOYEE'S OWN number even while WhatsApp is in TEST mode (TEST
//     protects customers from test messages; a person's own sign-in link is operational). Sending OFF or WhatsApp not
//     connected → not sent, and the administrator is told why (they can still issue a temporary password).
import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { appBaseUrl } from "@/lib/automation/email-links";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { readSettings } from "@/lib/automation/settings";
import { revokeSessions } from "@/lib/auth/session";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/password-policy";
import { sellerSnapshot } from "@/lib/services/invoicing/settings";
import { getConnectionState, sendText } from "@/lib/whatsapp/evolution";
import { activationMessage, activationLink, maskPhone, tokenHashOf, ACTIVATION_HOURS } from "./activation-math";

type Tx = Prisma.TransactionClient;
export type ActivationPurpose = "INVITE" | "RESET";
export type ActivationSend = { sent: boolean; phone: string | null; note: string | null; noteEn: string | null; expiresAt: string | null };

/** Issue a new link for this person (revoking any unused one). Returns the raw token — send it, never store it. */
export async function issueActivation(tx: Tx, employeeId: string, actorId: string, purpose: ActivationPurpose, now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ACTIVATION_HOURS * 3_600_000);
  await tx.accountActivation.updateMany({ where: { employeeId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
  const row = await tx.accountActivation.create({ data: { employeeId, tokenHash: tokenHashOf(token), purpose, createdById: actorId, expiresAt }, select: { id: true } });
  return { id: row.id, token, expiresAt };
}

/**
 * Issue a link and send it by WhatsApp to the person's own number. Never throws on a sending problem: the result says
 * whether it went and, if not, why. The link is in the request to the WhatsApp server only.
 */
export async function sendActivation(employeeId: string, actorId: string, purpose: ActivationPurpose): Promise<ActivationSend> {
  const no = (note: string, noteEn: string): ActivationSend => ({ sent: false, phone: null, note, noteEn, expiresAt: null });
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, name: true, username: true, phoneNumber: true, active: true } });
  if (!e || !e.active) return no("الحساب غير موجود أو موقوف.", "The account is missing or inactive.");
  if (!e.username) return no("لا اسم مستخدم لهذا الحساب.", "This account has no username.");
  const phone = normalizePhoneForWhatsApp(e.phoneNumber);
  if (!phone.ok) return no("لا رقم جوال صالح لهذا الموظف — أضف رقمه أو استخدم كلمة مرور مؤقتة.", `No usable mobile number (${phone.reason}).`);
  const base = appBaseUrl();
  if (!base) return no("عنوان النظام (APP_BASE_URL) غير مضبوط، فما يُبنى الرابط.", "APP_BASE_URL is not set.");
  const settings = await readSettings();
  if (settings.sendMode === "OFF") return no("إرسال الواتساب متوقف من إعدادات الإرسال.", "WhatsApp sending is off.");
  const state = await getConnectionState();
  if (!state.ok || state.state !== "open") return no("الواتساب غير متصل الآن.", state.ok ? `WhatsApp is not connected (${state.state}).` : state.error);

  const issued = await prisma.$transaction((tx) => issueActivation(tx, e.id, actorId, purpose));
  const company = String((await sellerSnapshot(prisma)).name || "حِقبة");
  const text = activationMessage({ name: e.name, username: e.username, company, link: activationLink(base, issued.token), purpose });
  const started = Date.now();
  const r = await sendText(phone.phone, text);
  // The log row (message log, archive): who, when, the outcome — never the link.
  await prisma.whatsAppMessage.create({
    data: {
      dedupeKey: `activation:${issued.id}`, ruleName: purpose === "INVITE" ? "رابط تفعيل حساب" : "رابط إعادة تعيين كلمة المرور",
      subjectType: "Employee", subjectId: e.id, recipientKind: "employee", recipientName: e.name, phone: phone.phone,
      body: `[${purpose === "INVITE" ? "رابط تفعيل الحساب" : "رابط إعادة تعيين كلمة المرور"} لـ ${e.username} — الرابط لا يُحفظ في السجل]`,
      status: r.ok ? "SENT" : "FAILED", statusNote: r.ok ? null : r.error, attempts: 1, sentAt: r.ok ? new Date() : null,
      providerMessageId: r.ok ? r.messageId : null, createdById: actorId,
      sendAttempts: { create: { attemptNo: 1, ok: r.ok, httpStatus: r.ok ? 200 : r.status, error: r.ok ? null : r.error, durationMs: Date.now() - started } },
    },
  });
  if (!r.ok) {
    await prisma.accountActivation.update({ where: { id: issued.id }, data: { revokedAt: new Date() } });
    return no("ما قدر الواتساب يوصل الرسالة — جرّب بعد شوي أو استخدم كلمة مرور مؤقتة.", r.error);
  }
  await prisma.hrAuditLog.create({ data: { action: purpose === "INVITE" ? "ACTIVATION_LINK_SENT" : "RESET_LINK_SENT", entityType: "Employee", entityId: e.id, after: { phone: maskPhone(phone.phone), expiresAt: issued.expiresAt.toISOString() }, actorId } });
  return { sent: true, phone: maskPhone(phone.phone), note: null, noteEn: null, expiresAt: issued.expiresAt.toISOString() };
}

type Valid = { id: string; employeeId: string; name: string; username: string; expiresAt: Date };

async function findValid(db: Tx | typeof prisma, token: unknown, now: Date): Promise<Valid | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const a = await db.accountActivation.findUnique({ where: { tokenHash: tokenHashOf(token) }, select: { id: true, employeeId: true, expiresAt: true, usedAt: true, revokedAt: true, employee: { select: { name: true, username: true, active: true } } } });
  if (!a || a.usedAt || a.revokedAt || a.expiresAt <= now || !a.employee.active || !a.employee.username) return null;
  return { id: a.id, employeeId: a.employeeId, name: a.employee.name, username: a.employee.username, expiresAt: a.expiresAt };
}

/** What the activation page shows before the password is chosen (name and username only). */
export async function peekActivation(token: unknown, now = new Date()) {
  const v = await findValid(prisma, token, now);
  return v ? { name: v.name, username: v.username, expiresAt: v.expiresAt.toISOString() } : null;
}

export class ActivationError extends Error {
  constructor(public status: number, public code: string, public ar: string, public en: string) { super(en); }
}

/** Redeem: the person's own password, the link used, every session ended. */
export async function redeemActivation(token: unknown, password: unknown, now = new Date()) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX || !password.trim()) {
    throw new ActivationError(400, "PASSWORD_POLICY", `كلمة المرور من ${PASSWORD_MIN} إلى ${PASSWORD_MAX} حرفًا.`, `The password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`);
  }
  const passwordHash = await hash(password, 10);
  return prisma.$transaction(async (tx) => {
    const v = await findValid(tx, token, now);
    if (!v) throw new ActivationError(410, "LINK_INVALID", "الرابط غير صالح أو انتهت صلاحيته أو استُخدم من قبل. اطلب من المدير رابطًا جديدًا.", "The link is invalid, expired or already used.");
    if (password.trim().toLowerCase() === v.username.toLowerCase()) throw new ActivationError(400, "PASSWORD_POLICY", "لا تستخدم اسم المستخدم كلمةَ مرور.", "Do not use your username as the password.");
    // Single use, decided by the row lock of this update.
    const used = await tx.accountActivation.updateMany({ where: { id: v.id, usedAt: null, revokedAt: null }, data: { usedAt: now } });
    if (used.count !== 1) throw new ActivationError(410, "LINK_INVALID", "الرابط استُخدم من قبل.", "The link was already used.");
    await tx.employee.update({ where: { id: v.employeeId }, data: { password: passwordHash, passwordMustChange: false, passwordTempExpiresAt: null } });
    await revokeSessions(tx, v.employeeId, "PASSWORD_SET_BY_LINK");
    await tx.hrAuditLog.create({ data: { action: "PASSWORD_SET_BY_LINK", entityType: "Employee", entityId: v.employeeId, after: { activationId: v.id }, actorId: v.employeeId } });
    return { username: v.username };
  });
}
