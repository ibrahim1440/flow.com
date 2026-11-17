// R1-e (owner-approved design «R1-e · معالجة رسائل التسويق», 17 Nov 2026): «تسجيل نتيجة التحقق» and «إعادة الإرسال بعد
// المراجعة» for the automation log — WhatsApp and e-mail — with the same rules as a campaign message
// (marketing/server/messaging.ts reviewMessage / resendAfterReview), WITHOUT the 24-hour window (that one is marketing's
// only: a late campaign message is not sent; an automation message keeps its purpose — owner decision 4).
//   · the review never touches `status` / `statusNote` (the provider's); it is recorded only on a FAILED message whose send
//     was interrupted (deliveryDoubt). «وصلت» and «لم تصل» are final; «تعذّر التأكد» may be reviewed again;
//   · a resend is a NEW row linked to the original (resendOfMessageId, UNIQUE), only after «لم تصل» — with its note — and
//     confirm: true. «تعذّر التأكد» never allows one. Someone else's earlier resend answers 409 ALREADY_RESENT;
//   · an account-activation link is never resent (409 ACTIVATION_RESEND: a new link is issued from user management —
//     the old one was revoked);
//   · every other type only inside its hard window and while what it says is still true (resend-rules.ts — owner
//     decision 17 Nov 06:10), proven at execution in this locked transaction; else 409 with the reason and a pointer;
//   · the database holds the same rules (20261231200000_message_review: message_review_guard).
// WHO may do it is message-access.ts (gateMessage) — checked by the route before these run.
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/hr/core";
import { automationResendVerdict } from "./resend-rules";

type Tx = Prisma.TransactionClient;
export type Channel = "whatsapp" | "email";
export type Actor = { id: string; name: string };

export const REVIEW_OUTCOMES = ["DELIVERED", "NOT_DELIVERED", "UNCERTAIN"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

const refuse = (status: number, code: string, message: string, errorEn: string, extra: Record<string, unknown> = {}) => ({ _appCode: status, code, message, errorEn, ...extra });

function input(body: Record<string, unknown>): { outcome: ReviewOutcome; note: string } {
  const outcome = body.outcome;
  if (typeof outcome !== "string" || !(REVIEW_OUTCOMES as readonly string[]).includes(outcome)) {
    throw refuse(400, "REVIEW_OUTCOME", "اختر نتيجة التحقق: وصلت، لم تصل، أو تعذّر التأكد.", "Choose the review outcome: delivered, not delivered, or could not confirm.");
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) throw refuse(400, "REVIEW_NOTE", "اكتب ملاحظة التحقق: كيف تأكدت؟", "Write the review note: how did you check?");
  if (note.length > 1000) throw refuse(400, "REVIEW_NOTE", "ملاحظة التحقق أطول من 1000 حرف.", "The review note is longer than 1000 characters.");
  return { outcome: outcome as ReviewOutcome, note };
}

const isActivation = (m: { dedupeKey: string; subjectType: string | null }) => m.dedupeKey.startsWith("activation:") || m.subjectType === "Employee";

async function lock(tx: Tx, channel: Channel, id: string) {
  const rows = channel === "email"
    ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "EmailMessage" WHERE id = ${id} FOR UPDATE`
    : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "WhatsAppMessage" WHERE id = ${id} FOR UPDATE`;
  if (!rows[0]) throw refuse(404, "NOT_FOUND", "الرسالة غير موجودة.", "Message not found.");
}

const SELECT = { id: true, status: true, deliveryDoubt: true, reviewOutcome: true, reviewNote: true, dedupeKey: true, subjectType: true, resend: { select: { id: true } } } as const;

/** «تسجيل نتيجة التحقق» — the review only; the status stays the provider's. */
export async function reviewAutomationMessage(tx: Tx, channel: Channel, id: string, body: Record<string, unknown>, actor: Actor) {
  const { outcome, note } = input(body);
  await lock(tx, channel, id);
  const m = channel === "email"
    ? await tx.emailMessage.findUniqueOrThrow({ where: { id }, select: SELECT })
    : await tx.whatsAppMessage.findUniqueOrThrow({ where: { id }, select: SELECT });
  if (m.status !== "FAILED" || !m.deliveryDoubt) throw refuse(409, "NOT_IN_DOUBT", "نتيجة التحقق تُسجَّل لرسالة انقطع إرسالها فقط.", "A review is recorded only for a message whose send was interrupted.");
  if (m.resend) throw refuse(409, "REVIEW_FROZEN", "أُعيد إرسال هذه الرسالة؛ نتيجة مراجعتها لا تتغيّر.", "This message was resent; its review cannot change.");
  if (m.reviewOutcome === "DELIVERED" || m.reviewOutcome === "NOT_DELIVERED") {
    throw refuse(409, "ALREADY_REVIEWED", "سُجّلت نتيجة التحقق لهذه الرسالة من قبل. حدّث الصفحة.", "A review was already recorded for this message. Reload.");
  }
  const data = { reviewOutcome: outcome, reviewNote: note, reviewedById: actor.id, reviewedAt: new Date() };
  const sel = { id: true, status: true, reviewOutcome: true, reviewNote: true, reviewedById: true, reviewedAt: true } as const;
  const row = channel === "email"
    ? await tx.emailMessage.update({ where: { id }, data, select: sel })
    : await tx.whatsAppMessage.update({ where: { id }, data, select: sel });
  await audit(tx, { action: "message.review_recorded", entityType: channel === "email" ? "EmailMessage" : "WhatsAppMessage", entityId: id, before: { reviewOutcome: m.reviewOutcome }, after: { reviewOutcome: outcome, reviewNote: note }, reason: note, actorId: actor.id });
  return row;
}

/** «إعادة الإرسال بعد المراجعة» — a NEW message linked to the original; the senders re-check consent and the send mode. */
export async function resendAutomationMessage(tx: Tx, channel: Channel, id: string, body: Record<string, unknown>, actor: Actor, now = new Date()) {
  if (body.confirm !== true) throw refuse(400, "RESEND_CONFIRM", "أكّد إعادة الإرسال أولاً.", "Confirm the resend first.");
  await lock(tx, channel, id);
  if (channel === "email") {
    const o = await tx.emailMessage.findUniqueOrThrow({ where: { id }, include: { resend: { select: { id: true } } } });
    precheck(o);
    await verdictCheck(tx, "email", o, now);
    const r = await tx.emailMessage.create({
      data: {
        channel: o.channel, dedupeKey: `${o.dedupeKey}:resend`, ruleId: o.ruleId, ruleName: o.ruleName, eventId: o.eventId, eventType: o.eventType,
        subjectType: o.subjectType, subjectId: o.subjectId, stepIndex: o.stepIndex, recipientKind: o.recipientKind, recipientName: o.recipientName,
        customerId: o.customerId, toEmail: o.toEmail, intendedEmail: o.intendedEmail, planMode: o.planMode, subject: o.subject, bodyText: o.bodyText,
        attachmentKind: o.attachmentKind, attachmentRefId: o.attachmentRefId, status: "QUEUED", scheduledAt: now,
        statusNote: `Resent after review by ${actor.name}.`, createdById: actor.id, resendOfMessageId: o.id,
      },
      select: { id: true, status: true, resendOfMessageId: true },
    });
    await audit(tx, { action: "message.resent", entityType: "EmailMessage", entityId: o.id, after: { originalId: o.id, newMessageId: r.id }, actorId: actor.id });
    return r;
  }
  const o = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id }, include: { resend: { select: { id: true } } } });
  precheck(o);
  if (!o.phone) throw refuse(409, "NO_PHONE", "ما لهذه الرسالة رقم ترسل له.", "This message has no phone number to send to.");
  await verdictCheck(tx, "whatsapp", o, now);
  const r = await tx.whatsAppMessage.create({
    data: {
      channel: o.channel, dedupeKey: `${o.dedupeKey}:resend`, ruleId: o.ruleId, ruleName: o.ruleName, eventId: o.eventId, eventType: o.eventType,
      subjectType: o.subjectType, subjectId: o.subjectId, stepIndex: o.stepIndex, recipientKind: o.recipientKind, recipientName: o.recipientName,
      phone: o.phone, intendedPhone: o.intendedPhone, body: o.body, attachmentKind: o.attachmentKind, attachmentRefId: o.attachmentRefId,
      status: "QUEUED", scheduledAt: now, statusNote: `Resent after review by ${actor.name}.`, createdById: actor.id, resendOfMessageId: o.id,
    },
    select: { id: true, status: true, resendOfMessageId: true },
  });
  await audit(tx, { action: "message.resent", entityType: "WhatsAppMessage", entityId: o.id, after: { originalId: o.id, newMessageId: r.id }, actorId: actor.id });
  return r;
}

type Original = { id: string; status: string; deliveryDoubt: boolean; reviewOutcome: string | null; dedupeKey: string; subjectType: string | null; subjectId: string | null; bodyArchivedAt: Date | null; attachmentKind: string | null; attachmentRefId: string | null; resend: { id: string } | null };

function precheck(o: Original) {
  if (isActivation(o)) {
    throw refuse(409, "ACTIVATION_RESEND",
      "رابط التفعيل لا يُعاد من السجل — الرابط القديم أُلغي. أصدر رابطًا جديدًا من صفحة الموظف (إدارة المستخدمين).",
      "An activation link is not resent from the log — the old link was revoked. Issue a new link from the employee's page (user management).",
      { href: o.subjectId ? `/dashboard/employees/${o.subjectId}` : "/dashboard/employees" });
  }
  if (o.resend) throw refuse(409, "ALREADY_RESENT", "أُعيد إرسال هذه الرسالة من قبل — غالبًا من زميل. حدّث الصفحة.", "This message was already resent — probably by a colleague. Reload.");
  if (o.status !== "FAILED" || !o.deliveryDoubt || o.reviewOutcome !== "NOT_DELIVERED") {
    throw refuse(409, "RESEND_NOT_ALLOWED", "لا تُعاد الرسالة إلا بعد تسجيل نتيجة التحقق «لم تصل».", "A message is resent only after a «not delivered» review.");
  }
  if (o.bodyArchivedAt) throw refuse(409, "ARCHIVED", "نص هذه الرسالة انتقل للأرشيف (أقدم من 180 يوم)، فما تنعاد.", "The text of this message was moved to the archive (older than 180 days); it cannot be sent again.");
}

/** The type's window and the content still true (resend-rules.ts) — refused with the reason and the original path. */
async function verdictCheck(tx: Tx, channel: Channel, o: Original & { eventId: string | null; eventType: string | null; recipientKind: string; sendingStartedAt: Date | null; createdAt: Date }, now: Date) {
  const v = await automationResendVerdict(tx, { ...o, channel }, now);
  if (!v.ok) throw refuse(409, v.code, v.ar, v.en, { href: v.href });
}
